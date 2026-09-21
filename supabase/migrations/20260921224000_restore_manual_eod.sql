BEGIN;

-- Match the actual function expression used by plans and workers. The earlier
-- CASE-expression index is not usable when PostgreSQL keeps this function call.
CREATE INDEX deliveries_maintenance_group_lookup ON public.deliveries(
 reda_maintenance.group_key(customer_phone_normalized,items_fingerprint,product_catalog_id,scheduled_date,id))
 WHERE deleted_at IS NULL AND order_type='delivery';

ALTER TABLE reda_maintenance.runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE reda_maintenance.runs ADD CONSTRAINT runs_kind_check CHECK(kind IN('release','close','finish_day'));
ALTER TABLE reda_maintenance.runs ADD COLUMN target_date date;
ALTER TABLE reda_maintenance.previews ADD COLUMN target_date date;
ALTER TABLE reda_maintenance.work ADD COLUMN manual_plan jsonb;

-- Manual EOD is an explicit business operation, independent of the automatic
-- 23:59 cutoff. Persist its destination and reviewed actions before execution.
CREATE FUNCTION reda_maintenance.manual_plans(p_day date,p_target date)
RETURNS TABLE(group_key text,revision text,snapshot jsonb,context_revision text,actions jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance SET timezone='UTC' AS $$
 WITH dates AS (
  SELECT p_day AS day UNION
  SELECT DISTINCT d.scheduled_date FROM public.deliveries d JOIN public.delivery_status_defs s ON s.status=d.current_status
  WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND s.category<>'terminal'
   AND d.current_status<>'postponed' AND d.scheduled_date<p_day
   AND NOT reda_maintenance.is_held(d.id,d.updated_at)
   AND NOT EXISTS(SELECT 1 FROM public.deliveries c WHERE c.parent_delivery_id=d.id AND c.created_via='rollover')
 ), releases AS MATERIALIZED (
  SELECT delivery_id,action FROM reda_maintenance.release_actions(p_target)
 ), closes AS (
  SELECT DISTINCT ON(c.delivery_id) c.delivery_id,c.action
  FROM dates CROSS JOIN LATERAL reda_maintenance.classify(dates.day,NULL)c
  WHERE NOT EXISTS(SELECT 1 FROM releases r WHERE r.delivery_id=c.delivery_id)
  ORDER BY c.delivery_id,dates.day DESC
 ), decisions AS (
  SELECT delivery_id,action,'release'::text operation FROM releases
  UNION ALL SELECT delivery_id,action,'close'::text FROM closes
 ), groups AS (
  SELECT reda_maintenance.group_key(d) key,
   jsonb_agg(reda_maintenance.order_snapshot(d) ORDER BY d.id) snap,
   jsonb_agg(jsonb_build_object('id',d.id,'operation',x.operation,'action',x.action,
    'source_date',d.scheduled_date,'target_date',CASE WHEN x.action IN('roll','release') THEN p_target END) ORDER BY d.id) decisions
  FROM decisions x JOIN public.deliveries d ON d.id=x.delivery_id
  GROUP BY reda_maintenance.group_key(d)
 )
 SELECT key,md5(snap::text||':'||p_target::text),snap,
  (SELECT md5(coalesce(jsonb_agg(reda_maintenance.order_snapshot(d) ORDER BY d.id),'[]'::jsonb)::text)
   FROM public.deliveries d WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND reda_maintenance.group_key(d)=groups.key),
  decisions FROM groups
$$;

CREATE FUNCTION public.manual_eod_preview_page(p_preview_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE p reda_maintenance.previews%rowtype; result jsonb;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_offset<0 OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid page' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM reda_maintenance.previews WHERE id=p_preview_id AND actor=auth.uid() AND kind='finish_day';
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview not found' USING ERRCODE='22023'; END IF;
 -- Display the immutable reviewed snapshot, not today's mutable delivery row.
 SELECT coalesce(jsonb_agg(row),'[]') INTO result FROM (
  SELECT jsonb_build_object('id',o->>'id','customer_name',o->>'customer_name','status',o->>'status',
   'date',o->>'date','agent',o->>'agent_name','carry',(o->>'carry')::int,
   'action',a->>'action','target_date',a->>'target_date') row
  FROM jsonb_array_elements(p.plans)g,LATERAL jsonb_array_elements(g->'snapshot')o,
   LATERAL jsonb_array_elements(g->'actions')a
  WHERE a->>'id'=o->>'id' ORDER BY o->>'date',o->>'customer_name',o->>'id' OFFSET p_offset LIMIT p_limit
 ) page;
 RETURN result;
END $$;

CREATE FUNCTION public.prepare_manual_eod(p_for_date date DEFAULT ((now() AT TIME ZONE 'Africa/Lagos')::date))
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance SET timezone='UTC' AS $$
DECLARE v_id uuid; v_target date; v_plans jsonb; v_count int; v_summary jsonb; v_large int;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_for_date IS DISTINCT FROM reda_maintenance.business_day() THEN
  RAISE EXCEPTION 'Finish day uses today in Lagos. Use recovery for a historical date.' USING ERRCODE='22023'; END IF;
 v_target:=public._ensure_workday(p_for_date+1);
 SELECT coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('snapshot',(
   SELECT jsonb_agg(o||jsonb_build_object('customer_name',d.customer_name,'agent_name',u.display_name) ORDER BY o->>'id')
   FROM jsonb_array_elements(p.snapshot)o JOIN public.deliveries d ON d.id=(o->>'id')::uuid
   LEFT JOIN public.users u ON u.id=d.assigned_agent_id)) ORDER BY p.group_key),'[]')
 INTO v_plans FROM reda_maintenance.manual_plans(p_for_date,v_target)p;
 SELECT coalesce(sum(jsonb_array_length(g->'snapshot')),0),count(*) FILTER(WHERE jsonb_array_length(g->'snapshot')>500)
 INTO v_count,v_large FROM jsonb_array_elements(v_plans)g;
 SELECT coalesce(jsonb_object_agg(action,n),'{}') INTO v_summary FROM (
  SELECT a->>'action' action,count(*) n FROM jsonb_array_elements(v_plans)g,LATERAL jsonb_array_elements(g->'actions')a GROUP BY 1
 ) counts;
 INSERT INTO reda_maintenance.previews(actor,kind,business_date,target_date,plans)
 VALUES(auth.uid(),'finish_day',p_for_date,v_target,v_plans) RETURNING id INTO v_id;
 RETURN jsonb_build_object('preview_id',v_id,'kind','finish_day','date',p_for_date,'target_date',v_target,
  'total_orders',v_count,'oversized_groups',v_large,'summary',v_summary,'rows',public.manual_eod_preview_page(v_id,0,100),
  'expires_at',now()+interval '30 minutes');
