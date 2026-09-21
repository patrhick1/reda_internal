\set ON_ERROR_STOP on
\ir fixture.sql
-- Synthetic historical backfill in the isolated rollback fixture only. Business
-- triggers are tested by the outcome suites; they are irrelevant to query scale.
ALTER TABLE public.deliveries DISABLE TRIGGER USER;
INSERT INTO public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
 quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,current_status,created_by_user_id)
SELECT md5('history-scale-'||n)::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,
 'TEST archive '||n,'090'||lpad(n::text,8,'0'),'TEST archive address '||n,1,10000,3000,4000,
 reda_maintenance.business_day()-CASE WHEN n<=20000 THEN 90 ELSE 2 END,
 CASE WHEN n<=20000 THEN 'cancelled' ELSE 'pending' END,'2d8d5895-d2a8-4900-b15e-7662b176a805'
FROM generate_series(1,20500)n;
ALTER TABLE public.deliveries ENABLE TRIGGER USER;
ANALYZE public.deliveries;
-- The prior expression-index mismatch times out on this archived/active mix.
-- Exercise real grouping and snapshot materialization, not just index existence.
SET LOCAL statement_timeout='10s';
DO $$ DECLARE n int; bytes bigint; BEGIN
 SELECT count(*),sum(length(snapshot::text)+length(context_revision)) INTO n,bytes
 FROM reda_maintenance.plans('close',reda_maintenance.business_day()-2);
 IF n<500 OR bytes<500 THEN RAISE EXCEPTION 'Historical fixture did not exercise full plans'; END IF;
 SELECT count(*),sum(length(snapshot::text)+length(context_revision)+length(actions::text)) INTO n,bytes
 FROM reda_maintenance.manual_plans(reda_maintenance.business_day(),public._ensure_workday(reda_maintenance.business_day()+1));
 IF n<500 OR bytes<500 THEN RAISE EXCEPTION 'Manual historical fixture did not exercise full plans'; END IF;
 RAISE NOTICE 'PASS: nightly and manual planning with 20,000 archived and 500 active orders';
END $$;
ROLLBACK;
