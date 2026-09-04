-- Restock signal — "what do we need to order?", measured in DAYS OF COVER
-- rather than a flat unit threshold.
--
-- Why this exists. The app's only low-stock rule was `0 < qty <= 3`, applied to
-- each holder row. Checked against live stock on 2026-09-04 that rule flagged 8
-- products needing nothing (Opulent Dubai: 1 unit, but 24 days of cover) while
-- staying silent on 8 that did — seven of them at ZERO warehouse stock and
-- actively selling, invisible precisely because the rule required qty > 0. It
-- also cannot see the shape that started this: Bubble Cleaner holds 34 units,
-- which looks healthy until you notice it ships ~20 a day.
--
-- The metric: warehouse stock / units shipped per SELLING day.
--   * Warehouse only. Riders carry 1-3 units as a normal day's round, and 85%
--     of the old rule's amber rows were rider bags — noise, not signal.
--   * Sundays are excluded from the divisor. The trailing 28 days contain zero
--     Sunday deliveries, so a calendar divisor understates every rate by ~14%.
--   * 28-day window. Per-product demand is spiky (one product shipped 31 units
--     one day and 3 the next); a week-long window swings between panic and
--     silence. A month smooths it without going stale.
--   * A product first stocked INSIDE the window divides by its own age, not the
--     full 28 days, so a new fast mover isn't scored as a slow one.
--
-- Tiers use the real replenishment lead time (Uzo, 2026-09-04: stock takes 2-5
-- days to reach the warehouse, plan on 3). `reorder` therefore means "cover is
-- shorter than the time a restock takes to arrive" — order now or it runs dry
-- before the delivery lands.
--
-- Known limitation, deliberate: the rate counts what SHIPPED, so a product that
-- has been out of stock for the whole window has no deliveries and drops off
-- the list entirely. Blending in today's open orders (stock_coverage_today
-- already computes them) is the intended follow-up; this version does the
-- trailing-throughput half only.
begin;

create or replace function public.stock_restock_signal(
  p_window_days int     default 28,
  p_lead_days   numeric default 3
)
returns table (
  product_catalog_id uuid,
  product_name       text,
  client_name        text,
  warehouse_qty      int,
  units_out          int,
  selling_days       int,
  rate_per_day       numeric,
  days_cover         numeric,
  tier               text
)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $fn$
declare
  v_today  date := (now() at time zone 'Africa/Lagos')::date;
  v_window int  := greatest(least(coalesce(p_window_days, 28), 90), 7);
  v_lead   numeric := greatest(coalesce(p_lead_days, 3), 0.5);
  v_start  date;
begin
  -- Ops + warehouse. Agents never restock, and unlike stock_coverage_today
  -- (which powers their "should I call?" badge) this carries vendor names, so
  -- it must not be agent-callable — that would leak past the anti-poaching RLS.
  if not (public.is_admin_or_dispatcher() or public.is_warehouse()) then
    raise exception 'permission denied: restock signal is for ops and warehouse'
      using errcode = '42501';
  end if;

  v_start := v_today - (v_window - 1);

  return query
  with selling_dates as (
    -- The divisor's calendar. Sunday is dropped: it has never traded.
    select d::date as dt
      from generate_series(v_start, v_today, interval '1 day') d
     where extract(dow from d) <> 0
  ),
  shipped as (
    select sa.product_catalog_id                 as pid,
           (-sum(sa.quantity_delta))::int        as units_out
      from public.stock_adjustments sa
     where sa.reason = 'delivered'
       and (sa.created_at at time zone 'Africa/Lagos')::date between v_start and v_today
     group by sa.product_catalog_id
    having -sum(sa.quantity_delta) > 0
  ),
  first_seen as (
    -- When the product started being stocked at all, so a line introduced
    -- mid-window is rated over its own life rather than the full 28 days.
    select sa.product_catalog_id as pid,
           min((sa.created_at at time zone 'Africa/Lagos')::date) as first_move
      from public.stock_adjustments sa
     group by sa.product_catalog_id
  ),
  warehouse as (
    select cs.product_catalog_id                          as pid,
           coalesce(sum(cs.quantity_on_hand), 0)::int     as qty
      from public.current_stock cs
      join public.users u on u.id = cs.agent_id
     where u.role = 'warehouse' and u.warehouse_id is null
     group by cs.product_catalog_id
  ),
  scored as (
    select s.pid,
           pc.product_name::text                          as pname,
           coalesce(c.name, '')::text                     as cname,
           coalesce(w.qty, 0)                             as wqty,
           s.units_out,
           greatest((
             select count(*) from selling_dates sd
              where sd.dt >= greatest(v_start, coalesce(f.first_move, v_start))
           ), 1)::int                                     as sdays
      from shipped s
      join public.product_catalog pc on pc.id = s.pid
      left join public.clients c     on c.id = pc.client_id
      left join warehouse w          on w.pid = s.pid
      left join first_seen f         on f.pid = s.pid
  )
  select sc.pid,
         sc.pname,
         sc.cname,
         sc.wqty,
         sc.units_out,
         sc.sdays,
         round(sc.units_out::numeric / sc.sdays, 2)                        as rate_per_day,
         round(sc.wqty::numeric / (sc.units_out::numeric / sc.sdays), 2)   as days_cover,
         case
           -- Nothing on the shelf while the product is still selling. This is
           -- the state the old `qty > 0` rule could never report.
           when sc.wqty <= 0                                                    then 'out'
           when sc.wqty::numeric / (sc.units_out::numeric / sc.sdays) < 1       then 'critical'
           when sc.wqty::numeric / (sc.units_out::numeric / sc.sdays) < v_lead  then 'reorder'
           else 'ok'
         end                                                               as tier
    from scored sc
   -- Every 'out' row ties at 0 cover, so rate breaks the tie: a product
   -- shipping 10 a day belongs above one shipping 1 a month, not below it
   -- alphabetically.
   order by sc.wqty::numeric / (sc.units_out::numeric / sc.sdays) asc,
            (sc.units_out::numeric / sc.sdays) desc,
            sc.pname;
end;
$fn$;

-- Default privileges on this box hand EXECUTE to anon/authenticated/service_role
-- for every new public function, so naming the roles explicitly is required —
-- `revoke from public` alone would leave it callable by anon.
revoke all on function public.stock_restock_signal(int, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.stock_restock_signal(int, numeric)
  to authenticated, service_role;

comment on function public.stock_restock_signal(int, numeric) is
  'Days-of-cover restock signal: warehouse stock divided by units shipped per '
  'selling day over a trailing window (Sundays excluded). Tiers out/critical/'
  'reorder/ok, where reorder = cover shorter than the replenishment lead time. '
  'Ops + warehouse only (carries vendor names).';

notify pgrst, 'reload schema';
commit;
