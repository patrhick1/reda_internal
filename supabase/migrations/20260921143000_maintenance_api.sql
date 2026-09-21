BEGIN;
CREATE OR REPLACE FUNCTION public.prepare_maintenance(p_kind text,p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE v_id uuid; v_plans jsonb; v_all jsonb; v_rows jsonb; v_total int; v_oversized int;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN('release','close') OR p_date IS NULL OR
  (p_kind='release' AND p_date>reda_maintenance.release_through()) OR
  (p_kind='close' AND p_date>reda_maintenance.close_through()) THEN
  RAISE EXCEPTION 'This operation/date is not due yet. Today can only close after 23:59 Lagos.' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY group_key),'[]') INTO v_all FROM reda_maintenance.plans(p_kind,p_date)p;
 SELECT coalesce(sum(jsonb_array_length(p->'snapshot')),0),count(*) FILTER(WHERE jsonb_array_length(p->'snapshot')>500)
 INTO v_total,v_oversized FROM jsonb_array_elements(v_all)p;
 -- Keep the review and network payload bounded without splitting a sibling group.
 SELECT coalesce(jsonb_agg(p ORDER BY p->>'group_key'),'[]') INTO v_plans FROM (
  SELECT p,sum(jsonb_array_length(p->'snapshot')) OVER(ORDER BY p->>'group_key') running_count
  FROM jsonb_array_elements(v_all)p WHERE jsonb_array_length(p->'snapshot')<=500
 ) limited WHERE running_count<=500;
 INSERT INTO reda_maintenance.previews(actor,kind,business_date,plans) VALUES(auth.uid(),p_kind,p_date,v_plans) RETURNING id INTO v_id;
 WITH candidates AS (
  SELECT (o->>'id')::uuid id FROM jsonb_array_elements(v_plans) g,LATERAL jsonb_array_elements(g->'snapshot')o
 ), classified AS (
  SELECT * FROM reda_maintenance.classify(p_date,ARRAY(SELECT id FROM candidates)) WHERE p_kind='close'
 ), releases AS (
  SELECT * FROM reda_maintenance.release_actions(p_date,ARRAY(SELECT id FROM candidates)) WHERE p_kind='release'
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'customer_name',d.customer_name,'status',d.current_status,
   'date',d.scheduled_date,'agent',u.display_name,'carry',d.rollover_count,
   'action',CASE WHEN p_kind='release' THEN rel.action ELSE cl.action END
   ) ORDER BY d.scheduled_date,d.customer_name),'[]') INTO v_rows
 FROM candidates e JOIN public.deliveries d ON d.id=e.id JOIN public.clients c ON c.id=d.client_id
 LEFT JOIN public.users u ON u.id=d.assigned_agent_id LEFT JOIN classified cl ON cl.delivery_id=d.id
 LEFT JOIN releases rel ON rel.delivery_id=d.id;
 RETURN jsonb_build_object('preview_id',v_id,'kind',p_kind,'date',p_date,'rows',v_rows,
  'total_orders',v_total,'oversized_groups',v_oversized,'expires_at',now()+interval '30 minutes');
END $$;

