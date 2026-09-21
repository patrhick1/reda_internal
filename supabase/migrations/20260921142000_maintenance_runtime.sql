BEGIN;

CREATE OR REPLACE FUNCTION reda_maintenance.refresh_run(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance AS $$
DECLARE v_status text; v_counts jsonb; v_old text; v_version text;
BEGIN
 SELECT status INTO v_old FROM reda_maintenance.runs WHERE id=p_id FOR UPDATE;
 SELECT CASE WHEN count(*) FILTER(WHERE status IN('pending','claimed'))>0 THEN 'running'
   WHEN count(*) FILTER(WHERE status='failed')>0 THEN
     CASE WHEN count(*) FILTER(WHERE status='succeeded')>0 THEN 'partial' ELSE 'failed' END
   ELSE 'succeeded' END INTO v_status FROM reda_maintenance.work WHERE run_id=p_id;
 SELECT coalesce(jsonb_object_agg(outcome,n),'{}') INTO v_counts FROM (
   SELECT e.value->>'outcome' AS outcome,count(*) n FROM reda_maintenance.work w,
    LATERAL jsonb_array_elements(coalesce(w.result,'[]')) e
   WHERE w.run_id=p_id GROUP BY 1) counts;
 UPDATE reda_maintenance.runs SET status=v_status,outcomes=v_counts,updated_at=clock_timestamp(),
  completed_at=CASE WHEN v_status IN('succeeded','partial','failed') THEN clock_timestamp() END WHERE id=p_id;
 IF v_status IN('succeeded','partial','failed') AND v_old IS DISTINCT FROM v_status
   AND EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=p_id) THEN
  SELECT md5(string_agg(id::text||':'||status,',' ORDER BY id)) INTO v_version FROM reda_maintenance.work WHERE run_id=p_id;
  PERFORM reda_maintenance.queue_notification(jsonb_build_object('audience','admins',
   'title','Order processing: '||v_status,'body','Results: '||v_counts::text||'. Open End of day for skipped orders and failures.',
   'data',jsonb_build_object('route','eod','run_id',p_id)), 'run:'||p_id||':'||v_version);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.process_group(p_work bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance SET timezone='UTC' AS $$
DECLARE w reda_maintenance.work%rowtype; r reda_maintenance.runs%rowtype;
 v_ids uuid[]; v_context text; v_row record; v_child uuid; v_status text;
 v_result jsonb:='[]'; v_key text; v_target date; v_system uuid:='2d8d5895-d2a8-4900-b15e-7662b176a805';
 v_before jsonb; v_count int;
BEGIN
 SELECT * INTO STRICT w FROM reda_maintenance.work WHERE id=p_work;
 SELECT * INTO STRICT r FROM reda_maintenance.runs WHERE id=w.run_id;
 IF w.status<>'claimed' THEN RETURN '[]'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=v_system AND email='system@reda.local' AND role='admin' AND is_active) THEN
  RAISE EXCEPTION 'Configured Reda System audit actor unavailable' USING ERRCODE='42501'; END IF;
 SELECT array_agg(d.id ORDER BY d.id) INTO v_ids FROM public.deliveries d
 WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND reda_maintenance.group_key(d)=w.group_key;
 IF cardinality(v_ids)>500 THEN
  RAISE EXCEPTION 'This sibling group has more than 500 orders and needs manual review' USING ERRCODE='54000';
 END IF;
 -- The financial lock helper never waits on a new outer lock once nested.
 -- A conflict rolls this group back and is retried after other work commits.
 PERFORM public._same_customer_lock_orders(coalesce(v_ids,'{}'),'{}',false);
 PERFORM 1 FROM public.deliveries WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
 SELECT md5(coalesce(jsonb_agg(reda_maintenance.order_snapshot(d) ORDER BY d.id),'[]'::jsonb)::text)
 INTO v_context FROM public.deliveries d WHERE d.deleted_at IS NULL AND d.order_type='delivery'
 AND reda_maintenance.group_key(d)=w.group_key;
 IF v_context IS DISTINCT FROM w.context_revision OR EXISTS(
   SELECT 1 FROM public.deliveries d WHERE d.id IN(SELECT (e->>'id')::uuid FROM jsonb_array_elements(w.snapshot)e)
     AND reda_maintenance.is_held(d.id,d.updated_at)) THEN
  UPDATE reda_maintenance.work SET status='changed',completed_at=clock_timestamp(),
    result=jsonb_build_array(jsonb_build_object('outcome','changed','reason','Order or sibling changed since preview')) WHERE id=p_work;
  RETURN '[]';
 END IF;
 -- Scope is fixed at enqueue; never close a day which is still in progress.
 IF r.kind='close' AND r.business_date>reda_maintenance.close_through() THEN
  RAISE EXCEPTION 'Business date is not closed yet' USING ERRCODE='22023'; END IF;
 v_target:=public._ensure_workday(greatest(reda_maintenance.business_day(),r.business_date+CASE WHEN r.kind='close' THEN 1 ELSE 0 END));
 v_key:='maintenance:'||r.id||':'||w.revision||':';
 IF r.kind='release' THEN
  SELECT jsonb_agg(jsonb_build_object('id',d.id,'date',d.scheduled_date)) INTO v_before
  FROM public.deliveries d WHERE d.id IN(SELECT (e->>'id')::uuid FROM jsonb_array_elements(w.snapshot)e);
  v_count:=reda_maintenance.release_group(r.business_date,v_ids,v_target);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'outcome',CASE WHEN d.current_status='pending' THEN 'released'
    WHEN d.current_status='failed_delivery' THEN 'close_policy' WHEN d.current_status='cancelled' THEN 'duplicate_closed'
    ELSE 'unchanged' END,'original_date',b->>'date','date',d.scheduled_date,'status',d.current_status)),'[]') INTO v_result
  FROM jsonb_array_elements(v_before)b JOIN public.deliveries d ON d.id=(b->>'id')::uuid;
 ELSE
  -- Classify once for this complete group; unrelated historical rows are not scanned.
  FOR v_row IN SELECT * FROM reda_maintenance.classify(r.business_date,v_ids) LOOP
   IF v_row.action IN('roll','cap_unserious') THEN
    v_child:=public.rollover_delivery(v_key||v_row.delivery_id,v_row.delivery_id,v_target,'maintenance:historical_close',false);
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_row.delivery_id,'outcome',
     CASE WHEN v_child IS NULL THEN 'capped' ELSE 'rolled' END,'child',v_child,'date',v_target));
   ELSE
    v_status:=CASE WHEN v_row.action IN('sibling_resolved','dedup_same_agent','dedup_cross_agent') THEN 'cancelled'
     WHEN v_row.action='close_policy' THEN 'failed_delivery' WHEN v_row.action='close_followup' THEN 'deferred_to_client'
     WHEN v_row.action='close_disinterest' THEN 'unserious' END;
    IF v_status IS NULL THEN RAISE EXCEPTION 'Unknown maintenance action %',v_row.action; END IF;
    PERFORM public.change_delivery_status(v_key||v_row.delivery_id,v_row.delivery_id,v_status,'maintenance:'||v_row.action);
    IF v_row.current_status='postponed' AND v_row.action='close_policy' THEN
     UPDATE public.deliveries SET assigned_agent_id=NULL WHERE id=v_row.delivery_id;
    END IF;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_row.delivery_id,'outcome',v_row.action,'status',v_status));
   END IF;
  END LOOP;
 END IF;
 UPDATE reda_maintenance.work SET status='succeeded',completed_at=clock_timestamp(),result=v_result,error_code=NULL,error_message=NULL WHERE id=p_work;
 RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.dispatch() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance AS $$
