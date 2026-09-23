BEGIN;

-- Owner decision: no order is excluded from the normal business rules by a
-- maintenance hold. Preserve historical records and the legacy function ABI.
CREATE OR REPLACE FUNCTION reda_maintenance.is_held(p_id uuid,p_updated_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,reda_maintenance AS $$ SELECT false $$;

DO $$ DECLARE h record; BEGIN
 FOR h IN SELECT delivery_id FROM reda_maintenance.holds WHERE resolved_at IS NULL FOR UPDATE LOOP
  PERFORM public.write_audit('delivery',h.delivery_id,
   jsonb_build_object('maintenance_hold','unresolved'),jsonb_build_object('maintenance_hold','removed'),
   'Owner instructed that no order be protected; normal end-of-day rules apply',
   '2d8d5895-d2a8-4900-b15e-7662b176a805');
 END LOOP;
END $$;
UPDATE reda_maintenance.holds SET resolved_at=now(),
 resolved_by='2d8d5895-d2a8-4900-b15e-7662b176a805',
 resolution='Owner instructed that no order be protected; normal end-of-day rules apply'
WHERE resolved_at IS NULL;

-- Keep delivery/assignment pushes, but suppress the technical processing feed
-- at its common producer. It remains recorded in runs and alerts for support.
DO $$ DECLARE def text; BEGIN
 SELECT pg_get_functiondef('reda_maintenance.queue_notification(jsonb,text)'::regprocedure) INTO def;
 IF position('IF v_run IS NOT NULL' IN def)=0 THEN RAISE EXCEPTION 'Notification extension point changed'; END IF;
 def:=replace(def,'BEGIN',E'BEGIN\n IF p_body->>''title'' LIKE ''Order processing%'' THEN RETURN; END IF;');
 EXECUTE def;
END $$;
ALTER TABLE reda_maintenance.outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE reda_maintenance.outbox ADD CONSTRAINT outbox_status_check
 CHECK(status IN('pending','submitted','sent','failed','suppressed'));
UPDATE reda_maintenance.outbox SET status='suppressed',error='Processing notifications disabled by owner'
WHERE payload->>'title' LIKE 'Order processing%' AND status IN('pending','failed','submitted');

-- Do not claim recovery solely because the clock crossed midnight. An already
-- active overdue alert remains active until the overdue condition is gone.
DO $$ DECLARE def text; needle text; BEGIN
 SELECT pg_get_functiondef('reda_maintenance.monitor()'::regprocedure) INTO def;
 needle:='(now() AT TIME ZONE ''Africa/Lagos'')::time>=TIME ''06:15'' AND EXISTS(';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Monitor extension point changed'; END IF;
 def:=replace(def,needle,'((now() AT TIME ZONE ''Africa/Lagos'')::time>=TIME ''06:15'' OR EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE key=''late_work'' AND resolved_at IS NULL)) AND EXISTS(');
 EXECUTE def;
END $$;

-- Enrich the immutable preview with the familiar business card information.
DO $$ DECLARE def text; needle text; BEGIN
 SELECT pg_get_functiondef('public.prepare_manual_eod(date)'::regprocedure) INTO def;
 needle:='''customer_name'',d.customer_name,''agent_name'',u.display_name';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Preview extension point changed'; END IF;
 def:=replace(def,needle,needle||',''product_name'',(SELECT product_name FROM public.product_catalog WHERE id=d.product_catalog_id),''quantity'',d.quantity_ordered,''customer_price'',d.customer_price');
 EXECUTE def;
END $$;
CREATE OR REPLACE FUNCTION public.manual_eod_preview_page(p_preview_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE p reda_maintenance.previews%rowtype; result jsonb;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM reda_maintenance.previews WHERE id=p_preview_id AND actor=auth.uid() AND kind='finish_day';
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview not found' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(row),'[]') INTO result FROM (
  SELECT jsonb_build_object('id',o->>'id','customer_name',o->>'customer_name','status',o->>'status',
   'date',o->>'date','agent',o->>'agent_name','carry',(o->>'carry')::int,
   'product_name',o->>'product_name','quantity',o->'quantity','customer_price',o->'customer_price',
   'action',a->>'action','target_date',a->>'target_date') row
  FROM jsonb_array_elements(p.plans)g,LATERAL jsonb_array_elements(g->'snapshot')o,
   LATERAL jsonb_array_elements(g->'actions')a
  WHERE a->>'id'=o->>'id' ORDER BY o->>'date',o->>'customer_name',o->>'id' OFFSET p_offset LIMIT p_limit
 ) page;
 RETURN result;
END $$;

-- Results belong to the submitted preview, not a cumulative run for the day.
-- A fresh, explicitly confirmed review can retry unfinished work. Reopening
-- an already submitted preview still returns the original run unchanged.
DO $$ DECLARE def text; needle text; BEGIN
 SELECT pg_get_functiondef('public.request_manual_eod(uuid)'::regprocedure) INTO def;
 needle:='ON CONFLICT(run_id,group_key,revision) DO NOTHING;';
 IF position(needle IN def)=0 THEN RAISE EXCEPTION 'Manual request extension point changed'; END IF;
 def:=replace(def,needle,'ON CONFLICT(run_id,group_key,revision) DO UPDATE SET status=''pending'',attempts=0,retry_at=now(),claimed_at=NULL,completed_at=NULL,error_code=NULL,error_message=NULL,result=NULL,snapshot=excluded.snapshot,context_revision=excluded.context_revision,manual_plan=excluded.manual_plan WHERE reda_maintenance.work.status IN(''failed'',''changed'',''held'');');
 EXECUTE def;
END $$;

-- Results belong to the submitted preview, not a cumulative run for the day.
-- A repeated click can safely retrieve the same result without recounting old
-- work. The indexed run/group/revision key bounds each lookup.
CREATE FUNCTION public.manual_eod_status(p_preview_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE p reda_maintenance.previews%rowtype; counts jsonb; remaining integer; problems jsonb; problem_count integer;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM reda_maintenance.previews WHERE id=p_preview_id AND actor=auth.uid() AND kind='finish_day';
 IF NOT FOUND OR p.submitted_at IS NULL THEN RAISE EXCEPTION 'End of day has not been submitted' USING ERRCODE='22023'; END IF;
 WITH selected AS (
  SELECT w.* FROM jsonb_array_elements(p.plans)g JOIN reda_maintenance.work w
   ON w.run_id=p.run_id AND w.group_key=g->>'group_key' AND w.revision=g->>'revision'
 ) SELECT count(*) FILTER(WHERE status IN('pending','claimed')),
    count(*) FILTER(WHERE status IN('failed','changed','held')) INTO remaining,problem_count FROM selected;
 SELECT coalesce(jsonb_object_agg(outcome,n),'{}') INTO counts FROM (
  SELECT e->>'outcome' outcome,count(*) n FROM jsonb_array_elements(p.plans)g JOIN reda_maintenance.work w
   ON w.run_id=p.run_id AND w.group_key=g->>'group_key' AND w.revision=g->>'revision'
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(w.result,'[]'))e WHERE w.status='succeeded'
  GROUP BY e->>'outcome'
 ) c;
 SELECT coalesce(jsonb_agg(x),'[]') INTO problems FROM (
  SELECT o->>'id' id,o->>'customer_name' customer_name,
   CASE WHEN w.status='changed' THEN 'This order changed while end of day was running. Check it before trying again.'
    ELSE 'This order could not be completed. Check it before trying again.' END message
  FROM jsonb_array_elements(p.plans)g JOIN reda_maintenance.work w
   ON w.run_id=p.run_id AND w.group_key=g->>'group_key' AND w.revision=g->>'revision'
  CROSS JOIN LATERAL jsonb_array_elements(g->'snapshot')o
  WHERE w.status IN('failed','changed','held') ORDER BY o->>'customer_name',o->>'id' LIMIT 50
 ) x;
 RETURN jsonb_build_object('complete',remaining=0,'needs_attention',problem_count>0,
  'target_date',p.target_date,'outcomes',counts,'problems',problems);
END $$;
REVOKE ALL ON FUNCTION public.manual_eod_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.manual_eod_status(uuid) TO authenticated;

-- Older clients also see no protected-order list. Existing financial/stock
-- protections are separate and retain their normal rules.
DO $$ DECLARE def text; BEGIN
 SELECT pg_get_functiondef('public.maintenance_health()'::regprocedure) INTO def;
 def:=replace(def,'WHERE h.resolved_at IS NULL AND h.expected_updated_at=d.updated_at','WHERE reda_maintenance.is_held(d.id,d.updated_at)');
 EXECUTE def;
END $$;

-- Only unresolved fees belong in the reconciliation action list. Paginate
-- after filtering, so approved waivers cannot hide a genuine issue. Retain
-- the old audit endpoint for previously published clients.
DO $$ DECLARE def text; BEGIN
 SELECT pg_get_functiondef('public.list_agent_pay_details(uuid,date,date,uuid,integer)'::regprocedure) INTO def;
 IF position('(e.final_state=''pending'' or e.manual_amount is not null)' IN def)=0 THEN RAISE EXCEPTION 'Fee list extension point changed'; END IF;
 def:=replace(def,'public.list_agent_pay_details(', 'public.list_agent_pay_issues(');
 def:=replace(def,'(e.final_state=''pending'' or e.manual_amount is not null)','e.final_state=''pending''');
 EXECUTE def;
END $$;
REVOKE ALL ON FUNCTION public.list_agent_pay_issues(uuid,date,date,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_agent_pay_issues(uuid,date,date,uuid,integer) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
