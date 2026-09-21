\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE d public.deliveries%rowtype; target date:=reda_maintenance.business_day(); old_date date; r uuid; BEGIN
 SELECT * INTO d FROM deliveries WHERE id=md5('eod-test-order-1')::uuid;
 old_date:=d.scheduled_date;
 PERFORM public.postpone_delivery('reschedule-test',d.id,target+7,d.updated_at,d.current_status,d.scheduled_date,'Customer postponed');
 PERFORM public.postpone_delivery('reschedule-test',d.id,target+7,d.updated_at,d.current_status,d.scheduled_date,'Customer postponed');
 PERFORM pg_temp.assert((SELECT current_status='postponed' AND assigned_agent_id=d.assigned_agent_id AND rollover_count=d.rollover_count
  AND scheduled_date=public._ensure_workday(target+7) FROM deliveries WHERE id=d.id),'reschedule preserves order/owner/carry');
 PERFORM pg_temp.assert((SELECT count(*)=1 FROM delivery_status_history WHERE client_uuid='reschedule-test'),'offline retry has one effect');
 PERFORM pg_temp.assert((SELECT previous_scheduled_date=old_date AND new_scheduled_date=public._ensure_workday(target+7)
  FROM delivery_status_history WHERE client_uuid='reschedule-test'),'promised dates immutable on history');
 BEGIN PERFORM public.postpone_delivery('stale',d.id,target+8,d.updated_at,d.current_status,d.scheduled_date); RAISE EXCEPTION 'FAIL: stale request accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 SELECT * INTO d FROM deliveries WHERE id=md5('eod-test-order-8')::uuid;
 BEGIN PERFORM public.change_delivery_status('null-date',d.id,'postponed','Customer postponed'); RAISE EXCEPTION 'FAIL: no date accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN PERFORM public.postpone_delivery('past-date',d.id,target,d.updated_at,d.current_status,d.scheduled_date); RAISE EXCEPTION 'FAIL: same day accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- Monday-through-Saturday promises remain intact; Sunday is always Monday.
 FOR i IN 0..6 LOOP
  PERFORM pg_temp.assert(public._ensure_workday(date '2026-09-21'+i)=CASE WHEN i=6 THEN date '2026-09-28' ELSE date '2026-09-21'+i END,'weekday normalization');
 END LOOP;
END $$;
CREATE FUNCTION pg_temp.inject_group_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF old.id=md5('eod-test-order-2')::uuid THEN RAISE EXCEPTION 'Injected group fault' USING ERRCODE='23514'; END IF;
 RETURN new;
END $$;
CREATE TRIGGER test_group_failure BEFORE UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_group_failure();
DO $$ DECLARE r uuid; target date:=reda_maintenance.business_day(); BEGIN
 r:=reda_maintenance.enqueue('close',target-2);
 -- Pre-create empty due-run records to keep this test focused on explicit work.
 INSERT INTO reda_maintenance.runs(kind,business_date,status) VALUES('release',target,'succeeded'),('close',target-1,'succeeded') ON CONFLICT DO NOTHING;
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT current_status='pending' FROM deliveries WHERE id=md5('eod-test-order-2')::uuid),'failed group rolled back');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM deliveries WHERE parent_delivery_id=md5('eod-test-order-2')::uuid),'failed group leaves no child');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=md5('eod-test-order-3')::uuid),'unrelated group committed');
 PERFORM pg_temp.assert((SELECT status='partial' FROM reda_maintenance.runs WHERE id=r),'partial outcome visible');
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=r AND status='failed' AND error_code='23514'),'permanent error retained');
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE key='failed_work' AND resolved_at IS NULL),'failure alert');
END $$;
DROP TRIGGER test_group_failure ON public.deliveries;
DO $$ DECLARE w record; BEGIN
 FOR w IN SELECT id FROM reda_maintenance.work WHERE status='failed' LOOP PERFORM public.retry_maintenance_group(w.id); END LOOP;
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT count(*)=1 FROM deliveries WHERE parent_delivery_id=md5('eod-test-order-2')::uuid),'retry resumes failed group once');
 -- Simulate a disconnected worker after claims committed.
 UPDATE reda_maintenance.work SET status='claimed',claimed_at=now()-interval '4 minutes',attempts=3 WHERE id=(SELECT min(id) FROM reda_maintenance.work);
 PERFORM reda_maintenance.dispatch();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.work WHERE status='failed' AND error_code='57014'),'dead worker detected and retries bounded');
 UPDATE reda_maintenance.outbox SET status='submitted',submitted_at=now()-interval '11 minutes',attempts=3,request_id=-1;
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE status='failed'),'notification timeout persists separately');
 RAISE NOTICE 'PASS: offline rescheduling, immutable dates, stale requests, date validation, group rollback/resume, dead worker, notification timeout';
END $$;
ROLLBACK;
