-- list_stock_movements as live on the box after the product-filter change (2026-09-09).
-- Diff vs the pre-change capture (commit 4c57552): p_product_catalog_id, its predicate,
-- and the balance_after column. See supabase/migrations/20260909120000_stock_history_product_filter.sql.

CREATE OR REPLACE FUNCTION public.list_stock_movements(p_holder_id uuid, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_event_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_actor_id uuid DEFAULT NULL::uuid, p_kinds text[] DEFAULT NULL::text[], p_counterparty_id uuid DEFAULT NULL::uuid, p_product_catalog_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(source text, event_id uuid, event_at timestamp with time zone, event_kind text, product_catalog_id uuid, product_name text, quantity_delta integer, quantity_ordered integer, notes text, actor_id uuid, actor_name text, counterparty_holder_id uuid, counterparty_holder_name text, related_adjustment_id uuid, delivery_id uuid, customer_name text, balance_after integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not (
       coalesce(public.is_admin_or_dispatcher(), false)
    or coalesce(p_holder_id = auth.uid(), false)
    or coalesce(p_holder_id = (select u.warehouse_id from public.users u where u.id = auth.uid()), false)
  ) then
    raise exception 'not authorised to view this holder''s stock history' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;
  return query
  select
    case when sa.delivery_id is not null then 'delivery' else 'adjustment' end::text,
    sa.id, sa.created_at, sa.reason, sa.product_catalog_id, p.product_name, sa.quantity_delta,
    case when sa.reason = 'delivered' then di.quantity_ordered else null end::int,
    sa.notes, sa.created_by_user_id, au.display_name,
    cp.agent_id, cu.display_name, sa.related_adjustment_id,
    sa.delivery_id, dlv.customer_name,
    -- Running balance of the traced product on this holder AFTER this event:
    -- the ledger sum up to and including the row, which is exactly how
    -- current_stock is derived. Only computed while tracing one product.
    case when p_product_catalog_id is null then null else (
      select sum(x.quantity_delta)::int
        from public.stock_adjustments x
       where x.agent_id = p_holder_id
         and x.product_catalog_id = p_product_catalog_id
         and (x.created_at, x.id) <= (sa.created_at, sa.id)
    ) end
  from public.stock_adjustments sa
  join public.product_catalog p on p.id = sa.product_catalog_id
  left join public.users au on au.id = sa.created_by_user_id
  left join public.stock_adjustments cp on cp.id = sa.related_adjustment_id
  left join public.users cu on cu.id = cp.agent_id
  left join public.deliveries dlv on dlv.id = sa.delivery_id
  left join public.delivery_items di
         on di.delivery_id = sa.delivery_id and di.product_catalog_id = sa.product_catalog_id
  where sa.agent_id = p_holder_id
    and (p_product_catalog_id is null or sa.product_catalog_id = p_product_catalog_id)
    and (p_before_at is null or (sa.created_at, sa.id) < (p_before_at, p_before_event_id))
    and (p_actor_id is null or sa.created_by_user_id = p_actor_id)
    and (p_kinds is null or sa.reason = any(p_kinds))
    and (p_counterparty_id is null or cp.agent_id = p_counterparty_id)
  order by sa.created_at desc, sa.id desc
  limit p_limit;
end;
$function$