END $$;

CREATE FUNCTION public.request_manual_eod(p_preview_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE p reda_maintenance.previews%rowtype; v_run uuid;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM reda_maintenance.previews WHERE id=p_preview_id AND actor=auth.uid() AND kind='finish_day' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview not found' USING ERRCODE='22023'; END IF;
 IF p.submitted_at IS NOT NULL THEN RETURN p.run_id; END IF;
 IF p.created_at<now()-interval '30 minutes' OR p.business_date<>reda_maintenance.business_day()
  OR p.target_date<>public._ensure_workday(p.business_date+1) THEN
  RAISE EXCEPTION 'Preview expired or the business day changed. Preview again.' USING ERRCODE='22023'; END IF;
 IF NOT (SELECT enabled FROM reda_maintenance.settings WHERE singleton) THEN RAISE EXCEPTION 'Processing is paused' USING ERRCODE='55000'; END IF;
 INSERT INTO reda_maintenance.runs(kind,business_date,target_date,requested_by)
 VALUES('finish_day',p.business_date,p.target_date,auth.uid()) ON CONFLICT(kind,business_date) DO NOTHING;
 SELECT id INTO v_run FROM reda_maintenance.runs WHERE kind='finish_day' AND business_date=p.business_date AND target_date=p.target_date FOR UPDATE;
 IF v_run IS NULL THEN RAISE EXCEPTION 'Existing run has a different destination'; END IF;
 INSERT INTO reda_maintenance.work(run_id,group_key,revision,snapshot,context_revision,manual_plan)
 SELECT v_run,g->>'group_key',g->>'revision',g->'snapshot',g->>'context_revision',
  jsonb_build_object('approved_by',auth.uid(),'preview_id',p.id,'source_date',p.business_date,'target_date',p.target_date,'actions',g->'actions')
 FROM jsonb_array_elements(p.plans)g ON CONFLICT(run_id,group_key,revision) DO NOTHING;
 UPDATE reda_maintenance.runs SET status='pending',completed_at=NULL,updated_at=now() WHERE id=v_run;
 UPDATE reda_maintenance.previews SET submitted_at=now(),run_id=v_run WHERE id=p.id;
 PERFORM public.write_audit('maintenance',p.id,'{}',jsonb_build_object('run_id',v_run,'source_date',p.business_date,
  'target_date',p.target_date,'groups',jsonb_array_length(p.plans)),'manual_eod_approved',auth.uid());
 IF NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=v_run AND status IN('pending','claimed')) THEN
  PERFORM reda_maintenance.refresh_run(v_run);
 END IF;
 RETURN v_run;