CREATE OR REPLACE FUNCTION public.request_maintenance(p_preview_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE p reda_maintenance.previews%rowtype; v_run uuid;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM reda_maintenance.previews WHERE id=p_preview_id AND actor=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preview not found' USING ERRCODE='22023'; END IF;
 IF p.submitted_at IS NOT NULL THEN RETURN p.run_id; END IF;
 IF p.created_at<now()-interval '30 minutes' THEN RAISE EXCEPTION 'Preview expired. Refresh before submitting.' USING ERRCODE='22023'; END IF;
 IF NOT (SELECT enabled FROM reda_maintenance.settings WHERE singleton) THEN
  RAISE EXCEPTION 'Maintenance is disabled; contact an administrator' USING ERRCODE='55000'; END IF;
 INSERT INTO reda_maintenance.runs(kind,business_date,requested_by) VALUES(p.kind,p.business_date,auth.uid())
 ON CONFLICT(kind,business_date) DO NOTHING;
 SELECT id INTO v_run FROM reda_maintenance.runs WHERE kind=p.kind AND business_date=p.business_date FOR UPDATE;
 INSERT INTO reda_maintenance.work(run_id,group_key,revision,snapshot,context_revision)
 SELECT v_run,g->>'group_key',g->>'revision',g->'snapshot',g->>'context_revision' FROM jsonb_array_elements(p.plans)g
 ON CONFLICT(run_id,group_key,revision) DO NOTHING;
 UPDATE reda_maintenance.runs SET status='pending',completed_at=NULL,updated_at=now() WHERE id=v_run;
 UPDATE reda_maintenance.previews SET submitted_at=now(),run_id=v_run WHERE id=p.id;
 RETURN v_run;
END $$;

CREATE OR REPLACE FUNCTION public.maintenance_health() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE result jsonb;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('enabled',s.enabled,'today',reda_maintenance.business_day(),
  'close_through',reda_maintenance.close_through(),'release_through',reda_maintenance.release_through(),
  'dispatch_at',s.dispatch_at,'worker_at',s.worker_at,'monitor_at',s.monitor_at,
  'runs',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT r.*,
   (SELECT count(*) FROM reda_maintenance.work w WHERE w.run_id=r.id AND status IN('pending','claimed')) AS remaining_groups,
   (SELECT count(*) FROM reda_maintenance.work w WHERE w.run_id=r.id AND status='failed') AS failed_groups,
   (SELECT count(*) FROM reda_maintenance.work w WHERE w.run_id=r.id AND status='changed') AS changed_groups
   FROM reda_maintenance.runs r ORDER BY business_date DESC,created_at DESC LIMIT 20)r),'[]'),
  'alerts',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM reda_maintenance.alerts a WHERE resolved_at IS NULL),'[]'),
  'failures',coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM (SELECT w.id,w.run_id,w.status,w.attempts,w.error_code,w.error_message,
   jsonb_array_length(w.snapshot) AS member_count,
   ARRAY(SELECT e->>'id' FROM jsonb_array_elements(w.snapshot)e LIMIT 50) AS delivery_ids
   FROM reda_maintenance.work w WHERE status IN('failed','changed') ORDER BY w.id DESC LIMIT 100)f),'[]'),
  'holds',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'customer_name',d.customer_name,'date',d.scheduled_date,'reason',h.reason))
    FROM reda_maintenance.holds h JOIN public.deliveries d ON d.id=h.delivery_id
    WHERE h.resolved_at IS NULL AND h.expected_updated_at=d.updated_at),'[]'),
  'notification_failures',(SELECT count(*) FROM reda_maintenance.outbox WHERE status='failed')) INTO result
 FROM reda_maintenance.settings s WHERE singleton;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.retry_maintenance_group(p_work_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE w reda_maintenance.work%rowtype;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO w FROM reda_maintenance.work WHERE id=p_work_id FOR UPDATE;
 IF NOT FOUND OR w.status<>'failed' THEN RAISE EXCEPTION 'Only a failed group can be retried' USING ERRCODE='22023'; END IF;
 UPDATE reda_maintenance.work SET status='pending',attempts=0,retry_at=now(),completed_at=NULL WHERE id=w.id;
 UPDATE reda_maintenance.runs SET status='pending',completed_at=NULL WHERE id=w.run_id;
 PERFORM public.write_audit('maintenance',w.run_id,jsonb_build_object('status',w.status),
  jsonb_build_object('status','pending','work_id',w.id),'manual_retry',auth.uid());
END $$;

CREATE OR REPLACE FUNCTION public.resolve_maintenance_hold(p_delivery_id uuid,p_resolution text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF nullif(btrim(p_resolution),'') IS NULL THEN RAISE EXCEPTION 'A review note is required' USING ERRCODE='22023'; END IF;
 UPDATE reda_maintenance.holds SET resolved_at=now(),resolved_by=auth.uid(),resolution=p_resolution
 WHERE delivery_id=p_delivery_id AND resolved_at IS NULL;
 PERFORM public.write_audit('delivery',p_delivery_id,'{}',jsonb_build_object('maintenance_hold','resolved'),p_resolution,auth.uid());
END $$;

-- Old RPCs return a scalar count and cannot describe queued/partial work.
-- Fail explicitly rather than return a misleading zero or close today's work.
CREATE OR REPLACE FUNCTION public.run_eod_rollover(p_for_date date DEFAULT CURRENT_DATE,p_reason text DEFAULT 'eod_rollover')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Use the updated End of day screen to preview and queue a release or close-day operation.' USING ERRCODE='22023'; END $$;
CREATE OR REPLACE FUNCTION public.run_eod_rollover_all_stuck(p_reason text DEFAULT 'eod_rollover')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Use the updated End of day screen. Broad all-date recovery has been replaced with explicit, safe date scopes.' USING ERRCODE='22023'; END $$;
CREATE OR REPLACE FUNCTION public.release_postponed_due(p_due_date date DEFAULT ((now() AT TIME ZONE 'Africa/Lagos')::date + 1))
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Use the updated End of day screen to preview and queue due releases.' USING ERRCODE='22023'; END $$;

REVOKE ALL ON FUNCTION public.prepare_maintenance(text,date),public.request_maintenance(uuid),public.maintenance_health(),
 public.retry_maintenance_group(bigint),public.resolve_maintenance_hold(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.prepare_maintenance(text,date),public.request_maintenance(uuid),public.maintenance_health(),
 public.retry_maintenance_group(bigint),public.resolve_maintenance_hold(uuid,text) TO authenticated;
COMMIT;