DECLARE s reda_maintenance.settings%rowtype; v_date date; v_run uuid; v_n int:=0; v_scan boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-dispatch',0)) THEN RETURN '{"busy":true}'; END IF;
 SELECT * INTO s FROM reda_maintenance.settings WHERE singleton FOR UPDATE;
 IF NOT s.enabled THEN RETURN '{"disabled":true}'; END IF;
 UPDATE reda_maintenance.settings SET dispatch_at=clock_timestamp() WHERE singleton;
 -- Claims are committed by this invocation before the separate worker starts.
 UPDATE reda_maintenance.work SET status=CASE WHEN attempts>=s.retry_limit THEN 'failed' ELSE 'pending' END,
   retry_at=now()+make_interval(mins=>5*attempts),error_code='57014',error_message='Worker stopped before its batch committed'
 WHERE status='claimed' AND claimed_at<now()-interval '3 minutes';
 v_scan:=s.reconciled_day IS DISTINCT FROM reda_maintenance.business_day()
   AND (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '06:00';
 -- Nightly operations and morning reconciliation are independent of yesterday's success.
 IF (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '23:59' OR v_scan
   OR NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='release' AND business_date=reda_maintenance.release_through())
   OR NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='close' AND business_date=reda_maintenance.close_through()) THEN
  IF v_scan OR (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '23:59'
    OR NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='release' AND business_date=reda_maintenance.release_through()) THEN
   PERFORM reda_maintenance.enqueue('release',reda_maintenance.release_through());
  END IF;
  IF v_scan OR (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '23:59'
    OR NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='close' AND business_date=reda_maintenance.close_through()) THEN
   PERFORM reda_maintenance.enqueue('close',reda_maintenance.close_through());
  END IF;
  FOR v_date IN SELECT DISTINCT d.scheduled_date FROM public.deliveries d
   JOIN public.delivery_status_defs sd ON sd.status=d.current_status
   WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND sd.category<>'terminal'
    AND d.scheduled_date<reda_maintenance.close_through() AND d.current_status<>'postponed'
    AND NOT reda_maintenance.is_held(d.id,d.updated_at)
   ORDER BY 1 LIMIT 366 LOOP
   PERFORM reda_maintenance.enqueue('close',v_date);
  END LOOP;
  IF v_scan THEN UPDATE reda_maintenance.settings SET reconciled_day=reda_maintenance.business_day() WHERE singleton; END IF;
 END IF;
 -- Retry only an existing incomplete run, and re-preview changed groups once.
 FOR v_run IN SELECT DISTINCT run_id FROM reda_maintenance.work WHERE status IN('pending','claimed','failed','changed') LOOP
  PERFORM reda_maintenance.refresh_run(v_run);
 END LOOP;
 WITH chosen AS (
  SELECT w.id FROM reda_maintenance.work w JOIN reda_maintenance.runs r ON r.id=w.run_id
  WHERE w.status='pending' AND w.retry_at<=now()
   -- Release first: historical closure must never consume a due postponement.
   AND (r.kind='release' OR NOT EXISTS(SELECT 1 FROM reda_maintenance.work rw JOIN reda_maintenance.runs rr ON rr.id=rw.run_id
      WHERE rr.kind='release' AND rw.status IN('pending','claimed')))
  ORDER BY CASE WHEN r.kind='release' THEN 0 ELSE 1 END,r.business_date,w.id
  LIMIT s.batch_size FOR UPDATE OF w SKIP LOCKED
 ) UPDATE reda_maintenance.work SET status='claimed',attempts=attempts+1,claimed_at=now() WHERE id IN(SELECT id FROM chosen);
 GET DIAGNOSTICS v_n=ROW_COUNT;
 RETURN jsonb_build_object('claimed',v_n);
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.work() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE s reda_maintenance.settings%rowtype; w record; v_n int:=0; v_start timestamptz:=clock_timestamp();
 v_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
 v_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
 v_eod text:=coalesce(current_setting('reda.in_eod_rollover',true),'');
 v_run text:=coalesce(current_setting('reda.maintenance_run_id',true),'');
 v_code text; v_error text; v_retry boolean; v_runs uuid[]:='{}'; v_run_id uuid;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-worker',0)) THEN RETURN '{"busy":true}'; END IF;
 SELECT * INTO s FROM reda_maintenance.settings WHERE singleton;
 IF NOT s.enabled THEN RETURN '{"disabled":true}'; END IF;
 PERFORM set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
 PERFORM set_config('request.jwt.claims','{"sub":"2d8d5895-d2a8-4900-b15e-7662b176a805","role":"authenticated"}',true);
 PERFORM set_config('reda.in_eod_rollover','true',true);
 FOR w IN SELECT id,run_id,attempts FROM reda_maintenance.work WHERE status='claimed' ORDER BY id LIMIT s.batch_size FOR UPDATE SKIP LOCKED LOOP
  EXIT WHEN clock_timestamp()-v_start>=make_interval(secs=>s.budget_seconds);
  PERFORM set_config('reda.maintenance_run_id',w.run_id::text,true);
  BEGIN
   PERFORM reda_maintenance.process_group(w.id);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
   GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_error=MESSAGE_TEXT;
   v_retry:=v_code IN('40001','40P01','55P03','57014','53300','57P01') AND w.attempts<s.retry_limit;
   UPDATE reda_maintenance.work SET status=CASE WHEN v_retry THEN 'pending' ELSE 'failed' END,
     retry_at=now()+make_interval(mins=>5*w.attempts),error_code=v_code,error_message=left(v_error,1000) WHERE id=w.id;
  END;
  v_runs:=array_append(v_runs,w.run_id);
  v_n:=v_n+1;
  EXIT WHEN v_code='57014';
 END LOOP;
 -- Unstarted claims do not consume an attempt or wait for the stale watchdog.
 UPDATE reda_maintenance.work SET status='pending',attempts=attempts-1,claimed_at=NULL
 WHERE status='claimed';
 FOR v_run_id IN SELECT DISTINCT unnest(v_runs) LOOP
  PERFORM reda_maintenance.refresh_run(v_run_id);
 END LOOP;
 UPDATE reda_maintenance.settings SET worker_at=clock_timestamp() WHERE singleton;
 PERFORM set_config('request.jwt.claim.sub',v_sub,true);
 PERFORM set_config('request.jwt.claims',v_claims,true);
 PERFORM set_config('reda.in_eod_rollover',v_eod,true);
 PERFORM set_config('reda.maintenance_run_id',v_run,true);
 RETURN jsonb_build_object('processed_groups',v_n);
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.set_alert(p_key text,p_message text,p_active boolean,p_severity text DEFAULT 'error') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reda_maintenance AS $$
DECLARE v_new boolean;
BEGIN
 IF p_active THEN
  SELECT NOT EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE key=p_key AND resolved_at IS NULL) INTO v_new;
  INSERT INTO reda_maintenance.alerts(key,severity,message) VALUES(p_key,p_severity,p_message)
  ON CONFLICT(key) DO UPDATE SET message=EXCLUDED.message,last_seen=now(),resolved_at=NULL;
  IF v_new THEN PERFORM reda_maintenance.queue_notification(jsonb_build_object('audience','admins',
   'title','Order processing needs attention','body',p_message,'data',jsonb_build_object('route','eod')),
   'alert:'||p_key||':'||now()::text); END IF;
 ELSE
  UPDATE reda_maintenance.alerts SET resolved_at=now() WHERE key=p_key AND resolved_at IS NULL;
  IF FOUND THEN PERFORM reda_maintenance.queue_notification(jsonb_build_object('audience','admins',
   'title','Order processing recovered','body',p_message,'data',jsonb_build_object('route','eod')),
   'recovery:'||p_key||':'||now()::text); END IF;
 END IF;
