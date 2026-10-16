-- Dedicated synthetic PostgreSQL fixture. The upstream financial reader is a
-- test double; the rep projection under test is the actual production SQL.
DO $$ BEGIN
  IF current_database() <> 'reda_altior_test' OR inet_server_addr() <> '127.0.0.1'::inet OR inet_server_port() <> 55459 THEN
    RAISE EXCEPTION 'Refusing outside the isolated Altior test database';
  END IF;
END $$;
CREATE SCHEMA auth;
CREATE ROLE altior_report_caller NOLOGIN;
CREATE ROLE altior_report_denied NOLOGIN;
CREATE TABLE public.report_fixture (
  client_id uuid, delivery_id uuid, scheduled_date date, customer_name text,
  customer_phone text, product_name text, location_name text,
  quantity_ordered numeric, quantity_delivered numeric, customer_price numeric,
  paid numeric, reda_fee numeric, remit numeric, agent_name text, products jsonb,
  payment_method text, cash_pos_fee numeric, client_rep text, order_type text, note text
);
CREATE FUNCTION public.client_remit_detail(p_client_id uuid,p_from date,p_to date)
RETURNS SETOF public.report_fixture LANGUAGE sql STABLE AS $$
  SELECT * FROM public.report_fixture
  WHERE client_id=p_client_id AND scheduled_date BETWEEN p_from AND p_to
    AND current_setting('test.actor',true) IN ('admin','rep');
$$;
INSERT INTO public.report_fixture
SELECT c::uuid,md5(c||method)::uuid,'2026-10-15','TEST recipient',NULL,'TEST product','TEST zone',2,1,20000,
  CASE WHEN method='vendor_direct' THEN 0 ELSE 15000 END,
  2000,
  CASE WHEN method='vendor_direct' THEN -2000 WHEN method='cash' THEN 12500 ELSE 13000 END,
  'TEST agent','[{"product_name":"TEST product","quantity_delivered":1}]'::jsonb,
  method,CASE WHEN method='cash' THEN 500 ELSE 0 END,'ORD-TEST-001','delivery',NULL
FROM unnest(ARRAY[
  '0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc',
  '2acf7d84-3a5c-4532-b47c-568b7f4928f3',
  '88398fcc-d4f7-4b5b-a16e-53ce5c463cf3',
  '11111111-1111-4111-8111-111111111111'
]) c CROSS JOIN unnest(ARRAY['transfer','cash','vendor_direct']) method;
