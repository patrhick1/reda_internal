BEGIN;

-- Search representation only. Original contact values and the existing
-- identity/payment/grouping normalizers remain unchanged.
CREATE FUNCTION public._delivery_phone_search_key(p_phone text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path=pg_catalog,public AS $$
 SELECT public._norm_phone(CASE WHEN digits LIKE '00234%' THEN substring(digits FROM 3) ELSE digits END)
 FROM (SELECT regexp_replace(p_phone,'[^0-9]','','g') AS digits) raw
$$;
CREATE FUNCTION public._delivery_phone_search_patterns(p_search text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path=pg_catalog,public AS $$
 SELECT coalesce(array_agg(DISTINCT '%'||term||'%'),'{}'::text[])
 FROM (SELECT regexp_replace(coalesce(p_search,''),'[^0-9]','','g') AS digits) raw,
 LATERAL unnest(ARRAY[public._delivery_phone_search_key(digits),digits]) term
 WHERE length(term)>=3
$$;
REVOKE ALL ON FUNCTION public._delivery_phone_search_key(text),public._delivery_phone_search_patterns(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public._delivery_phone_search_key(text),public._delivery_phone_search_patterns(text) TO authenticated,service_role;

-- Expression indexes cover existing formatted numbers without rewriting orders
-- or requiring per-row normalization on every search. Only active rows appear
-- in the role-scoped views. Locate the installed pg_trgm operator-class schema.
DO $$ DECLARE op_schema text; BEGIN
 SELECT n.nspname INTO STRICT op_schema FROM pg_opclass c JOIN pg_namespace n ON n.oid=c.opcnamespace
 JOIN pg_am a ON a.oid=c.opcmethod WHERE c.opcname='gin_trgm_ops' AND a.amname='gin';
 EXECUTE format('CREATE INDEX deliveries_phone_search_trgm ON public.deliveries USING gin (public._delivery_phone_search_key(customer_phone) %I.gin_trgm_ops) WHERE deleted_at IS NULL',op_schema);
 EXECUTE format('CREATE INDEX deliveries_phone_alt_search_trgm ON public.deliveries USING gin (public._delivery_phone_search_key(customer_phone_alt) %I.gin_trgm_ops) WHERE deleted_at IS NULL',op_schema);
END $$;

-- Preserve each installed projection, money visibility, role gates, grants and
-- view options. Append filterable expressions; the planner can push them down
-- to the indexes above. Existing clients can keep using the original columns.
DO $$ DECLARE v text; def text; BEGIN
 FOREACH v IN ARRAY ARRAY['deliveries_admin','deliveries_safe'] LOOP
  def:=rtrim(pg_get_viewdef(('public.'||v)::regclass,true),E';\n\r ');
  EXECUTE format('CREATE OR REPLACE VIEW public.%I AS SELECT original.*,
   public._delivery_phone_search_key(original.customer_phone) AS customer_phone_search,
   public._delivery_phone_search_key(original.customer_phone_alt) AS customer_phone_alt_search
   FROM (%s) original',v,def);
 END LOOP;
END $$;

-- The failed-outcome RPC has its own bounded/date-scoped search. Keep its
-- outcome classification, financial projection and permissions intact.
DO $$ DECLARE def text; needle text; BEGIN
 SELECT pg_get_functiondef('public.list_failed_delivery_outcomes(date,date,text,uuid,uuid,text,integer)'::regprocedure) INTO def;
 needle:=$old$length(regexp_replace(v_search, '\D', '', 'g')) >= 3
          and d.customer_phone ilike '%' || regexp_replace(v_search, '\D', '', 'g') || '%'$old$;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Failed search definition changed; inspect before deployment'; END IF;
 EXECUTE replace(def,needle,$new$public._delivery_phone_search_key(d.customer_phone) LIKE ANY(public._delivery_phone_search_patterns(v_search))
          OR public._delivery_phone_search_key(d.customer_phone_alt) LIKE ANY(public._delivery_phone_search_patterns(v_search))$new$);
END $$;

-- Same-customer search is discovery only: do not change group membership,
-- assignment, or earnings when making its search input format-independent.
DO $$ DECLARE def text; needle text; BEGIN
 SELECT pg_get_functiondef('public.list_same_customer_orders(date,text,integer,uuid,uuid,text)'::regprocedure) INTO def;
 needle:=$old$or o.phone like '%' || nullif(regexp_replace(p_search,'\D','','g'),'') || '%'
          or o.phone_alt like '%' || nullif(regexp_replace(p_search,'\D','','g'),'') || '%'$old$;
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Same-customer search definition changed; inspect before deployment'; END IF;
 EXECUTE replace(def,needle,$new$or public._delivery_phone_search_key(o.phone) LIKE ANY(public._delivery_phone_search_patterns(p_search))
          or public._delivery_phone_search_key(o.phone_alt) LIKE ANY(public._delivery_phone_search_patterns(p_search))$new$);
END $$;

NOTIFY pgrst,'reload schema';
COMMIT;
