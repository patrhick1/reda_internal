-- stock_movement_summary — periodized (day/week) roll-up of the stock ledger for
-- ONE product, optionally scoped to one holder, over a date range. Aggregates in
-- the DB (per period + reason) so the app ships a handful of totals instead of
-- hundreds of raw movement rows — the "daily/weekly movements" view and the
-- reconciliation trace ("what was delivered since …") both read this.
--
-- Sign convention follows the ledger's quantity_delta:
--   received/found/delivery_returned  → positive
--   delivered/loss/theft/damaged      → negative
--   warehouse_issue / warehouse_return / transfer are PAIRED: company-wide
--   (p_holder_id null) their two legs cancel to 0 and are dropped by HAVING;
--   scoped to a holder they show that holder's in/out (e.g. the warehouse shelf's
--   issues-out). Deliveries reduce the *rider/total*, not the shelf — so a
--   warehouse-scoped summary has no `delivered` line, the company-wide one does.
--
-- Read-only; STABLE; no ledger writes. Indexes idx_stock_adj_product_created /
-- idx_stock_adj_agent_product cover the (product[, holder] + created_at) scan.
create or replace function public.stock_movement_summary(
  p_product_catalog_id uuid,
  p_from     date,
  p_to       date,
  p_holder_id uuid default null,
  p_bucket   text default 'day'      -- 'day' | 'week' (Lagos)
)
returns table(period_start date, reason text, qty bigint)
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
  select
    case
      when p_bucket = 'week'
        then (date_trunc('week', (sa.created_at at time zone 'Africa/Lagos'))::date)
      else (sa.created_at at time zone 'Africa/Lagos')::date
    end as period_start,
    sa.reason,
    sum(sa.quantity_delta)::bigint as qty
  from public.stock_adjustments sa
  where sa.product_catalog_id = p_product_catalog_id
    and (p_holder_id is null or sa.agent_id = p_holder_id)
    and sa.created_at >= (p_from::text || ' 00:00')::timestamp at time zone 'Africa/Lagos'
    and sa.created_at <  ((p_to + 1)::text || ' 00:00')::timestamp at time zone 'Africa/Lagos'
  group by 1, 2
  having sum(sa.quantity_delta) <> 0
  order by 1 desc, 2;
end;
$fn$;

revoke all on function public.stock_movement_summary(uuid, date, date, uuid, text) from public;
grant execute on function public.stock_movement_summary(uuid, date, date, uuid, text) to authenticated;
