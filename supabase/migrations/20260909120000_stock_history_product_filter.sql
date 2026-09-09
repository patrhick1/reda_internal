-- Stock history: trace one product.
--
-- Uzo's card (2026-09-06): agents should be able to filter their stock history
-- by product "so they can trace anything that happened with only a particular
-- product easily". The history screen already pushes its filters (type, staff,
-- recipient) into list_stock_movements because the list is infinite and paged
-- 50 rows at a time — a median agent has ~1,300 ledger rows and ~75 products
-- in 90 days, so a client-side filter over the loaded page would miss almost
-- everything. The product filter goes in the same place.
--
-- While tracing one product the RPC also returns a running balance per row.
-- current_stock is literally sum(quantity_delta) over stock_adjustments per
-- (holder, product), so the balance after each event is the ledger sum up to
-- and including that row — exact by construction, and it makes the filtered
-- view read as a trace ("Delivered −1 → 11 left") instead of a list.
--
-- Compatibility: the new parameter has a default and the new column is
-- appended, so older app bundles that pass seven named arguments keep working
-- and ignore the extra column. The function must be dropped first because
-- the return type changes.
begin;

drop function if exists public.list_stock_movements(uuid, timestamptz, uuid, integer, uuid, text[], uuid);

-- Identical to tools/live-defs/list_stock_movements.sql (captured 2026-09-09)
-- plus: p_product_catalog_id, the product predicate, and balance_after.
CREATE OR REPLACE FUNCTION public.list_stock_movements(
  p_holder_id uuid,
  p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_before_event_id uuid DEFAULT NULL::uuid,
  p_limit integer DEFAULT 50,
  p_actor_id uuid DEFAULT NULL::uuid,
  p_kinds text[] DEFAULT NULL::text[],
  p_counterparty_id uuid DEFAULT NULL::uuid,
  p_product_catalog_id uuid DEFAULT NULL::uuid
)
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
$function$;

-- The picker: every product this holder has ever moved, with what they hold
-- now and when it last moved. Same gate as the history itself. Product names
-- only — no vendor names — so an agent sees nothing new here.
create or replace function public.list_movement_products(p_holder_id uuid)
 returns table(product_catalog_id uuid, product_name text, movement_count integer, last_moved_at timestamp with time zone, on_hand integer)
 language plpgsql stable security definer set search_path = public, auth
as $fn$
begin
  if not (
       coalesce(public.is_admin_or_dispatcher(), false)
    or coalesce(p_holder_id = auth.uid(), false)
    or coalesce(p_holder_id = (select u.warehouse_id from public.users u where u.id = auth.uid()), false)
  ) then
    raise exception 'not authorised to view this holder''s stock history' using errcode = '42501';
  end if;
  return query
  select sa.product_catalog_id, p.product_name::text, count(*)::integer,
         max(sa.created_at), coalesce(sum(sa.quantity_delta), 0)::integer
    from public.stock_adjustments sa
    join public.product_catalog p on p.id = sa.product_catalog_id
   where sa.agent_id = p_holder_id
   group by sa.product_catalog_id, p.product_name
   order by max(sa.created_at) desc;
end;
$fn$;

-- Same audience as the existing history RPCs: signed-in app users (the gate
-- inside decides which holder). anon never passes the gate, so drop it.
revoke all on function public.list_stock_movements(uuid, timestamptz, uuid, integer, uuid, text[], uuid, uuid) from public, anon;
grant execute on function public.list_stock_movements(uuid, timestamptz, uuid, integer, uuid, text[], uuid, uuid) to authenticated, service_role;
revoke all on function public.list_movement_products(uuid) from public, anon;
grant execute on function public.list_movement_products(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
