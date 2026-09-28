BEGIN;

-- Manual approval is committed by request_manual_eod first. Each invocation
-- advances only that approved preview; cron remains the durable fallback.
-- PostgREST hoists this isolation setting before the request transaction starts.
CREATE FUNCTION public.advance_manual_eod(p_preview_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,auth,reda_maintenance
SET default_transaction_isolation='serializable'
SET statement_timeout='20s'
SET lock_timeout='2s' AS $$
DECLARE
 p reda_maintenance.previews%rowtype; s reda_maintenance.settings%rowtype;
 w record; v_n integer:=0; v_start timestamptz:=clock_timestamp();
 v_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
 v_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
 v_eod text:=coalesce(current_setting('reda.in_eod_rollover',true),'');
 v_run text:=coalesce(current_setting('reda.maintenance_run_id',true),'');
 v_code text; v_error text; v_ready boolean;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN
  RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO p FROM reda_maintenance.previews
 WHERE id=p_preview_id AND actor=auth.uid() AND kind='finish_day';
 IF NOT FOUND OR p.submitted_at IS NULL THEN
  RAISE EXCEPTION 'End of day has not been submitted' USING ERRCODE='22023';
 END IF;
 IF current_setting('transaction_isolation')<>'serializable' THEN
  RAISE EXCEPTION 'Manual processing requires a serializable transaction' USING ERRCODE='25001';
 END IF;
 -- Never wait behind the scheduled worker, legacy caller, or dispatcher.
 -- Both locks are nonblocking. They also prevent the dispatcher reclaiming
 -- work while this invocation processes it. No global queue is drained here.
 IF NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-worker',0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-dispatch',0)) THEN
  RETURN public.manual_eod_status(p_preview_id)||jsonb_build_object('processed_groups',0,'retry_after_ms',1000);
 END IF;
 SELECT * INTO s FROM reda_maintenance.settings WHERE singleton;
 IF NOT s.enabled THEN
  RETURN public.manual_eod_status(p_preview_id)||jsonb_build_object('processed_groups',0,'retry_after_ms',30000);
 END IF;
 PERFORM set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
 PERFORM set_config('request.jwt.claims','{"sub":"2d8d5895-d2a8-4900-b15e-7662b176a805","role":"authenticated"}',true);
 PERFORM set_config('reda.in_eod_rollover','true',true);
 PERFORM set_config('reda.maintenance_run_id',p.run_id::text,true);
 FOR w IN
  SELECT q.id,q.status,q.attempts FROM jsonb_array_elements(p.plans)g
  JOIN reda_maintenance.work q ON q.run_id=p.run_id
   AND q.group_key=g->>'group_key' AND q.revision=g->>'revision'
  WHERE (q.status='pending' AND q.retry_at<=now()) OR q.status='claimed'
  ORDER BY q.id LIMIT least(s.batch_size,100) FOR UPDATE OF q SKIP LOCKED
 LOOP
  EXIT WHEN clock_timestamp()-v_start>=make_interval(secs=>least(s.budget_seconds,4));
  UPDATE reda_maintenance.work SET status='claimed',
   attempts=attempts+CASE WHEN status='pending' THEN 1 ELSE 0 END,claimed_at=now()
  WHERE id=w.id;
  v_code:=NULL;
  BEGIN
   PERFORM reda_maintenance.process_group(w.id);
  EXCEPTION WHEN OTHERS OR query_canceled THEN
   GET STACKED DIAGNOSTICS v_code=RETURNED_SQLSTATE,v_error=MESSAGE_TEXT;
   UPDATE reda_maintenance.work SET
    status=CASE WHEN v_code IN('40001','40P01','55P03','57014','53300','57P01')
     AND attempts<s.retry_limit THEN 'pending' ELSE 'failed' END,
    retry_at=now()+make_interval(mins=>5*attempts),
    error_code=v_code,error_message=left(v_error,1000)
   WHERE id=w.id;
  END;
  v_n:=v_n+1;
  EXIT WHEN v_code='57014';
 END LOOP;
 IF v_n>0 THEN PERFORM reda_maintenance.refresh_run(p.run_id); END IF;
 PERFORM set_config('request.jwt.claim.sub',v_sub,true);
 PERFORM set_config('request.jwt.claims',v_claims,true);
 PERFORM set_config('reda.in_eod_rollover',v_eod,true);
 PERFORM set_config('reda.maintenance_run_id',v_run,true);
 SELECT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p.plans)g JOIN reda_maintenance.work q
   ON q.run_id=p.run_id AND q.group_key=g->>'group_key' AND q.revision=g->>'revision'
  WHERE (q.status='pending' AND q.retry_at<=now()) OR q.status='claimed'
 ) INTO v_ready;
 -- Continue immediately only after actual progress. Busy rows and real retry
 -- delays must not create a tight request loop. Do not reset other work claims.
 RETURN public.manual_eod_status(p_preview_id)||jsonb_build_object('processed_groups',v_n,
  'retry_after_ms',CASE WHEN v_n>0 AND v_ready THEN 0 WHEN v_ready THEN 1000 ELSE 30000 END);
END $$;

REVOKE ALL ON FUNCTION public.advance_manual_eod(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.advance_manual_eod(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
