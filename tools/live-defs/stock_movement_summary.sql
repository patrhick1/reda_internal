-- stock_movement_summary — periodized (day/week) roll-up of the stock ledger for
-- ONE product, optionally scoped to one holder, over a date range. Aggregates in
-- the DB (per period + reason) so the app ships a handful of totals instead of
-- hundreds of raw movement rows — the "daily/weekly movements" view and the
-- reconciliation trace ("what was delivered since …") both read this.
--
-- `qty` is always the signed net change for the selected scope.
-- `activity_qty` preserves company-wide internal activity for paired
-- warehouse_issue / warehouse_return / transfer rows: exactly one source
-- (negative) leg is counted as a positive unit quantity, while both signed legs
-- still cancel in `qty`. This lets the UI say "3 issued, 2 returned, net company
-- change 0" instead of incorrectly saying no movement.
--
-- Read-only; STABLE; no ledger writes. Indexes idx_stock_adj_product_created /
-- idx_stock_adj_agent_product cover the (product[, holder] + created_at) scan.
begin;

-- Adding activity_qty changes the return shape, which CREATE OR REPLACE cannot
-- do. The signature stays identical for callers; the drop/create is atomic.
drop function if exists public.stock_movement_summary(uuid, date, date, uuid, text);

create function public.stock_movement_summary(
  p_product_catalog_id uuid,
  p_from       date,
  p_to         date,
  p_holder_id  uuid default null,
  p_bucket     text default 'day'      -- 'day' | 'week' (Lagos)
)
returns table(period_start date, reason text, qty bigint, activity_qty bigint)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $fn$
begin
  -- Ops oversight surface — same audience as the movement history.
  if not (public.is_admin_or_dispatcher() or public.is_warehouse()) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_bucket not in ('day', 'week') then
    raise exception 'bucket must be ''day'' or ''week''' using errcode = '22023';
  end if;
  if p_from is null or p_to is null then
    raise exception 'from and to dates are required' using errcode = '23514';
  end if;

  return query
  with scoped as (
    select
      case
        when p_bucket = 'week'
          then date_trunc('week', sa.created_at at time zone 'Africa/Lagos')::date
        else (sa.created_at at time zone 'Africa/Lagos')::date
      end as movement_period,
      sa.reason as movement_reason,
      sa.quantity_delta::bigint as net_qty,
      case
        when p_holder_id is null
         and sa.reason in ('warehouse_issue', 'warehouse_return', 'transfer')
         and sa.quantity_delta < 0
          then -sa.quantity_delta::bigint
        else 0::bigint
      end as internal_activity_qty
    from public.stock_adjustments sa
    where sa.product_catalog_id = p_product_catalog_id
      and (p_holder_id is null or sa.agent_id = p_holder_id)
      and sa.created_at >= (p_from::text || ' 00:00')::timestamp at time zone 'Africa/Lagos'
      and sa.created_at <  ((p_to + 1)::text || ' 00:00')::timestamp at time zone 'Africa/Lagos'
  )
  select
    s.movement_period,
    s.movement_reason,
    sum(s.net_qty)::bigint,
    sum(s.internal_activity_qty)::bigint
  from scoped s
  group by s.movement_period, s.movement_reason
  having sum(s.net_qty) <> 0 or sum(s.internal_activity_qty) <> 0
  order by s.movement_period desc, s.movement_reason;
end;
$fn$;

revoke all on function public.stock_movement_summary(uuid, date, date, uuid, text) from public;
grant execute on function public.stock_movement_summary(uuid, date, date, uuid, text) to authenticated;

notify pgrst, 'reload schema';

commit;
