\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database()<>'reda_eod_test' OR inet_server_addr()<>'127.0.0.1'::inet THEN
    RAISE EXCEPTION 'Isolated EOD database required'; END IF;
END $$;
INSERT INTO auth.users(id,email) VALUES
 ('2d8d5895-d2a8-4900-b15e-7662b176a805','system@reda.local'),
 (md5('eod-test-agent')::uuid,'agent@eod.example.invalid');
INSERT INTO public.users(id,email,display_name,role)
 SELECT id,email,'TEST '||email,CASE WHEN email='system@reda.local' THEN 'admin' ELSE 'agent' END FROM auth.users;
SELECT set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
SELECT set_config('reda.in_eod_rollover','true',true);
INSERT INTO public.feature_flags(key,enabled) VALUES('enable_auto_assign',false) ON CONFLICT(key) DO UPDATE SET enabled=false;
INSERT INTO public.clients(id,name) VALUES(md5('eod-test-client')::uuid,'EOD TEST');
INSERT INTO public.locations(id,name) VALUES(md5('eod-test-location')::uuid,'EOD TEST zone');
INSERT INTO public.product_catalog(id,client_id,product_name)
 VALUES(md5('eod-test-product')::uuid,md5('eod-test-client')::uuid,'EOD TEST product');
INSERT INTO public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
 quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,
 current_status,rollover_count,created_by_user_id)
SELECT md5('eod-test-order-'||n)::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,
 'TEST recipient '||n,'080000000'||lpad(n::text,2,'0'),'TEST address '||n,1,10000,3000,4000,
 md5('eod-test-agent')::uuid,(now() AT TIME ZONE 'Africa/Lagos')::date-CASE WHEN n IN(1,7,8,9) THEN 0 ELSE 2 END,
 CASE WHEN n IN(1,7,9) THEN 'postponed' WHEN n=3 THEN 'not_answering' WHEN n=4 THEN 'follow_up'
   WHEN n=5 THEN 'not_available' ELSE 'pending' END,
 CASE WHEN n IN(1,3) THEN 1 ELSE 0 END,'2d8d5895-d2a8-4900-b15e-7662b176a805'
FROM generate_series(1,10)n;
