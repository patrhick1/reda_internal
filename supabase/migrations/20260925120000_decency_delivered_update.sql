-- Decency's delivered update includes customer paid, delivery fee and net remit.
-- Keep explicit payment/fee access limited to the two opted-in clients.
-- Same return signature and privileges as the current live function.
begin;

CREATE OR REPLACE FUNCTION public.client_remit_detail_rep(p_client_id uuid, p_from date, p_to date)
RETURNS TABLE(delivery_id uuid, scheduled_date date, customer_name text, customer_phone text, product_name text, location_name text, quantity_ordered numeric, quantity_delivered numeric, outstanding numeric, remit numeric, agent_name text, products jsonb, payment_method text, cash_pos_fee numeric, client_rep text, order_type text, note text, paid numeric, reda_fee numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  select
    delivery_id, scheduled_date, customer_name, customer_phone,
    product_name, location_name,
    quantity_ordered, quantity_delivered,
    case when payment_method = 'vendor_direct' then 0
         else coalesce(customer_price, 0) - coalesce(paid, 0) end as outstanding,
    remit, agent_name, products,
    payment_method,
    coalesce(cash_pos_fee, 0) as cash_pos_fee,
    client_rep,
    order_type,
    note,
    case when p_client_id in (
      '2acf7d84-3a5c-4532-b47c-568b7f4928f3', -- Karami
      '88398fcc-d4f7-4b5b-a16e-53ce5c463cf3'  -- Decency Stores
    ) then paid end as paid,
    case when p_client_id in (
      '2acf7d84-3a5c-4532-b47c-568b7f4928f3', -- Karami
      '88398fcc-d4f7-4b5b-a16e-53ce5c463cf3'  -- Decency Stores
    ) then reda_fee end as reda_fee
  from public.client_remit_detail(p_client_id, p_from, p_to);
$function$;

commit;
