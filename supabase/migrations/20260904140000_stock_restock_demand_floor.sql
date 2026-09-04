-- Restock signal, part 2: stop a product going quiet BECAUSE it is out of stock.
--
-- The first version measured selling speed from units that actually shipped
-- (stock_adjustments.reason = 'delivered'). That is self-silencing: you cannot
-- ship what you do not have, so an empty shelf records zero sales, and as the
-- 28-day window rolls forward the product's measured rate decays to nothing and
-- it drops off the reorder list entirely — quietest exactly when it has been
-- out longest. Oud Al Layl is the live example: 241 units shipped last month,
-- shelf empty today, and on the old maths it would fade out within four weeks.
--
-- Fix: where fulfilment is not a fair measure of demand, fall back to demand.
-- Today's open (non-terminal) orders act as a FLOOR under the rate, but ONLY
-- for products that are out of stock or shipped nothing all window:
--
--     rate = shipped rate, except when the shelf is empty or nothing shipped,
--            where it is greatest(shipped rate, today's open quantity)
--
-- Narrow on purpose. Open orders are a snapshot of the whole open book, not one
-- day's demand, so applying them as a rate to a healthy product inflates it —
-- Celimax Retinal ships 1.6/day but had 6 orders open, which read as 6/day and
-- moved it a whole tier. That product's problem is real and immediate, and
-- stock_coverage_today already reports it; restock answers the slower question
-- and must not duplicate the fast one.
--
-- Products with open orders but NO shipments in the window now enter the list
-- at all (a full outer join replaces the shipments-only base). That is the
-- chronically-out case the first version could not see.
--
-- Demand matches stock_coverage_today's definition exactly — same scheduled
-- date, same non-terminal filter, same delivery_items-with-legacy-fallback
-- quantity — so the two surfaces can never disagree about what is open today.
begin;

-- Return type gains qty_open, so the old signature has to go first.
drop function if exists public.stock_restock_signal(int, numeric);

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
  qty_open           int,
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
  demand as (
    -- Mirrors stock_coverage_today's demand CTE exactly.
    select coalesce(di.product_catalog_id, d.product_catalog_id)              as pid,
           sum(coalesce(di.quantity_ordered, d.quantity_ordered, 1))::int     as qty_open
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
      left join public.delivery_items di on di.delivery_id = d.id
     where d.scheduled_date = v_today
       and d.deleted_at is null
       and d.order_type = 'delivery'
       and sd.category <> 'terminal'
       and coalesce(di.product_catalog_id, d.product_catalog_id) is not null
     group by 1
  ),
  base as (
    -- FULL OUTER: a product with orders waiting but nothing shipped all window
    -- must still appear. That is precisely the chronically-out case.
    select coalesce(s.pid, dm.pid)      as pid,
           coalesce(s.units_out, 0)     as units_out,
           coalesce(dm.qty_open, 0)     as qty_open
      from shipped s
      full outer join demand dm on dm.pid = s.pid
     where coalesce(s.units_out, 0) > 0 or coalesce(dm.qty_open, 0) > 0
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
    select b.pid,
           pc.product_name::text                          as pname,
           coalesce(c.name, '')::text                     as cname,
           coalesce(w.qty, 0)                             as wqty,
           b.units_out,
           b.qty_open,
           greatest((
             select count(*) from selling_dates sd
              where sd.dt >= greatest(v_start, coalesce(f.first_move, v_start))
           ), 1)::int                                     as sdays
      from base b
      join public.product_catalog pc on pc.id = b.pid
      left join public.clients c     on c.id = pc.client_id
      left join warehouse w          on w.pid = b.pid
      left join first_seen f         on f.pid = b.pid
  ),
  rated as (
    -- Demand is a FLOOR, and only where the shipped rate is untrustworthy:
    -- when the shelf is empty or nothing shipped all window. Those are the
    -- exact cases where "units shipped" measures our failure to stock rather
    -- than customer appetite.
    --
    -- It is deliberately NOT applied to a product that is in stock and
    -- selling. Today's open orders are a snapshot of the whole open book —
    -- backlog included — not one day's demand, so treating them as a daily
    -- rate inflates it: Celimax Retinal ships 1.6/day but had 6 orders open,
    -- which would have read as 6/day and jumped it a whole tier. "Six orders
    -- against two units" is a real problem, but it is TODAY'S problem, and
    -- stock_coverage_today already reports it. Restock answers the slower
    -- question and must not double up on that one.
    select sc.*,
           case
             when sc.units_out = 0 or sc.wqty <= 0
               then greatest(sc.units_out::numeric / sc.sdays, sc.qty_open::numeric)
             else sc.units_out::numeric / sc.sdays
           end as rate
      from scored sc
  )
  select r.pid,
         r.pname,
         r.cname,
         r.wqty,
         r.units_out,
         r.sdays,
         r.qty_open,
         round(r.rate, 2)                                        as rate_per_day,
         round(r.wqty::numeric / r.rate, 2)                      as days_cover,
         case
           -- Nothing on the shelf while the product is still moving. This is
           -- the state the old `qty > 0` low-stock rule could never report.
           when r.wqty <= 0                    then 'out'
           when r.wqty::numeric / r.rate < 1   then 'critical'
           when r.wqty::numeric / r.rate < v_lead then 'reorder'
           else 'ok'
         end                                                     as tier
    from rated r
   -- Every 'out' row ties at 0 cover, so rate breaks the tie: a product
   -- shipping 10 a day belongs above one shipping 1 a month, not below it
   -- alphabetically.
   order by r.wqty::numeric / r.rate asc, r.rate desc, r.pname;
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
  'selling day (Sundays excluded), floored by today''s open order quantity so a '
  'product cannot go quiet just because being out of stock stopped its sales. '
  'Tiers out/critical/reorder/ok, where reorder = cover shorter than the '
  'replenishment lead time. Ops + warehouse only (carries vendor names).';

notify pgrst, 'reload schema';
commit;
