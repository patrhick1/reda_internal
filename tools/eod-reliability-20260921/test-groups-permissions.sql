\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day(),batch_size=1;
UPDATE deliveries SET customer_phone='08111111111',raw_address='TEST same doorstep',scheduled_date=reda_maintenance.business_day(),current_status='postponed'
 WHERE id IN(md5('eod-test-order-1')::uuid,md5('eod-test-order-7')::uuid,md5('eod-test-order-9')::uuid);
UPDATE deliveries SET order_type='replacement',current_status='postponed' WHERE id=md5('eod-test-order-8')::uuid;
INSERT INTO reda_maintenance.holds(delivery_id,expected_updated_at,reason)
 SELECT id,updated_at,'TEST protected sibling' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid;
SELECT reda_maintenance.enqueue('release',reda_maintenance.business_day());
SELECT reda_maintenance.dispatch();
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','',true);
SET LOCAL ROLE reda_maintenance_worker;
SELECT reda_maintenance.work();
RESET ROLE;
DO $$ BEGIN
 PERFORM pg_temp.assert((SELECT count(*)=1 FROM deliveries WHERE current_status='pending' AND id IN(md5('eod-test-order-1')::uuid,md5('eod-test-order-7')::uuid)),'complete sibling group releases one canonical with batch size one');
 PERFORM pg_temp.assert((SELECT count(*)=1 FROM deliveries WHERE current_status='cancelled' AND id IN(md5('eod-test-order-1')::uuid,md5('eod-test-order-7')::uuid)),'surplus sibling closed');
 PERFORM pg_temp.assert((SELECT current_status='postponed' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid),'protected sibling does not block newer work');
 PERFORM pg_temp.assert((SELECT current_status='postponed' AND assigned_agent_id=md5('eod-test-agent')::uuid FROM deliveries WHERE id=md5('eod-test-order-8')::uuid),'replacement identity and owner unchanged');
 PERFORM pg_temp.assert((SELECT bool_and(changed_by_user_id='2d8d5895-d2a8-4900-b15e-7662b176a805') FROM delivery_status_history),'native worker fixes audit identity without login/header');
 PERFORM pg_temp.assert(auth.uid() IS NULL,'worker restored empty caller identity');
END $$;
SELECT set_config('request.jwt.claim.sub',md5('eod-test-agent')::uuid::text,true);
DO $$ BEGIN
 BEGIN PERFORM public.maintenance_health(); RAISE EXCEPTION 'FAIL: agent read private operations health'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.prepare_maintenance('release',reda_maintenance.business_day()); RAISE EXCEPTION 'FAIL: agent queued maintenance'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 RAISE NOTICE 'PASS: group boundaries, protected siblings, replacements, native role, fixed audit identity and app permissions';
END $$;
SELECT set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
DO $$ DECLARE d public.deliveries%rowtype; r uuid; BEGIN
 -- Policy clients close rather than being released for their requested date.
 UPDATE clients SET auto_cancel_soft_fails=true WHERE id=md5('eod-test-client')::uuid;
 UPDATE deliveries SET current_status='postponed',scheduled_date=reda_maintenance.business_day()
  WHERE id=md5('eod-test-order-6')::uuid;
 r:=reda_maintenance.enqueue('release',reda_maintenance.business_day());
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT current_status='failed_delivery' AND assigned_agent_id IS NULL FROM deliveries WHERE id=md5('eod-test-order-6')::uuid),'client policy closure');
 RAISE NOTICE 'PASS: policy-client postponement closes failed and unassigned';
END $$;
ROLLBACK;
