\set ON_ERROR_STOP on
\ir ../eod-reliability-20260921/fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
-- A known one-strike order waits untouched; preview and manual/scheduled EOD
-- must leave its remaining attempt available. All records are synthetic.
UPDATE deliveries SET scheduled_date=reda_maintenance.business_day(),rollover_count=1
 WHERE id=md5('eod-test-order-2')::uuid;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE p jsonb; run uuid; child uuid; n int; parent uuid:=md5('eod-test-order-2')::uuid;
 day date:=reda_maintenance.business_day(); BEGIN
 PERFORM pg_temp.assert((SELECT action='roll' FROM reda_maintenance.classify(day,ARRAY[parent])),'Pending with one strike must preview as roll, not Unserious');
 p:=public.prepare_manual_eod(day);
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.classify(day,ARRAY[parent]) WHERE action='roll'),'manual preview agrees with rule');
 run:=public.request_manual_eod((p->>'preview_id')::uuid);
 FOR n IN 1..20 LOOP
  PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
  EXIT WHEN NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=run AND status IN('pending','claimed'));
 END LOOP;
 SELECT id INTO child FROM deliveries WHERE parent_delivery_id=parent;
 PERFORM pg_temp.assert(child IS NOT NULL,'manual EOD creates successor for untouched order');
 PERFORM pg_temp.assert((SELECT rollover_count=1 AND assigned_agent_id IS NULL AND scheduled_date=public._ensure_workday(day+1) FROM deliveries WHERE id=child),'manual EOD preserves remaining attempt and assignment workflow');
 PERFORM public.bulk_assign_deliveries(ARRAY[child],md5('eod-test-agent')::uuid);
 PERFORM public.change_delivery_status('attempt-acceptance-last-failure',child,'not_answering');
 -- Move only the synthetic business clock past that day's close boundary.
 PERFORM set_config('test.attempt_day',(day+5)::text,true);
 CREATE OR REPLACE FUNCTION reda_maintenance.business_day(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $fn$ SELECT current_setting('test.attempt_day')::date $fn$;
 CREATE OR REPLACE FUNCTION reda_maintenance.close_through(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $fn$ SELECT current_setting('test.attempt_day')::date-1 $fn$;
 PERFORM pg_temp.assert((SELECT action='cap_unserious' FROM reda_maintenance.classify(public._ensure_workday(day+1),ARRAY[child])),'second failure preview closes');
 run:=reda_maintenance.enqueue('close',public._ensure_workday(day+1));
 FOR n IN 1..20 LOOP
  PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
  EXIT WHEN NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=run AND status IN('pending','claimed'));
 END LOOP;
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=child),'scheduled EOD enforces second failed attempt');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM deliveries WHERE parent_delivery_id=child),'scheduled close does not create third attempt');
 PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work();
 PERFORM pg_temp.assert((SELECT count(*)=1 FROM deliveries WHERE parent_delivery_id=parent),'worker retry remains idempotent');
 RAISE NOTICE 'PASS: preview -> manual EOD -> reassign -> second failure -> scheduled close -> retry';
END $$;
ROLLBACK;