END $$;

-- Copy the installed notification transport without copying a secret into source.
-- Preserve its exact URL/credentials; make the pg_net request ID observable.
 DO $$ DECLARE def text; wrapped text; BEGIN
 IF to_regprocedure('reda_maintenance.submit_notification(jsonb)') IS NOT NULL THEN RETURN; END IF;
 SELECT pg_get_functiondef('public.send_edge_notification(jsonb)'::regprocedure) INTO def;
 IF def NOT ILIKE '%perform net.http_post(%' THEN
  RAISE EXCEPTION 'Unsupported notification transport; inspect before deployment'; END IF;
 wrapped:=replace(def,'public.send_edge_notification','reda_maintenance.submit_notification');
 wrapped:=regexp_replace(wrapped,'RETURNS void','RETURNS bigint','i');
 wrapped:=regexp_replace(wrapped,'perform net.http_post\(','return net.http_post(','i');
 EXECUTE wrapped;
 -- Replace the original body in place to retain its OID and existing dependencies.
 wrapped:=regexp_replace(def,'begin',E'begin\n if nullif(current_setting(''reda.maintenance_run_id'',true),'''') is not null then\n perform reda_maintenance.queue_notification(p_body); return; end if;','i');
 EXECUTE wrapped;
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.monitor() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance AS $$
DECLARE s reda_maintenance.settings%rowtype; o record; response record; v_n int:=0; v_failed boolean;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-monitor',0)) THEN RETURN '{"busy":true}'; END IF;
 SELECT * INTO s FROM reda_maintenance.settings WHERE singleton;
 IF NOT s.enabled THEN RETURN '{"disabled":true}'; END IF;
 UPDATE reda_maintenance.settings SET monitor_at=clock_timestamp() WHERE singleton;
 PERFORM reda_maintenance.set_alert('scheduler_stale','The order scheduler has not checked in for five minutes.',
   coalesce(s.dispatch_at,s.activated_at)<now()-interval '5 minutes');
 PERFORM reda_maintenance.set_alert('worker_stale','Order processing has not checked in for five minutes.',
   coalesce(s.worker_at,s.activated_at)<now()-interval '5 minutes');
 PERFORM reda_maintenance.set_alert('failed_work','Some order groups need review. Open End of day for the error and affected orders.',
   EXISTS(SELECT 1 FROM reda_maintenance.work WHERE status='failed'));
 PERFORM reda_maintenance.set_alert('late_work','Due orders remain unfinished after the morning recovery deadline.',
   (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '06:15' AND EXISTS(
    SELECT 1 FROM public.deliveries d JOIN public.delivery_status_defs sd ON sd.status=d.current_status
     WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND sd.category<>'terminal'
     AND ((d.current_status='postponed' AND d.scheduled_date<=reda_maintenance.business_day())
       OR d.scheduled_date<reda_maintenance.business_day())
     AND NOT reda_maintenance.is_held(d.id,d.updated_at)));
 PERFORM reda_maintenance.set_alert('missing_run','The expected overnight order-processing run is missing.',
   (now() AT TIME ZONE 'Africa/Lagos')::time>=TIME '06:15' AND (
    NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='release' AND business_date=reda_maintenance.business_day())
    OR NOT EXISTS(SELECT 1 FROM reda_maintenance.runs WHERE kind='close' AND business_date=reda_maintenance.business_day()-1)));
 FOR o IN SELECT * FROM reda_maintenance.outbox WHERE status='submitted' ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
  SELECT status_code,content INTO response FROM net._http_response WHERE id=o.request_id;
  IF FOUND AND response.status_code BETWEEN 200 AND 299 THEN
   UPDATE reda_maintenance.outbox SET status='sent',sent_at=now(),error=NULL WHERE id=o.id;
  ELSIF FOUND OR o.submitted_at<now()-interval '10 minutes' THEN
   UPDATE reda_maintenance.outbox SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
    retry_at=now()+make_interval(mins=>5*attempts),error=CASE WHEN response.status_code IS NULL THEN 'No delivery response received'
      ELSE 'Notification HTTP '||response.status_code END WHERE id=o.id;
  END IF;
 END LOOP;
 FOR o IN SELECT b.* FROM reda_maintenance.outbox b LEFT JOIN reda_maintenance.runs r ON r.id=b.run_id
   WHERE b.status='pending' AND b.retry_at<=now() AND (r.id IS NULL OR r.status IN('succeeded','partial','failed'))
   ORDER BY b.id LIMIT 100 FOR UPDATE OF b SKIP LOCKED LOOP
  BEGIN
   UPDATE reda_maintenance.outbox SET request_id=reda_maintenance.submit_notification(o.payload),
    status='submitted',submitted_at=now(),attempts=attempts+1 WHERE id=o.id;
  EXCEPTION WHEN OTHERS THEN
   UPDATE reda_maintenance.outbox SET attempts=attempts+1,status=CASE WHEN attempts+1>=3 THEN 'failed' ELSE 'pending' END,
    retry_at=now()+interval '5 minutes',error=left(SQLERRM,500) WHERE id=o.id;
  END;
  v_n:=v_n+1;
 END LOOP;
 -- Keep operational diagnostics bounded; order and financial history are untouched.
 DELETE FROM reda_maintenance.outbox WHERE status='sent' AND sent_at<now()-interval '30 days';
 DELETE FROM reda_maintenance.work WHERE completed_at<now()-interval '90 days' AND status IN('succeeded','changed');
 DELETE FROM reda_maintenance.alerts WHERE resolved_at<now()-interval '90 days';
 DELETE FROM reda_maintenance.previews WHERE created_at<now()-interval '7 days';
 RETURN jsonb_build_object('notifications_submitted',v_n);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reda_maintenance FROM PUBLIC,anon,authenticated,reda_maintenance_worker;
GRANT EXECUTE ON FUNCTION reda_maintenance.dispatch(),reda_maintenance.work(),reda_maintenance.monitor() TO reda_maintenance_worker;
COMMIT;
