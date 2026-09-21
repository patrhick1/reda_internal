-- Installed disabled. Schedule cutover is a separate, tested deployment step.
BEGIN;
CREATE SCHEMA IF NOT EXISTS reda_maintenance;
REVOKE ALL ON SCHEMA reda_maintenance FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA reda_maintenance REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='reda_maintenance_worker') THEN
    CREATE ROLE reda_maintenance_worker NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA reda_maintenance TO reda_maintenance_worker;

CREATE TABLE reda_maintenance.settings(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  batch_size integer NOT NULL DEFAULT 100 CHECK(batch_size BETWEEN 1 AND 500),
  budget_seconds integer NOT NULL DEFAULT 12 CHECK(budget_seconds BETWEEN 1 AND 20),
  retry_limit integer NOT NULL DEFAULT 3 CHECK(retry_limit BETWEEN 1 AND 10),
  dispatch_at timestamptz, worker_at timestamptz, monitor_at timestamptz,
  reconciled_day date,
  version text NOT NULL DEFAULT '20260921.1'
);
INSERT INTO reda_maintenance.settings DEFAULT VALUES;

CREATE TABLE reda_maintenance.runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN('release','close')),
  business_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','succeeded','partial','failed')),
  requested_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version text NOT NULL DEFAULT '20260921.1',
  outcomes jsonb NOT NULL DEFAULT '{}',
  UNIQUE(kind,business_date)
);
CREATE TABLE reda_maintenance.work(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES reda_maintenance.runs(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  revision text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='array'),
  context_revision text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','claimed','succeeded','changed','held','failed')),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_code text, error_message text,
  result jsonb,
  UNIQUE(run_id,group_key,revision)
);
CREATE INDEX maintenance_work_ready ON reda_maintenance.work(retry_at,id) WHERE status='pending';
CREATE INDEX maintenance_work_claimed ON reda_maintenance.work(claimed_at,id) WHERE status='claimed';
CREATE INDEX maintenance_work_run ON reda_maintenance.work(run_id,status);

CREATE TABLE reda_maintenance.holds(
  delivery_id uuid PRIMARY KEY REFERENCES public.deliveries(id) ON DELETE CASCADE,
  expected_updated_at timestamptz NOT NULL,
  reason text NOT NULL,
  related_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.users(id),
  resolution text
);