END $$;

-- A private, persisted approval is the only early-release authority. App callers
-- cannot set this metadata or call the private overload.
CREATE FUNCTION reda_maintenance.manual_release_allowed(p_work bigint,p_due date,p_target date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,reda_maintenance AS $$
 SELECT EXISTS(SELECT 1 FROM reda_maintenance.work w JOIN reda_maintenance.runs r ON r.id=w.run_id
  WHERE w.id=p_work AND w.status='claimed' AND r.kind='finish_day' AND r.target_date=p_due AND r.target_date=p_target
   AND w.manual_plan->>'approved_by' IS NOT NULL AND (w.manual_plan->>'source_date')::date=r.business_date
   AND (w.manual_plan->>'target_date')::date=r.target_date)
$$;

DO $$ DECLARE def text; old_guard text; new_guard text; BEGIN
 SELECT pg_get_functiondef('reda_maintenance.release_group(date,uuid[],date)'::regprocedure) INTO def;
 def:=replace(def,'release_group(p_due_date date, p_ids uuid[], p_target date)',
  'release_group(p_due_date date, p_ids uuid[], p_target date, p_work_id bigint)');
 old_guard:='IF p_due_date>reda_maintenance.release_through() THEN';
 new_guard:='IF p_due_date>reda_maintenance.release_through() AND NOT reda_maintenance.manual_release_allowed(p_work_id,p_due_date,p_target) THEN';
 IF position(old_guard IN def)=0 OR position('p_work_id bigint' IN def)=0 THEN RAISE EXCEPTION 'Release extension point changed'; END IF;
 EXECUTE replace(def,old_guard,new_guard);
END $$;

CREATE FUNCTION reda_maintenance.process_manual_group(p_work bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance SET timezone='UTC' AS $$
DECLARE w reda_maintenance.work%rowtype; r reda_maintenance.runs%rowtype; v_ids uuid[]; v_release_ids uuid[];
 v_context text; a jsonb; v_delivery public.deliveries%rowtype; v_child uuid; v_status text; v_key text; v_result jsonb:='[]';
BEGIN
 SELECT * INTO STRICT w FROM reda_maintenance.work WHERE id=p_work;
 SELECT * INTO STRICT r FROM reda_maintenance.runs WHERE id=w.run_id;
 IF w.status<>'claimed' THEN RETURN '[]'; END IF;
 IF r.kind<>'finish_day' OR w.manual_plan IS NULL OR w.manual_plan->>'approved_by' IS NULL
  OR r.target_date IS DISTINCT FROM public._ensure_workday(r.business_date+1)
  OR (w.manual_plan->>'target_date')::date IS DISTINCT FROM r.target_date
  OR (w.manual_plan->>'source_date')::date IS DISTINCT FROM r.business_date THEN
  RAISE EXCEPTION 'Manual approval or destination missing' USING ERRCODE='42501'; END IF;
 IF r.target_date<reda_maintenance.business_day() THEN
  RAISE EXCEPTION 'Reviewed destination is now in the past. Prepare a new operation.' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id='2d8d5895-d2a8-4900-b15e-7662b176a805'
  AND email='system@reda.local' AND role='admin' AND is_active) THEN RAISE EXCEPTION 'System actor unavailable' USING ERRCODE='42501'; END IF;
 SELECT array_agg(d.id ORDER BY d.id) INTO v_ids FROM public.deliveries d
 WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND reda_maintenance.group_key(d)=w.group_key;
 IF cardinality(v_ids)>500 THEN RAISE EXCEPTION 'This sibling group has more than 500 orders and needs manual review' USING ERRCODE='54000'; END IF;
 PERFORM public._same_customer_lock_orders(coalesce(v_ids,'{}'),'{}',false);
 PERFORM 1 FROM public.deliveries WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
 SELECT md5(coalesce(jsonb_agg(reda_maintenance.order_snapshot(d) ORDER BY d.id),'[]'::jsonb)::text)
 INTO v_context FROM public.deliveries d WHERE d.deleted_at IS NULL AND d.order_type='delivery' AND reda_maintenance.group_key(d)=w.group_key;
 IF v_context IS DISTINCT FROM w.context_revision OR EXISTS(SELECT 1 FROM public.deliveries d
   WHERE d.id IN(SELECT (o->>'id')::uuid FROM jsonb_array_elements(w.snapshot)o) AND reda_maintenance.is_held(d.id,d.updated_at)) THEN
  UPDATE reda_maintenance.work SET status='changed',completed_at=clock_timestamp(),
   result='[{"outcome":"changed","reason":"Order or sibling changed after review"}]' WHERE id=p_work;
  RETURN '[]';
 END IF;
 v_key:='maintenance:'||r.id||':'||w.revision||':';
 SELECT array_agg((x->>'id')::uuid) INTO v_release_ids FROM jsonb_array_elements(w.manual_plan->'actions')x WHERE x->>'operation'='release';
 IF cardinality(v_release_ids)>0 THEN
  PERFORM reda_maintenance.release_group(r.target_date,v_release_ids,r.target_date,w.id);
 END IF;
 -- Decisions are frozen in the reviewed plan. Releasing an overdue sibling
 -- within this same locked group cannot invalidate the other reviewed actions.
 FOR a IN SELECT value FROM jsonb_array_elements(w.manual_plan->'actions') LOOP
  SELECT * INTO STRICT v_delivery FROM public.deliveries WHERE id=(a->>'id')::uuid;
  IF a->>'operation'='release' THEN
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_delivery.id,'outcome',CASE WHEN v_delivery.current_status='pending' THEN 'released'
    WHEN v_delivery.current_status='failed_delivery' THEN 'close_policy' ELSE a->>'action' END,
    'original_date',a->>'source_date','date',v_delivery.scheduled_date,'status',v_delivery.current_status));
  ELSIF a->>'action' IN('roll','cap_unserious') THEN
   v_child:=public.rollover_delivery(v_key||v_delivery.id,v_delivery.id,r.target_date,'maintenance:manual_close',false);
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_delivery.id,'child',v_child,
    'outcome',CASE WHEN v_child IS NULL THEN 'capped' ELSE 'rolled' END,'original_date',v_delivery.scheduled_date,'date',r.target_date));
  ELSE
   v_status:=CASE WHEN a->>'action' IN('sibling_resolved','dedup_same_agent','dedup_cross_agent') THEN 'cancelled'
    WHEN a->>'action'='close_policy' THEN 'failed_delivery' WHEN a->>'action'='close_followup' THEN 'deferred_to_client'
    WHEN a->>'action'='close_disinterest' THEN 'unserious' END;
   IF v_status IS NULL THEN RAISE EXCEPTION 'Unknown reviewed action %',a->>'action'; END IF;
   PERFORM public.change_delivery_status(v_key||v_delivery.id,v_delivery.id,v_status,'maintenance:manual_'||(a->>'action'));
   IF v_delivery.current_status='postponed' AND a->>'action'='close_policy' THEN UPDATE public.deliveries SET assigned_agent_id=NULL WHERE id=v_delivery.id; END IF;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_delivery.id,'outcome',a->>'action','status',v_status));
  END IF;
 END LOOP;
 UPDATE reda_maintenance.work SET status='succeeded',completed_at=clock_timestamp(),result=v_result,error_code=NULL,error_message=NULL WHERE id=p_work;
 RETURN v_result;
