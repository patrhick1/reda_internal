\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE r uuid; p jsonb; before_count int; target date:=reda_maintenance.business_day(); BEGIN
 PERFORM pg_temp.assert(reda_maintenance.close_through('2026-09-20 22:58:59+00')=date '2026-09-19','close cutoff before 23:59');
 PERFORM pg_temp.assert(reda_maintenance.close_through('2026-09-20 22:59:00+00')=date '2026-09-20','close cutoff at 23:59');
 PERFORM pg_temp.assert(reda_maintenance.release_through('2026-09-20 22:59:00+00')=date '2026-09-21','Sunday releases Monday');
 PERFORM pg_temp.assert(reda_maintenance.release_through('2026-12-31 23:00:00+00')=date '2027-01-01','midnight/year boundary');
 PERFORM pg_temp.assert(NOT has_function_privilege('authenticated','reda_maintenance.work()','execute'),'app cannot invoke private worker');
 PERFORM pg_temp.assert(has_function_privilege('reda_maintenance_worker','reda_maintenance.work()','execute'),'worker can invoke private worker');
 PERFORM pg_temp.assert(NOT has_table_privilege('reda_maintenance_worker','public.deliveries','update'),'worker cannot directly update orders');
 BEGIN PERFORM public.prepare_maintenance('close',target+1); RAISE EXCEPTION 'FAIL: early close accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 INSERT INTO reda_maintenance.holds(delivery_id,expected_updated_at,reason)
 SELECT id,updated_at,'TEST human-handled' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid;
 p:=public.prepare_maintenance('release',target);
 r:=public.request_maintenance((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert(public.request_maintenance((p->>'preview_id')::uuid)=r,'manual submit idempotency');
 UPDATE deliveries SET raw_address='TEST changed since preview' WHERE id=md5('eod-test-order-7')::uuid;
 PERFORM reda_maintenance.dispatch();
 PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT current_status='pending' AND assigned_agent_id IS NULL AND scheduled_date=target AND rollover_count=1
  FROM deliveries WHERE id=md5('eod-test-order-1')::uuid),'release keeps date and carry');
 PERFORM pg_temp.assert((SELECT current_status='postponed' FROM deliveries WHERE id=md5('eod-test-order-7')::uuid),'changed preview skipped');
 PERFORM pg_temp.assert((SELECT current_status='postponed' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid),'held row skipped');
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.work WHERE status='changed'),'changed outcome visible');
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE status='pending'),'notification intent recorded');
 SELECT count(*) INTO before_count FROM delivery_status_history WHERE delivery_id=md5('eod-test-order-1')::uuid;
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT count(*)=before_count FROM delivery_status_history WHERE delivery_id=md5('eod-test-order-1')::uuid),'retry creates no duplicate history');
 r:=reda_maintenance.enqueue('close',target-2);
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT count(*)=1 AND bool_and(scheduled_date=public._ensure_workday(target) AND rollover_count=1)
  FROM deliveries WHERE parent_delivery_id=md5('eod-test-order-2')::uuid),'missed days produce one actionable child');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=md5('eod-test-order-3')::uuid),'legitimate carry cap');
 PERFORM pg_temp.assert((SELECT current_status='deferred_to_client' FROM deliveries WHERE id=md5('eod-test-order-4')::uuid),'followup closure');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=md5('eod-test-order-5')::uuid),'disinterest closure');
 PERFORM pg_temp.assert((SELECT current_status='pending' FROM deliveries WHERE id=md5('eod-test-order-8')::uuid),'today work never closed');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM stock_adjustments),'maintenance does not debit stock');
 PERFORM pg_temp.assert(auth.uid()='2d8d5895-d2a8-4900-b15e-7662b176a805','caller context restored');
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE status='submitted'),'outbox transport submits independently');
 INSERT INTO net._http_response(id,status_code,content) SELECT request_id,200,'{}' FROM reda_maintenance.outbox WHERE status='submitted';
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE status='submitted'),'actual successful HTTP response recorded');
 RAISE NOTICE 'PASS: release/close boundaries, held/changed rows, carry rules, retries, audit identity, permissions, outbox responses';
END $$;
ROLLBACK;
