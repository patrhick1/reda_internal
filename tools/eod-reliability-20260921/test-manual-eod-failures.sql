\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
-- A late failure in the installed scalar RPC must roll back earlier groups too.
CREATE TEMP SEQUENCE legacy_roll_attempt;
CREATE FUNCTION pg_temp.reject_second_roll() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.created_via='rollover' AND nextval('legacy_roll_attempt')=2 THEN
  RAISE EXCEPTION 'TEST late legacy failure' USING ERRCODE='P0002';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER test_late_roll_failure BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_second_roll();
DO $$ BEGIN
 BEGIN PERFORM public.run_eod_rollover_all_stuck(); RAISE EXCEPTION 'FAIL: injected error missing'; EXCEPTION WHEN no_data_found THEN NULL; END;
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM deliveries WHERE created_via='rollover'),'legacy partial effects rolled back');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.runs),'legacy queue/preview approval rolled back');
 PERFORM pg_temp.assert((SELECT count(*)=3 FROM deliveries WHERE current_status='postponed'),'legacy releases rolled back too');
END $$;
DROP TRIGGER test_late_roll_failure ON deliveries;
DO $$ DECLARE p jsonb; expected int; actual int; history_count int; target date:=public._ensure_workday(reda_maintenance.business_day()+1); BEGIN
 p:=public.prepare_manual_eod(); expected:=(p->'summary'->>'roll')::int;
 PERFORM pg_temp.assert(expected>0,'legacy positive fixture has eligible orders');
 actual:=public.run_eod_rollover_all_stuck();
 PERFORM pg_temp.assert(actual=expected,'installed RPC returns actual completed rollover count');
 PERFORM pg_temp.assert((SELECT count(*)=expected AND bool_and(scheduled_date=target) FROM deliveries WHERE created_via='rollover'),'installed RPC finishes before success');
 PERFORM pg_temp.assert(auth.uid()='2d8d5895-d2a8-4900-b15e-7662b176a805','legacy restores caller identity');
 SELECT count(*) INTO history_count FROM delivery_status_history;
 PERFORM pg_temp.assert(public.run_eod_rollover_all_stuck()=0,'legacy repeat creates nothing');
 PERFORM pg_temp.assert((SELECT count(*)=history_count FROM delivery_status_history),'legacy repeat has no history effects');
END $$;
ROLLBACK;

\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE p jsonb; r uuid; v_id uuid:=md5('eod-test-order-2')::uuid; old_agent uuid; n int; BEGIN
 UPDATE deliveries SET scheduled_date=public._ensure_workday(reda_maintenance.business_day()) WHERE id=v_id;
 p:=public.prepare_manual_eod();
 PERFORM pg_temp.assert(jsonb_array_length(public.manual_eod_preview_page((p->>'preview_id')::uuid,0,2))=2,'saved preview paging');
 UPDATE deliveries SET current_status='available' WHERE id=v_id;
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.manual_eod_preview_page((p->>'preview_id')::uuid,0,100))x WHERE x->>'id'=v_id::text AND x->>'status'='pending'),'preview remains original reviewed snapshot');
 r:=public.request_manual_eod((p->>'preview_id')::uuid);
 FOR n IN 1..20 LOOP PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work(); END LOOP;
 PERFORM pg_temp.assert((SELECT current_status='available' FROM deliveries WHERE id=v_id),'manual worker preserves changes after preview');
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=r AND status='changed'),'changed group is visible');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM deliveries WHERE parent_delivery_id=v_id),'stale preview creates no child');
 SELECT assigned_agent_id INTO old_agent FROM deliveries WHERE id=v_id;
 BEGIN
  PERFORM public.bulk_assign_deliveries(ARRAY[v_id],NULL,jsonb_build_object(v_id::text,'1999-01-01'));
  RAISE EXCEPTION 'FAIL: stale selected date accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 PERFORM pg_temp.assert((SELECT assigned_agent_id IS NOT DISTINCT FROM old_agent FROM deliveries WHERE id=v_id),'stale assignment changes nothing');
 PERFORM public.bulk_assign_deliveries(ARRAY[v_id],md5('eod-test-agent')::uuid,
  (SELECT jsonb_build_object(id::text,scheduled_date::text) FROM deliveries WHERE id=v_id));
 p:=public.prepare_manual_eod();
 UPDATE reda_maintenance.previews SET created_at=now()-interval '31 minutes' WHERE id=(p->>'preview_id')::uuid;
 BEGIN PERFORM public.request_manual_eod((p->>'preview_id')::uuid); RAISE EXCEPTION 'FAIL: expired preview accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 p:=public.prepare_manual_eod();
 UPDATE reda_maintenance.previews SET business_date=business_date-1 WHERE id=(p->>'preview_id')::uuid;
 BEGIN PERFORM public.request_manual_eod((p->>'preview_id')::uuid); RAISE EXCEPTION 'FAIL: previous-day preview accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM set_config('request.jwt.claim.sub',md5('eod-test-agent')::uuid::text,true);
 BEGIN PERFORM public.prepare_manual_eod(); RAISE EXCEPTION 'FAIL: agent prepares close'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.request_manual_eod((p->>'preview_id')::uuid); RAISE EXCEPTION 'FAIL: agent executes close'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.manual_eod_preview_page((p->>'preview_id')::uuid); RAISE EXCEPTION 'FAIL: agent sees private preview'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.run_eod_rollover_all_stuck(); RAISE EXCEPTION 'FAIL: agent uses legacy close'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM pg_temp.assert(NOT has_function_privilege('authenticated','reda_maintenance.process_manual_group(bigint)','EXECUTE'),'manual worker remains private');
 PERFORM pg_temp.assert(NOT has_function_privilege('authenticated','reda_maintenance.release_group(date,uuid[],date,bigint)','EXECUTE'),'early release authority remains private');
 RAISE NOTICE 'PASS: legacy atomic failure and positive completion, stale snapshots, date guard, preview expiry/day change, permissions';
END $$;
ROLLBACK;