END $$;

DO $$ DECLARE def text; old_text text; BEGIN
 SELECT pg_get_functiondef('reda_maintenance.process_group(bigint)'::regprocedure) INTO def;
 old_text:='IF w.status<>''claimed'' THEN RETURN ''[]''; END IF;';
 IF position(old_text IN def)=0 THEN RAISE EXCEPTION 'Worker extension point changed'; END IF;
 EXECUTE replace(def,old_text,old_text||E'\n IF r.kind=''finish_day'' THEN RETURN reda_maintenance.process_manual_group(p_work); END IF;');
 SELECT pg_get_functiondef('reda_maintenance.dispatch()'::regprocedure) INTO def;
 old_text:='AND (r.kind=''release'' OR NOT EXISTS';
 IF position(old_text IN def)=0 OR position('ORDER BY CASE WHEN r.kind=''release'' THEN 0 ELSE 1 END' IN def)=0 THEN RAISE EXCEPTION 'Dispatcher extension point changed'; END IF;
 def:=replace(def,old_text,'AND (r.kind IN(''finish_day'',''release'') OR NOT EXISTS');
 def:=replace(def,'WHERE rr.kind=''release'' AND rw.status','WHERE rr.kind IN(''finish_day'',''release'') AND rw.status');
 EXECUTE replace(def,'ORDER BY CASE WHEN r.kind=''release'' THEN 0 ELSE 1 END',
  'ORDER BY CASE r.kind WHEN ''finish_day'' THEN 0 WHEN ''release'' THEN 1 ELSE 2 END');
