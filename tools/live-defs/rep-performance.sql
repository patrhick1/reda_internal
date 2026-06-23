-- ============================================================================
-- REP PERFORMANCE — Phase 1 read-only reporting RPCs (admin-only)
-- ============================================================================
-- Paste-and-run as ONE script in the Supabase SQL editor. Pure reads + a few
-- indexes; no writes, no schema changes to existing tables, no permission
-- changes. Safe to re-run (create or replace + create index if not exists).
--
-- What it adds:
--   * rep_activity_summary(from, to)  -> per-rep leaderboard (who's active)
--   * rep_notify_coverage(from, to)   -> team coverage / SLA panel
--   * 3 supporting indexes (calls already has caller_id,created_at)
--
-- SLA decisions (locked by Greg 2026-06-22, see rep_performance_scope.md):
--   * "Notifiable" = same set as the app's "To notify" pill -> EXCLUSION list:
--     a status transition is notifiable unless its to_status is one of
--     {pending, delivered, rolled_over, agent_cancelled, deferred_to_client,
--      unserious, picked_up, waybilled}. Mirrors NOTIFY_EXEMPT_STATUSES in
--     mobile/src/lib/theme.ts. Declared ONCE below. (Last 4 added 2026-06-23.)
--   * Grain = per status-history transition (no dedupe by delivery).
--   * Time-to-notify uses changed_at (the record time, when a rep could first
--     act), target 5 min. Admin-only (is_admin); reps/dispatchers get 42501.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Indexes (headroom + an instant live "last action" indicator). Volumes are
--    small; these keep the range scans and max(notified_at) cheap.
--    calls(caller_id, created_at DESC) already exists -> not repeated.
-- ----------------------------------------------------------------------------
create index if not exists idx_dsh_changed_at
  on public.delivery_status_history (changed_at);
create index if not exists idx_dcn_notifier_notified_at
  on public.delivery_client_notifications (notified_by_user_id, notified_at);
create index if not exists idx_dm_author_created_at
  on public.delivery_messages (author_id, created_at);

-- ----------------------------------------------------------------------------
-- 2. RPC A — rep_activity_summary: one row per active, non-test rep.
--    LEFT JOINs so idle reps still appear (Greg: "which rep to fire").
-- ----------------------------------------------------------------------------
create or replace function public.rep_activity_summary(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  rep_id         uuid,
  display_name   text,
  notifies       bigint,
  messages       bigint,
  calls          bigint,
  last_active_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
begin
  -- Admin-only. Reps/dispatchers must not see peer or self performance.
  if not coalesce(public.is_admin(), false) then
    raise exception 'not authorised to view rep performance' using errcode = '42501';
  end if;

  return query
  with reps as (
    select u.id, u.display_name
      from public.users u
     where u.role = 'rep'
       and u.is_active is true
       and u.display_name not ilike '%test%'
  ),
  n as (  -- primary KPI: client notifications authored in range
    select dcn.notified_by_user_id as rep_id,
           count(*)                as cnt,
           max(dcn.notified_at)    as last_at
      from public.delivery_client_notifications dcn
     where dcn.notified_at >= p_from and dcn.notified_at < p_to
     group by dcn.notified_by_user_id
  ),
  m as (  -- thread messages posted as a rep in range
    select dm.author_id       as rep_id,
           count(*)           as cnt,
           max(dm.created_at) as last_at
      from public.delivery_messages dm
     where dm.author_role = 'rep'
       and dm.created_at >= p_from and dm.created_at < p_to
     group by dm.author_id
  ),
  c as (  -- calls initiated in range
    select calls.caller_id       as rep_id,
           count(*)              as cnt,
           max(calls.created_at) as last_at
      from public.calls
     where calls.created_at >= p_from and calls.created_at < p_to
     group by calls.caller_id
  )
  select
    r.id,
    r.display_name,
    coalesce(n.cnt, 0)::bigint,
    coalesce(m.cnt, 0)::bigint,
    coalesce(c.cnt, 0)::bigint,
    -- greatest() returns the largest non-null arg; NULL only when fully idle.
    greatest(n.last_at, m.last_at, c.last_at)
  from reps r
  left join n on n.rep_id = r.id
  left join m on m.rep_id = r.id
  left join c on c.rep_id = r.id
  order by coalesce(n.cnt, 0) desc,
           greatest(n.last_at, m.last_at, c.last_at) desc nulls last,
           r.display_name;
end;
$function$;

grant execute on function public.rep_activity_summary(timestamptz, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. RPC B — rep_notify_coverage: single team-wide SLA row.
-- ----------------------------------------------------------------------------
create or replace function public.rep_notify_coverage(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  notifiable_updates             bigint,
  notified                       bigint,
  pct_notified                   numeric,
  not_notified                   bigint,
  median_minutes_to_notify       numeric,
  backlog_open                   bigint,
  oldest_open_update_age_minutes numeric,
  last_team_notify_at            timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
declare
  -- SINGLE source of truth, mirrors mobile/src/lib/theme.ts NOTIFY_EXEMPT_STATUSES.
  -- A transition is notifiable when its to_status is NOT in this set (exclusion
  -- list -> any new customer-facing status auto-qualifies).
  -- deferred_to_client/unserious/picked_up/waybilled added 2026-06-23 (Uzo): these
  -- terminal outcomes are exempt from the "To notify" pill, so drop them here too.
  k_notify_exempt constant text[] := array[
    'pending','delivered','rolled_over','agent_cancelled',
    'deferred_to_client','unserious','picked_up','waybilled'];
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'not authorised to view rep performance' using errcode = '42501';
  end if;

  return query
  with notifiable as (  -- one row PER TRANSITION in range (no dedupe by delivery)
    select dsh.id as status_history_id, dsh.delivery_id, dsh.changed_at
      from public.delivery_status_history dsh
      join public.deliveries d on d.id = dsh.delivery_id and d.deleted_at is null
     where dsh.changed_at >= p_from and dsh.changed_at < p_to
       and dsh.to_status <> all (k_notify_exempt)
  ),
  joined as (
    select nf.status_history_id, nf.delivery_id, nf.changed_at, dcn.notified_at,
           case when dcn.notified_at is not null
                then extract(epoch from (dcn.notified_at - nf.changed_at)) / 60.0
           end as minutes_to_notify
      from notifiable nf
      left join public.delivery_client_notifications dcn
             on dcn.status_history_id = nf.status_history_id
  ),
  agg as (
    select count(*)                                          as notifiable_updates,
           count(j.notified_at)                              as notified,
           count(*) filter (where j.notified_at is null)     as not_notified,
           percentile_cont(0.5) within group (order by j.minutes_to_notify)
             filter (where j.notified_at is not null)        as median_minutes
      from joined j
  ),
  -- Backlog is the live "still waiting" list, mirroring the "To notify" pill
  -- (awaitsClientNotification): a delivery is waiting when its CURRENT status is
  -- notifiable (non-exempt, non-terminal) and its LATEST history row is still
  -- un-notified. Per-delivery on the latest row — superseded older un-notified
  -- transitions do NOT count, so the alarm matches what reps actually see.
  -- Intentionally ALL-TIME (ignores the range) so it reflects current open work
  -- regardless of the selected date filter.
  backlog as (
    select count(*) as backlog_open,
           extract(epoch from (now() - min(lh.changed_at))) / 60.0 as oldest_open_age_min
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
      join lateral (
        select h.id, h.changed_at
          from public.delivery_status_history h
         where h.delivery_id = d.id
         order by h.changed_at desc
         limit 1
      ) lh on true
      left join public.delivery_client_notifications dcn on dcn.status_history_id = lh.id
     where d.deleted_at is null
       and sd.category <> 'terminal'
       and d.current_status <> all (k_notify_exempt)
       and dcn.status_history_id is null
  )
  select
    agg.notifiable_updates,
    agg.notified,
    case when agg.notifiable_updates = 0 then 0::numeric
         else round(100.0 * agg.notified / agg.notifiable_updates, 1) end,
    agg.not_notified,
    round(agg.median_minutes::numeric, 1),
    backlog.backlog_open,
    round(backlog.oldest_open_age_min::numeric, 1),
    (select max(dcn2.notified_at) from public.delivery_client_notifications dcn2)
  from agg, backlog;
end;
$function$;

grant execute on function public.rep_notify_coverage(timestamptz, timestamptz) to authenticated;

commit;