CREATE TABLE reda_maintenance.outbox(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid REFERENCES reda_maintenance.runs(id) ON DELETE SET NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  event_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','submitted','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  request_id bigint,
  retry_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz, sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_outbox_ready ON reda_maintenance.outbox(retry_at,id) WHERE status IN('pending','submitted');

CREATE TABLE reda_maintenance.alerts(
  key text PRIMARY KEY,
  severity text NOT NULL CHECK(severity IN('error','attention')),
  message text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE reda_maintenance.previews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor uuid NOT NULL REFERENCES public.users(id),
 kind text NOT NULL, business_date date NOT NULL, plans jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, run_id uuid
);

CREATE OR REPLACE FUNCTION reda_maintenance.business_day(p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql STABLE AS $$ SELECT (p_at AT TIME ZONE 'Africa/Lagos')::date $$;
CREATE OR REPLACE FUNCTION reda_maintenance.close_through(p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql STABLE AS $$
 SELECT (p_at AT TIME ZONE 'Africa/Lagos')::date
  - CASE WHEN (p_at AT TIME ZONE 'Africa/Lagos')::time>=TIME '23:59' THEN 0 ELSE 1 END
$$;
CREATE OR REPLACE FUNCTION reda_maintenance.release_through(p_at timestamptz DEFAULT now())
RETURNS date LANGUAGE sql STABLE AS $$
 SELECT (p_at AT TIME ZONE 'Africa/Lagos')::date
  + CASE WHEN (p_at AT TIME ZONE 'Africa/Lagos')::time>=TIME '23:59' THEN 1 ELSE 0 END
$$;
CREATE OR REPLACE FUNCTION reda_maintenance.group_key(p_phone text,p_items text,p_product uuid,p_date date,p_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN p_phone IS NULL THEN 'id:'||p_id
 ELSE p_phone||'|'||coalesce(p_items,p_product::text,'')||'|'||(p_date-date '2000-01-01')::text END
$$;
CREATE OR REPLACE FUNCTION reda_maintenance.group_key(d public.deliveries)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT reda_maintenance.group_key(d.customer_phone_normalized,d.items_fingerprint,d.product_catalog_id,d.scheduled_date,d.id)
$$;
CREATE INDEX deliveries_maintenance_group ON public.deliveries((CASE WHEN customer_phone_normalized IS NULL THEN 'id:'||id
 ELSE customer_phone_normalized||'|'||coalesce(items_fingerprint,product_catalog_id::text,'')||'|'||(scheduled_date-date '2000-01-01')::text END))
 WHERE deleted_at IS NULL AND order_type='delivery';
CREATE OR REPLACE FUNCTION reda_maintenance.is_held(p_id uuid,p_updated_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,reda_maintenance AS $$
 SELECT EXISTS(SELECT 1 FROM reda_maintenance.holds WHERE delivery_id=p_id
   AND resolved_at IS NULL AND expected_updated_at=p_updated_at)
$$;

CREATE OR REPLACE FUNCTION reda_maintenance.order_snapshot(d public.deliveries)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
 SELECT jsonb_build_object('id',d.id,'status',d.current_status,'date',d.scheduled_date,
  'row_revision',md5(to_jsonb(d)::text),
  'updated_at',d.updated_at,'agent_id',d.assigned_agent_id,'carry',d.rollover_count,
  'policy',(SELECT auto_cancel_soft_fails FROM public.clients WHERE id=d.client_id),
  'message_at',(SELECT max(created_at) FROM public.delivery_messages WHERE delivery_id=d.id),
  'history_at',(SELECT max(changed_at) FROM public.delivery_status_history WHERE delivery_id=d.id))
$$;

CREATE OR REPLACE FUNCTION reda_maintenance.plans(p_kind text,p_date date)
RETURNS TABLE(group_key text,revision text,snapshot jsonb,context_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance SET timezone='UTC' AS $$
 WITH groups AS (
  SELECT reda_maintenance.group_key(d) AS key,
    jsonb_agg(reda_maintenance.order_snapshot(d) ORDER BY d.id) AS snapshot
  FROM public.deliveries d JOIN public.delivery_status_defs sd ON sd.status=d.current_status
  JOIN public.clients cl ON cl.id=d.client_id
  WHERE d.deleted_at IS NULL AND d.order_type='delivery'
   AND NOT reda_maintenance.is_held(d.id,d.updated_at)
   AND NOT EXISTS(SELECT 1 FROM public.deliveries child WHERE child.parent_delivery_id=d.id AND child.created_via='rollover')
   AND ((p_kind='release' AND d.current_status='postponed' AND d.scheduled_date<=p_date)
     OR (p_kind='close' AND sd.category<>'terminal' AND (d.current_status<>'postponed' OR cl.auto_cancel_soft_fails) AND
       (d.scheduled_date=p_date OR (d.current_status='postponed' AND cl.auto_cancel_soft_fails
         AND d.updated_at<((p_date+1)::timestamp AT TIME ZONE 'Africa/Lagos')))))
  GROUP BY reda_maintenance.group_key(d)
 )
 SELECT key,md5(snapshot::text),snapshot,
  (SELECT md5(coalesce(jsonb_agg(reda_maintenance.order_snapshot(c) ORDER BY c.id),'[]'::jsonb)::text)
   FROM public.deliveries c WHERE c.deleted_at IS NULL AND c.order_type='delivery' AND reda_maintenance.group_key(c)=groups.key)
 FROM groups
$$;

CREATE OR REPLACE FUNCTION reda_maintenance.enqueue(p_kind text,p_date date,p_actor uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance SET timezone='UTC' AS $$
DECLARE v_run uuid; v_added integer;
BEGIN
 IF p_kind NOT IN('release','close') OR p_date IS NULL THEN RAISE EXCEPTION 'Invalid maintenance operation'; END IF;
 IF (p_kind='close' AND p_date>reda_maintenance.close_through())
   OR (p_kind='release' AND p_date>reda_maintenance.release_through()) THEN
   RAISE EXCEPTION 'Requested maintenance date is not due yet' USING ERRCODE='22023';
 END IF;
 INSERT INTO reda_maintenance.runs(kind,business_date,requested_by) VALUES(p_kind,p_date,p_actor)
 ON CONFLICT(kind,business_date) DO NOTHING;
 SELECT id INTO v_run FROM reda_maintenance.runs WHERE kind=p_kind AND business_date=p_date FOR UPDATE;
 INSERT INTO reda_maintenance.work(run_id,group_key,revision,snapshot,context_revision)
 SELECT v_run,p.* FROM reda_maintenance.plans(p_kind,p_date) p
 ON CONFLICT(run_id,group_key,revision) DO NOTHING;
 GET DIAGNOSTICS v_added=ROW_COUNT;
 IF v_added>0 THEN
   UPDATE reda_maintenance.runs SET status='pending',completed_at=NULL,updated_at=now() WHERE id=v_run;
 ELSIF NOT EXISTS(SELECT 1 FROM reda_maintenance.work WHERE run_id=v_run) THEN
   UPDATE reda_maintenance.runs SET status='succeeded',completed_at=now(),updated_at=now() WHERE id=v_run;
 END IF;
 RETURN v_run;
END $$;

CREATE OR REPLACE FUNCTION reda_maintenance.queue_notification(p_body jsonb,p_key text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,reda_maintenance AS $$
DECLARE v_run uuid:=nullif(current_setting('reda.maintenance_run_id',true),'')::uuid;
 v_key text; v_payload jsonb:=p_body;
BEGIN
 -- Nightly terminal status pushes are summarized in the completed run instead
 -- of generating a separate admin notification for every automatically closed row.
 IF v_run IS NOT NULL AND p_body->>'audience'='status_change' THEN RETURN; END IF;
 IF v_run IS NOT NULL AND p_body->>'title'='Order moved to the queue' AND p_body->>'audience'='user' THEN
  v_key:='assignment-loss:'||v_run||':'||(p_body->>'user_id');
  v_payload:=jsonb_build_object('audience','user','user_id',p_body->>'user_id',
    'title','Orders returned to the queue','body','An order moved to Unassigned during scheduled processing.',
    'data',jsonb_build_object('route','deliveries'));
  INSERT INTO reda_maintenance.outbox(run_id,dedupe_key,payload) VALUES(v_run,v_key,v_payload)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    event_count=CASE WHEN reda_maintenance.outbox.status IN('sent','submitted') THEN 1 ELSE reda_maintenance.outbox.event_count+1 END,
    status='pending',attempts=0,
    payload=jsonb_set(EXCLUDED.payload,'{body}',to_jsonb((CASE WHEN reda_maintenance.outbox.status IN('sent','submitted') THEN 1 ELSE reda_maintenance.outbox.event_count+1 END)::text||' orders moved to Unassigned during scheduled processing.'));
 ELSE
  v_key:=coalesce(p_key,coalesce(v_run::text,'system')||':'||md5(p_body::text));
  INSERT INTO reda_maintenance.outbox(run_id,dedupe_key,payload) VALUES(v_run,v_key,v_payload) ON CONFLICT(dedupe_key) DO NOTHING;
 END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA reda_maintenance FROM PUBLIC,anon,authenticated,reda_maintenance_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reda_maintenance FROM PUBLIC,anon,authenticated,reda_maintenance_worker;
COMMIT;