END $$;

-- Installed clients still call this scalar RPC. Execute the same reviewed
-- operation synchronously and atomically; never report queued work as completed.
CREATE FUNCTION reda_maintenance.legacy_manual_eod() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE v_preview jsonb; v_run uuid; w record; v_count int:=0;
 v_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
 v_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
 v_eod text:=coalesce(current_setting('reda.in_eod_rollover',true),'');
 v_run_context text:=coalesce(current_setting('reda.maintenance_run_id',true),'');
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('reda-maintenance-worker',0)) THEN
  RAISE EXCEPTION 'Order processing is busy. Retry shortly or open End of day to follow progress.' USING ERRCODE='55P03'; END IF;
 v_preview:=public.prepare_manual_eod(reda_maintenance.business_day());
 v_run:=public.request_manual_eod((v_preview->>'preview_id')::uuid);
 PERFORM set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true);
 PERFORM set_config('request.jwt.claims','{"sub":"2d8d5895-d2a8-4900-b15e-7662b176a805","role":"authenticated"}',true);
 PERFORM set_config('reda.in_eod_rollover','true',true);
 PERFORM set_config('reda.maintenance_run_id',v_run::text,true);
 FOR w IN SELECT q.id,q.status FROM reda_maintenance.work q
  JOIN reda_maintenance.previews pr ON pr.id=(v_preview->>'preview_id')::uuid
  WHERE q.run_id=v_run AND EXISTS(SELECT 1 FROM jsonb_array_elements(pr.plans)g WHERE g->>'group_key'=q.group_key AND g->>'revision'=q.revision)
  ORDER BY q.id FOR UPDATE OF q LOOP
  IF w.status IN('pending','claimed') THEN
   UPDATE reda_maintenance.work SET status='claimed',attempts=attempts+CASE WHEN status='pending' THEN 1 ELSE 0 END,claimed_at=now() WHERE id=w.id;
   PERFORM reda_maintenance.process_group(w.id);
  END IF;
  IF (SELECT status FROM reda_maintenance.work WHERE id=w.id)<>'succeeded' THEN
   RAISE EXCEPTION 'Orders changed or need review. Open End of day for a fresh preview; no partial rollover was committed.' USING ERRCODE='40001'; END IF;
  v_count:=v_count+(SELECT count(*) FROM reda_maintenance.work q,LATERAL jsonb_array_elements(q.result)e WHERE q.id=w.id AND e->>'outcome'='rolled');
 END LOOP;
 PERFORM reda_maintenance.refresh_run(v_run);
 PERFORM set_config('request.jwt.claim.sub',v_sub,true);
 PERFORM set_config('request.jwt.claims',v_claims,true);
 PERFORM set_config('reda.in_eod_rollover',v_eod,true);
 PERFORM set_config('reda.maintenance_run_id',v_run_context,true);
 RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.run_eod_rollover_all_stuck(p_reason text DEFAULT 'eod_rollover') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance SET statement_timeout='120s' AS $$
