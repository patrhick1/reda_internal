-- Live mirror of public.client_remit_detail_rep (rep-safe client reconcile detail).
-- Rep-facing passthrough over client_remit_detail.
--
-- Returns the actual customer payment for every client so the rep's share Note
-- can say "Customer paid ₦X" instead of describing a partial purchase as money
-- owed. Reda's explicit fee remains server-gated to Karami, which is on the
-- paidAndFee share format. Also surfaces the client-facing payment columns
-- (payment_method, the ₦500 cash POS pass-through, note) so the rep share
-- message matches the admin one.
-- Source of truth is the Cloud DB.
--
-- Signature grows by two columns (paid, reda_fee), so DROP + recreate.

DROP FUNCTION IF EXISTS public.client_remit_detail_rep(uuid, date, date);

CREATE OR REPLACE FUNCTION public.client_remit_detail_rep(p_client_id uuid, p_from date, p_to date)
 RETURNS TABLE(delivery_id uuid, scheduled_date date, customer_name text, product_name text, location_name text, quantity_ordered numeric, quantity_delivered numeric, outstanding numeric, remit numeric, agent_name text, products jsonb, payment_method text, cash_pos_fee numeric, client_rep text, order_type text, note text, paid numeric, reda_fee numeric)
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
    client_rep,
    order_type,
    note,
    paid,
    -- Karami only ('2acf7d84…' = Karami). NULL for every other client.
    case when p_client_id = '2acf7d84-3a5c-4532-b47c-568b7f4928f3' then reda_fee end as reda_fee
  from public.client_remit_detail(p_client_id, p_from, p_to);
$function$;

grant execute on function public.client_remit_detail_rep(uuid, date, date)
  to anon, authenticated, service_role;
