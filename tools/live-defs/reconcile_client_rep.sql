-- Include the client's own rep / closer in per-delivery reconciliation rows so
-- the client-facing share message can render:
--   Note: Linda —
--   Note: Linda — Bought 1
--
-- The return shapes change, so both functions must be dropped and recreated.
-- Apply after client_rep.sql has added deliveries.client_rep.

begin;

drop function if exists public.client_remit_detail_rep(uuid, date, date);
drop function if exists public.client_remit_detail(uuid, date, date);

create function public.client_remit_detail(p_client_id uuid, p_from date, p_to date)
returns table(
  delivery_id uuid, scheduled_date date, customer_name text, product_name text,
  location_name text, quantity_ordered numeric, quantity_delivered numeric,
  customer_price numeric, paid numeric, payment_method text, reda_fee numeric,
  cash_pos_fee numeric, remit numeric, agent_name text, products jsonb,
  client_rep text
)
language sql stable security definer set search_path to 'public', 'auth'
as $function$
  select
    d.id, d.scheduled_date, d.customer_name,
    p.product_name, l.name,
    d.quantity_ordered,
    d.quantity_delivered,
    d.customer_price,
    d.paid,
    d.payment_method,
    coalesce(d.charged_snapshot, 0)                                 as reda_fee,
    coalesce(d.cash_pos_fee_snapshot, 0)                            as cash_pos_fee,
    coalesce(d.paid, 0)
      - coalesce(d.charged_snapshot, 0)
      - coalesce(d.cash_pos_fee_snapshot, 0)                        as remit,
    u.display_name                                                  as agent_name,
    coalesce(
      (select jsonb_agg(
                jsonb_build_object(
                  'product_name', pc.product_name,
                  'quantity_ordered', di.quantity_ordered,
                  'quantity_delivered', coalesce(di.quantity_delivered, di.quantity_ordered)
                )
                order by di.created_at, pc.product_name)
       from public.delivery_items di
       join public.product_catalog pc on pc.id = di.product_catalog_id
       where di.delivery_id = d.id),
      jsonb_build_array(
        jsonb_build_object(
          'product_name', p.product_name,
          'quantity_ordered', d.quantity_ordered,
          'quantity_delivered', d.quantity_delivered
        ))
    )                                                              as products,
    d.client_rep
  from public.deliveries d
  left join public.product_catalog p on p.id = d.product_catalog_id
  left join public.locations       l on l.id = d.location_id
  left join public.users           u on u.id = d.assigned_agent_id
  where d.client_id      = p_client_id
    and d.current_status = 'delivered'
    and d.scheduled_date >= p_from
    and d.scheduled_date <= p_to
    and d.deleted_at is null
    and public.is_admin_or_dispatcher()
  order by d.scheduled_date desc, d.created_at desc;
$function$;

create function public.client_remit_detail_rep(p_client_id uuid, p_from date, p_to date)
returns table(
  delivery_id uuid, scheduled_date date, customer_name text, product_name text,
  location_name text, quantity_ordered numeric, quantity_delivered numeric,
  outstanding numeric, remit numeric, agent_name text, products jsonb,
  payment_method text, cash_pos_fee numeric, client_rep text
)
language sql stable security definer set search_path to 'public', 'auth'
as $function$
  select
    delivery_id, scheduled_date, customer_name, product_name, location_name,
    quantity_ordered, quantity_delivered,
    case when payment_method = 'vendor_direct' then 0
         else coalesce(customer_price, 0) - coalesce(paid, 0) end as outstanding,
    remit, agent_name, products,
    payment_method,
    coalesce(cash_pos_fee, 0) as cash_pos_fee,
    client_rep
  from public.client_remit_detail(p_client_id, p_from, p_to);
$function$;

grant execute on function public.client_remit_detail(uuid, date, date)
  to anon, authenticated, service_role;
grant execute on function public.client_remit_detail_rep(uuid, date, date)
  to anon, authenticated, service_role;

commit;
