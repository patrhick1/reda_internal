\set ON_ERROR_STOP on
\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE p jsonb; second jsonb; result jsonb; r uuid; n integer; target date; BEGIN
 INSERT INTO reda_maintenance.holds(delivery_id,expected_updated_at,reason)
 SELECT id,updated_at,'TEST historical protection' FROM deliveries WHERE id=md5('eod-test-order-9')::uuid;
 PERFORM pg_temp.assert(NOT reda_maintenance.is_held(md5('eod-test-order-9')::uuid,(SELECT updated_at FROM deliveries WHERE id=md5('eod-test-order-9')::uuid)),'no order receives maintenance protection');
 UPDATE deliveries SET raw_address='TEST edited legacy hold' WHERE id=md5('eod-test-order-9')::uuid;
 PERFORM pg_temp.assert(NOT reda_maintenance.is_held(md5('eod-test-order-9')::uuid,now()),'edits cannot create an exclusion');
 PERFORM reda_maintenance.queue_notification('{"title":"Order processing: succeeded","audience":"admins"}','TEST summary');
 PERFORM reda_maintenance.set_alert('TEST issue','TEST failure',true);
 PERFORM reda_maintenance.set_alert('TEST issue','TEST failure',false);
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE payload->>'title' LIKE 'Order processing%'),'success, alert and recovery pushes suppressed');
 PERFORM reda_maintenance.queue_notification('{"title":"Delivered","audience":"admins","body":"TEST delivery"}','TEST delivered');
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE payload->>'title'='Delivered'),'ordinary business notification retained');
 PERFORM reda_maintenance.set_alert('late_work','TEST overdue',true);
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE key='late_work' AND resolved_at IS NULL),'overdue alert remains active while overdue orders exist');
 p:=public.prepare_manual_eod(reda_maintenance.business_day()); target:=(p->>'target_date')::date;
 PERFORM pg_temp.assert((p->>'total_orders')::int=10,'all orders in ordinary rules, no hold exclusion');
 PERFORM pg_temp.assert((p->'rows'->0->>'product_name')='EOD TEST product','familiar card product saved in immutable preview');
 UPDATE product_catalog SET product_name='TEST renamed after preview' WHERE id=md5('eod-test-product')::uuid;
 PERFORM pg_temp.assert((public.manual_eod_preview_page((p->>'preview_id')::uuid)->0->>'product_name')='EOD TEST product','preview does not change with product rename');
 r:=public.request_manual_eod((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert(public.request_manual_eod((p->>'preview_id')::uuid)=r,'duplicate submit returns original operation');
 result:=public.manual_eod_status((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert(NOT (result->>'complete')::boolean,'submission is not reported as completion');
 FOR n IN 1..20 LOOP PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work(); END LOOP;
 result:=public.manual_eod_status((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert((result->>'complete')::boolean AND NOT (result->>'needs_attention')::boolean,'actual completion with no false failure');
 PERFORM pg_temp.assert((result->'outcomes'->>'released')::int=3,'all due postponements including former hold released');
 PERFORM pg_temp.assert((result->'outcomes'->>'capped')::int=1,'normal carry limit still closes Unserious');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.outbox WHERE payload->>'title' LIKE 'Order processing%'),'completed operation creates no processing push');
 second:=public.prepare_manual_eod(reda_maintenance.business_day());
 PERFORM pg_temp.assert((second->>'total_orders')::int=0,'finished orders are not offered for repeat processing');
 PERFORM public.request_manual_eod((second->>'preview_id')::uuid);
 PERFORM pg_temp.assert(public.manual_eod_status((second->>'preview_id')::uuid)->'outcomes'='{}'::jsonb,'second empty operation does not repeat cumulative results');
 PERFORM pg_temp.assert(public.manual_eod_status((p->>'preview_id')::uuid)->'outcomes'=result->'outcomes','first operation results remain stable');
 PERFORM reda_maintenance.monitor();
 PERFORM pg_temp.assert(EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE key='late_work' AND resolved_at IS NOT NULL),'overdue alert clears after work is genuinely complete');
 PERFORM set_config('request.jwt.claim.sub',md5('eod-test-agent')::uuid::text,true);
 BEGIN PERFORM public.manual_eod_status((p->>'preview_id')::uuid); RAISE EXCEPTION 'FAIL: rider read admin result'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
 PERFORM pg_temp.assert(NOT has_function_privilege('anon','public.manual_eod_status(uuid)','execute'),'anonymous result access denied');
 RAISE NOTICE 'PASS no holds, no processing pushes, business notifications retained, complete immutable preview, truthful scoped results, retries and role boundaries';
END $$;
ROLLBACK;

\ir fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;
UPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();
DO $$ DECLARE p jsonb; fresh jsonb; result jsonb; n integer; BEGIN
 p:=public.prepare_manual_eod();
 PERFORM public.request_manual_eod((p->>'preview_id')::uuid);
 UPDATE reda_maintenance.work SET status='failed',attempts=3,error_message='TEST exhausted attempts';
 result:=public.manual_eod_status((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert((result->>'complete')::boolean AND (result->>'needs_attention')::boolean AND jsonb_array_length(result->'problems')>0,'failed work shows specific orders, not success');
 PERFORM public.request_manual_eod((p->>'preview_id')::uuid);
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE status='pending'),'page reload cannot retry failed work silently');
 fresh:=public.prepare_manual_eod();
 PERFORM public.request_manual_eod((fresh->>'preview_id')::uuid);
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE status='failed'),'fresh approved review retries unfinished orders');
 FOR n IN 1..20 LOOP PERFORM reda_maintenance.dispatch(); PERFORM reda_maintenance.work(); END LOOP;
 result:=public.manual_eod_status((fresh->>'preview_id')::uuid);
 PERFORM pg_temp.assert((result->>'complete')::boolean AND NOT (result->>'needs_attention')::boolean,'retry succeeds without duplicate work');
 RAISE NOTICE 'PASS explicit retry of failed orders, unchanged request remains idempotent';
END $$;
ROLLBACK;
