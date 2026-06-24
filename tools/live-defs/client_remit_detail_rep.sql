-- Live mirror of public.client_remit_detail_rep (rep-safe client reconcile detail).
-- Rep-facing passthrough over client_remit_detail that strips Reda's own cut
-- (`paid`, `reda_fee`) but now also surfaces the two CLIENT-FACING payment
-- columns — payment_method and the ₦500 cash POS pass-through — so the rep
-- "Share with client" message matches the admin one byte-for-byte.
-- Source of truth is the Cloud DB; client_rep was added via
-- tools/live-defs/reconcile_client_rep.sql.

DROP FUNCTION IF EXISTS public.client_remit_detail_rep(uuid, date, date);

CREATE OR REPLACE FUNCTION public.client_remit_detail_rep(p_client_id uuid, p_from date, p_to date)
 RETURNS TABLE(delivery_id uuid, scheduled_date date, customer_name text, product_name text, location_name text, quantity_ordered numeric, quantity_delivered numeric, outstanding numeric, remit numeric, agent_name text, products jsonb, payment_method text, cash_pos_fee numeric, client_rep text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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

grant execute on function public.client_remit_detail_rep(uuid, date, date)
  to anon, authenticated, service_role;
