BEGIN;
-- Deliberately returns no order, user, failure-message or credential data.
-- An external uptime probe can detect a dead server as well as stale cron jobs.
CREATE OR REPLACE FUNCTION public.maintenance_heartbeat() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,reda_maintenance AS $$
 SELECT jsonb_build_object('healthy',coalesce(enabled AND dispatch_at>now()-interval '10 minutes'
   AND worker_at>now()-interval '10 minutes' AND monitor_at>now()-interval '15 minutes'
   AND NOT EXISTS(SELECT 1 FROM reda_maintenance.alerts WHERE severity='error' AND resolved_at IS NULL),false),
   'checked_at',now(),'version',version) FROM reda_maintenance.settings WHERE singleton
$$;
REVOKE ALL ON FUNCTION public.maintenance_heartbeat() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maintenance_heartbeat() TO anon,authenticated;
COMMIT;
