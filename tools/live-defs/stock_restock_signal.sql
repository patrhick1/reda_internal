CREATE OR REPLACE FUNCTION public.stock_restock_signal(p_window_days integer DEFAULT 28, p_lead_days numeric DEFAULT 3)
 RETURNS TABLE(product_catalog_id uuid, product_name text, client_name text, warehouse_qty integer, units_out integer, selling_days integer, rate_per_day numeric, days_cover numeric, tier text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
$function$
;

