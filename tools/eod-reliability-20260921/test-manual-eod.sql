\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
SELECT set_config('test.eod_day',coalesce(nullif(current_setting('test.requested_day',true),''),reda_maintenance.business_day()::text),true);
SELECT set_config('test.eod_phase','manual',true);
CREATE OR REPLACE FUNCTION reda_maintenance.business_day(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$
 SELECT current_setting('test.eod_day')::date+CASE WHEN current_setting('test.eod_phase')='morning' THEN 1 ELSE 0 END $$;
CREATE OR REPLACE FUNCTION reda_maintenance.close_through(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$
 SELECT current_setting('test.eod_day')::date-CASE WHEN current_setting('test.eod_phase')='manual' THEN 1 ELSE 0 END $$;
CREATE OR REPLACE FUNCTION reda_maintenance.release_through(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$
 SELECT current_setting('test.eod_day')::date+CASE WHEN current_setting('test.eod_phase')='manual' THEN 0 ELSE 1 END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day(),batch_size=1;
UPDATE deliveries SET scheduled_date=reda_maintenance.business_day()-2;
UPDATE deliveries SET scheduled_date=reda_maintenance.business_day() WHERE id IN(md5('eod-test-order-2')::uuid,md5('eod-test-order-3')::uuid,md5('eod-test-order-6')::uuid,md5('eod-test-order-10')::uuid);
UPDATE deliveries SET scheduled_date=public._ensure_workday(reda_maintenance.business_day()+1) WHERE id=md5('eod-test-order-1')::uuid;
UPDATE deliveries SET scheduled_date=public._ensure_workday(reda_maintenance.business_day()+5) WHERE id=md5('eod-test-order-7')::uuid;
UPDATE deliveries SET order_type='replacement' WHERE id=md5('eod-test-order-8')::uuid;
UPDATE deliveries SET customer_phone='08111111111',raw_address='TEST same manual doorstep' WHERE id IN(md5('eod-test-order-6')::uuid,md5('eod-test-order-10')::uuid);
INSERT INTO reda_maintenance.holds(delivery_id,expected_updated_at,reason)
SELECT id,updated_at,'TEST existing protection' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid;
DO $$ DECLARE p jsonb; r uuid; n int; original_history int; target date:=public._ensure_workday(reda_maintenance.business_day()+1); BEGIN
 BEGIN PERFORM reda_maintenance.enqueue('close',reda_maintenance.business_day()); RAISE EXCEPTION 'FAIL: automatic early close accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN PERFORM reda_maintenance.enqueue('release',target); RAISE EXCEPTION 'FAIL: automatic early release accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 p:=public.prepare_manual_eod(reda_maintenance.business_day());
 PERFORM pg_temp.assert(p->>'target_date'=target::text,'manual close explicitly targets next workday before automatic cutoff');
 PERFORM pg_temp.assert((p->>'total_orders')::int=8,'manual review includes past open work and ignores legacy holds; future/replacements excluded');
 PERFORM pg_temp.assert((p->'summary'->>'roll')::int=2,'review identifies two canonical rollovers');
 r:=public.request_manual_eod((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert(public.request_manual_eod((p->>'preview_id')::uuid)=r,'double submission returns same run');
 FOR n IN 1..20 LOOP
  PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
  EXIT WHEN NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=r AND status IN('pending','claimed'));
 END LOOP;
 RAISE NOTICE 'groups: %',(SELECT jsonb_agg(jsonb_build_object('status',status,'code',error_code,'error',error_message)) FROM reda_maintenance.work WHERE run_id=r);
 PERFORM pg_temp.assert((SELECT status='succeeded' FROM reda_maintenance.runs WHERE id=r),'manual batches complete');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=r AND status<>'succeeded'),'all reviewed groups succeeded');
 PERFORM pg_temp.assert((SELECT count(*)=2 AND bool_and(scheduled_date=target AND assigned_agent_id IS NULL) FROM deliveries WHERE created_via='rollover'),'children actually exist on next workday');
 PERFORM pg_temp.assert((SELECT scheduled_date=target AND current_status='pending' AND rollover_count=1 AND assigned_agent_id IS NULL FROM deliveries WHERE id=md5('eod-test-order-1')::uuid),'next-day postponement released without consuming carry');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=md5('eod-test-order-3')::uuid),'carry limit preserved');
 PERFORM pg_temp.assert((SELECT current_status='deferred_to_client' FROM deliveries WHERE id=md5('eod-test-order-4')::uuid),'follow-up rule preserved');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=md5('eod-test-order-5')::uuid),'disinterest rule preserved');
 PERFORM pg_temp.assert((SELECT current_status='postponed' FROM deliveries WHERE id=md5('eod-test-order-7')::uuid),'later postponement untouched');
 PERFORM pg_temp.assert((SELECT current_status='pending' AND order_type='replacement' FROM deliveries WHERE id=md5('eod-test-order-8')::uuid),'replacement untouched');
 PERFORM pg_temp.assert((SELECT current_status='pending' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid),'legacy protection no longer skips an order');
 PERFORM public.bulk_assign_deliveries(ARRAY(SELECT id FROM deliveries WHERE scheduled_date=target AND current_status='pending'),md5('eod-test-agent')::uuid);
 PERFORM pg_temp.assert((SELECT count(*)=4 FROM deliveries WHERE scheduled_date=target AND current_status='pending' AND assigned_agent_id=md5('eod-test-agent')::uuid),'prepared orders assigned to agent');
 SELECT count(*) INTO original_history FROM delivery_status_history;
 PERFORM pg_temp.assert(public.run_eod_rollover_all_stuck()=0,'legacy retry reports no duplicate rollovers');
 PERFORM set_config('test.eod_phase','night',true);
 PERFORM reda_maintenance.enqueue('release',reda_maintenance.release_through());
 PERFORM reda_maintenance.enqueue('close',reda_maintenance.close_through());
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM set_config('test.eod_phase','morning',true);
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT count(*)=4 FROM deliveries WHERE scheduled_date=target AND current_status='pending' AND assigned_agent_id=md5('eod-test-agent')::uuid),'nightly fallback and morning catch-up retain date and assignment');
 PERFORM pg_temp.assert((SELECT count(*)=original_history FROM delivery_status_history),'nightly/retry creates no duplicate effects');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM stock_adjustments),'manual close does not debit stock');
 PERFORM pg_temp.assert(public._ensure_workday(date '2026-09-26'+1)=date '2026-09-28','Saturday close prepares Monday');
 PERFORM pg_temp.assert(public._ensure_workday(date '2026-09-21'+1)=date '2026-09-22','Monday close prepares Tuesday');
 INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
  quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,current_status,created_by_user_id)
 SELECT md5('eod-late-order')::uuid,client_id,product_catalog_id,'TEST late order','08012345678','TEST late address',
  1,10000,3000,4000,current_setting('test.eod_day')::date,'pending',created_by_user_id
 FROM deliveries WHERE id=md5('eod-test-order-8')::uuid;
 PERFORM reda_maintenance.enqueue('close',current_setting('test.eod_day')::date);
 FOR n IN 1..20 LOOP PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work(); END LOOP;
 PERFORM pg_temp.assert((SELECT count(*)=1 AND bool_and(scheduled_date=target) FROM deliveries WHERE parent_delivery_id=md5('eod-late-order')::uuid),'fallback processes orders added after manual finish');
 PERFORM pg_temp.assert((SELECT count(*)=4 FROM deliveries WHERE scheduled_date=target AND current_status='pending' AND assigned_agent_id=md5('eod-test-agent')::uuid),'late-order catch-up leaves prepared assignments intact');
 RAISE NOTICE 'PASS: early manual close -> next-day assignment -> nightly/morning preservation, complete groups, carry/policy boundaries';
END $$;
ROLLBACK;
