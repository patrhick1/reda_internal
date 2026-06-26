-- ============================================================================
-- run_eod_rollover_all_stuck — the canonical full EOD operation, run by the
-- nightly cron (scheduled-eod-check) and the in-app "Run end of day" button.
--
-- Two concerns, now FULLY DECOUPLED so neither can sink the other (2026-06-26):
--   1. Release postponed orders coming due back to the unassigned pool.
--   2. Roll every stuck date's non-terminal deliveries forward one day.
--
-- Previously both ran in one transaction: the release happened first, then the
-- per-date rollover loop. When the 2026-06-25 rollover hit a stranded waybill
-- and raised, the WHOLE transaction rolled back — silently reverting the
-- postponed release with it (14 orders due 06-26 stayed glued to their agents).
--
-- Fix: the release and EACH per-date rollover run inside their own
-- BEGIN/EXCEPTION sub-blocks. A failure in one is caught, recorded, and the
-- sweep continues; the release (and every other date) commits regardless. The
-- release is catch-up safe (release_postponed_due uses `<=`), so a failed night
-- self-heals on the next run. Failed dates are pushed to admins for visibility
-- rather than swallowed silently.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.run_eod_rollover_all_stuck(p_reason text DEFAULT 'auto_eod_cron'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_total       integer := 0;
  v_count       integer;
  v_date        date;
  v_released    integer := 0;
  v_admin       record;
  v_failed      text[] := array[]::text[];
  v_last_error  text;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'requires admin or dispatcher role' using errcode = '42501';
  end if;

  -- 1. Release postponed orders due tomorrow (and any overdue from a missed
  --    night — release_postponed_due releases `scheduled_date <= arg`). Wrapped
  --    so a release failure can't block the rollover, and vice-versa.
  begin
    v_released := public.release_postponed_due(((now() at time zone 'Africa/Lagos')::date) + 1);
  exception when others then
    v_released := 0;
    v_failed   := array_append(v_failed, 'postpone-release: ' || sqlerrm);
    raise notice 'eod: postpone-release failed: %', sqlerrm;
  end;

  -- Observability: a silent nightly state-change that pulls orders out of agents'
  -- hands deserves a trace. Tell admins how many were released (only when > 0),
  -- using the same per-admin server-side push the rollover summary uses.
  if v_released > 0 then
    for v_admin in
      select id from public.users where role = 'admin' and is_active = true
    loop
      perform public.send_edge_notification(jsonb_build_object(
        'audience', 'user',
        'user_id',  v_admin.id::text,
        'title',    'Postponed orders released',
        'body',     v_released || ' postponed order(s) came due and moved to Unassigned — assign them for today.',
        'data',     jsonb_build_object('route', 'deliveries')
      ));
    end loop;
  end if;

  -- 2. Roll each stuck date independently. One bad date is logged and skipped,
  --    not fatal — it stays non-terminal and is retried on the next sweep.
  for v_date in
    select distinct d.scheduled_date
      from public.deliveries d
      join public.delivery_status_defs s on s.status = d.current_status
     where d.scheduled_date <= current_date
       and d.deleted_at is null
       and s.category <> 'terminal'
     order by d.scheduled_date
  loop
    begin
      v_count := public.run_eod_rollover(v_date, p_reason);
      v_total := v_total + v_count;
    exception when others then
      v_last_error := sqlerrm;
      v_failed     := array_append(v_failed, v_date::text || ': ' || sqlerrm);
      raise notice 'eod: rollover for % failed: %', v_date, sqlerrm;
    end;
  end loop;

  -- 3. Surface any failures so a partial EOD never goes unnoticed.
  if cardinality(v_failed) > 0 then
    for v_admin in
      select id from public.users where role = 'admin' and is_active = true
    loop
      perform public.send_edge_notification(jsonb_build_object(
        'audience', 'user',
        'user_id',  v_admin.id::text,
        'title',    'End of day completed with errors',
        'body',     cardinality(v_failed) || ' EOD step(s) failed and were skipped: '
                    || left(array_to_string(v_failed, ' | '), 300)
                    || '. Review the EOD screen.',
        'data',     jsonb_build_object('route', 'eod')
      ));
    end loop;
  end if;

  return v_total;
end;
$function$;
