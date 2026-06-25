-- ============================================================================
-- Surface the pickup/waybill cost breakdown in the client reconciliation report
-- (Uzo, 2026-06-25). A waybill's itemized breakdown ("Pickup ₦2,000 /
-- Storekeeper ₦500 / Driver ₦1,000") is stored ONLY as free text in the
-- delivery's note (delivery_messages.note, written by create_waybill). The
-- reconcile RPCs never returned it, so buildClientShareMessage couldn't show it.
--
-- This adds a single ADDITIVE, descriptive `note` column to client_remit_detail
-- (and its thin rep wrapper). For waybill rows it returns the delivery's first
-- note (the create_waybill breakdown); null otherwise. NO existing computation
-- (remit, reda_fee, outstanding, products, …) is changed — the bodies below are
-- the live definitions verbatim with only the new column appended.
--
-- Drop+recreate is required because RETURNS TABLE changes shape. The rep wrapper
-- is dropped first (it calls the base fn), then both are recreated, then grants
-- are re-applied (DROP wipes them). Reps need this via the SECURITY DEFINER RPC
-- because the delivery_messages SELECT RLS would otherwise hide an unassigned
-- waybill's note from a rep.
-- ============================================================================

begin;

drop function if exists public.client_remit_detail_rep(uuid, date, date);
drop function if exists public.client_remit_detail(uuid, date, date);

create function public.client_remit_detail(p_client_id uuid, p_from date, p_to date)
returns table(
  delivery_id uuid, scheduled_date date, customer_name text, product_name text,
  location_name text, quantity_ordered numeric, quantity_delivered numeric,
  customer_price numeric, paid numeric, payment_method text, reda_fee numeric,
  cash_pos_fee numeric, remit numeric, agent_name text, products jsonb,
  client_rep text, order_type text, note text
)
language sql
stable security definer
set search_path to 'public', 'auth'
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
      case when d.order_type = 'waybill' then '[]'::jsonb
           else jsonb_build_array(
             jsonb_build_object(
               'product_name', p.product_name,
               'quantity_ordered', d.quantity_ordered,
               'quantity_delivered', d.quantity_delivered
             ))
      end
    )                                                              as products,
    d.client_rep,
    d.order_type,
    case when d.order_type = 'waybill' then (
      select dm.note
        from public.delivery_messages dm
       where dm.delivery_id = d.id
         and nullif(btrim(dm.note), '') is not null
       order by dm.created_at asc
       limit 1
    ) else null end                                                as note
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
  payment_method text, cash_pos_fee numeric, client_rep text, order_type text,
  note text
)
language sql
stable security definer
set search_path to 'public', 'auth'
as $function$
  select
    delivery_id, scheduled_date, customer_name, product_name, location_name,
    quantity_ordered, quantity_delivered,
    case when payment_method = 'vendor_direct' then 0
         else coalesce(customer_price, 0) - coalesce(paid, 0) end as outstanding,
    remit, agent_name, products,
    payment_method,
    coalesce(cash_pos_fee, 0) as cash_pos_fee,
    client_rep,
    order_type,
    note
  from public.client_remit_detail(p_client_id, p_from, p_to);
$function$;

grant execute on function public.client_remit_detail(uuid, date, date)     to authenticated, anon, service_role;
grant execute on function public.client_remit_detail_rep(uuid, date, date) to authenticated, anon, service_role;

commit;