BEGIN RETURN reda_maintenance.legacy_manual_eod(); END $$;
CREATE OR REPLACE FUNCTION public.run_eod_rollover(p_for_date date DEFAULT CURRENT_DATE,p_reason text DEFAULT 'eod_rollover') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance SET statement_timeout='120s' AS $$
BEGIN
 IF p_for_date IS DISTINCT FROM reda_maintenance.business_day() THEN
  RAISE EXCEPTION 'Use recovery to preview a historical date.' USING ERRCODE='22023'; END IF;
 RETURN reda_maintenance.legacy_manual_eod();
END $$;

-- New clients confirm the actual selected dates. Keep the installed two-argument
-- assignment API intact while rejecting stale next-day selections atomically.
CREATE FUNCTION public.bulk_assign_deliveries(p_delivery_ids uuid[],p_agent_id uuid,p_expected_dates jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE v_total int;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_expected_dates IS NULL OR jsonb_typeof(p_expected_dates)<>'object' THEN RAISE EXCEPTION 'Refresh the selected orders before assigning' USING ERRCODE='22023'; END IF;
 PERFORM public._same_customer_lock_orders(p_delivery_ids,array[p_agent_id]);
 PERFORM 1 FROM public.deliveries WHERE id=ANY(p_delivery_ids) ORDER BY id FOR UPDATE;
 SELECT count(*) INTO v_total FROM public.deliveries d JOIN public.delivery_status_defs s ON s.status=d.current_status
  WHERE d.id=ANY(p_delivery_ids) AND d.deleted_at IS NULL AND s.category<>'terminal'
   AND d.scheduled_date::text=p_expected_dates->>d.id::text;
 IF v_total<>(SELECT count(DISTINCT x) FROM unnest(p_delivery_ids)x) THEN
  RAISE EXCEPTION 'An order changed date or is no longer open. Refresh the selection before assigning.' USING ERRCODE='23514'; END IF;
 RETURN public.bulk_assign_deliveries(p_delivery_ids,p_agent_id);
END $$;
REVOKE ALL ON FUNCTION public.bulk_assign_deliveries(uuid[],uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bulk_assign_deliveries(uuid[],uuid,jsonb) TO authenticated;

-- A skipped reviewed group needs attention; do not label that run a full success.
DO $$ DECLARE def text; old_text text; BEGIN
 SELECT pg_get_functiondef('reda_maintenance.refresh_run(uuid)'::regprocedure) INTO def;
 old_text:='ELSE ''succeeded'' END INTO v_status';
 IF position(old_text IN def)=0 THEN RAISE EXCEPTION 'Run status extension point changed'; END IF;
 EXECUTE replace(def,old_text,'WHEN count(*) FILTER(WHERE status=''changed'')>0 THEN ''partial'' ELSE ''succeeded'' END INTO v_status');
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reda_maintenance FROM PUBLIC,anon,authenticated,reda_maintenance_worker;
GRANT EXECUTE ON FUNCTION reda_maintenance.dispatch(),reda_maintenance.work(),reda_maintenance.monitor() TO reda_maintenance_worker;
REVOKE ALL ON FUNCTION public.prepare_manual_eod(date),public.request_manual_eod(uuid),public.manual_eod_preview_page(uuid,integer,integer),
 public.run_eod_rollover_all_stuck(text),public.run_eod_rollover(date,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.prepare_manual_eod(date),public.request_manual_eod(uuid),public.manual_eod_preview_page(uuid,integer,integer),
 public.run_eod_rollover_all_stuck(text),public.run_eod_rollover(date,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
