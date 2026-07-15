-- ops_unread_agent_counts — grouped per-delivery unread counts for the ops
-- "agent replied" chip on the shared deliveries list (admin / dispatcher / rep)
-- and the rep dashboard.
--
-- WHY (Supabase egress audit, findings 7 + 8 / Phase 4.1). The mobile
-- opsUnreadAgentCounts() selected one ROW per unread agent message
-- (`delivery_id, issue_type, deliveries!inner(current_status)`) and grouped them
-- into a Map in JavaScript. Measured on live data 2026-07-15:
--
--   unread agent msgs shipped per call ... 1,122 rows  (~155 kB)
--   after terminal filter only ..........     56 rows
--   after auto-seeded filter only .......     62 rows
--   after BOTH — what the badge shows ...      2 rows  (1 delivery)
--
-- i.e. ~94% of the payload is `cant_reach_client` (1,060 rows) — auto-seeded
-- soft-fail notes the app fetches and then explicitly discards — and most of the
-- rest sit on terminal deliveries. 155 kB over the wire to render ONE badge.
-- This function applies the same three filters in Postgres and returns only
-- `(delivery_id, unread_count)`.
--
-- SECURITY: SECURITY INVOKER (not DEFINER) — deliberate. It reproduces the
-- current PostgREST semantics EXACTLY, because the caller's RLS applies to both
-- joined tables just as it does today:
--   * delivery_messages_select_participants — is_admin_or_dispatcher()
--     (admin/dispatcher/rep) OR author_id = auth.uid() OR the row's delivery is
--     assigned to the caller.
--   * deliveries_select_role_scoped — is_admin_or_dispatcher() OR
--     assigned_agent_id = auth.uid().
-- So no new role gate is needed and no privilege is escalated: an agent calling
-- this still sees only their own rows, exactly as the old query behaved. (The
-- app only calls it for the ops set — this is defence in depth.)
--
-- TERMINAL SET: derived by joining delivery_status_defs (category = 'terminal')
-- rather than hardcoding a status list. Verified 2026-07-15 to match the app's
-- TERMINAL_STATUSES (theme.ts: STATUS_GROUPS.done + .closed) EXACTLY — all 11:
-- abandoned, agent_cancelled, cancelled, deferred_to_client, delivered,
-- failed_delivery, not_around, picked_up, rolled_over, unserious, waybilled.
-- Deriving it means a status reclassification (as with not_around and
-- picked_up/waybilled) can never silently desync this function.
-- delivery_status_defs is world-readable (policy delivery_status_defs_select_all,
-- qual = true), so the join is safe under SECURITY INVOKER — if it were not, the
-- NOT EXISTS would match nothing and every status would read as non-terminal,
-- over-showing badges.
--
-- AUTO-SEEDED: `cant_reach_client` is the only value of the app's
-- STATUS_AUTO_ISSUE map (not_answering / not_available / not_connecting /
-- number_busy / switched_off all map to it), so AUTO_SEEDED_ISSUE_TYPES ==
-- {'cant_reach_client'}. The app DERIVES that set from STATUS_AUTO_ISSUE; this
-- function must hardcode it. !! If STATUS_AUTO_ISSUE ever gains a new issue
-- type, update the literal below or the two surfaces will disagree. !!
-- A NULL issue_type is a plain reply and MUST count (deliberate agent contact).
--
-- p_exclude_not_my_route: reps don't handle 'not my route' (an admin/dispatcher
--   reassign job), so their chip excludes it. See not_my_route_admin_only.sql.
--   Admins/dispatchers pass false → still see it.
--
-- DELIBERATELY NOT DATE-SCOPED, matching the old query. A date param was
-- considered and rejected: the list merges CROSS-DATE rows into what's on screen
-- (a postponed order appears in "All" on its postpone day while its
-- scheduled_date has already been bumped FORWARD, and the Unassigned chip is
-- date-independent by design), and the chip is `allRows ∩ map`. Scoping the map
-- to the viewed date would silently strip those rows' chips. It would also buy
-- nothing: the terminal + auto-seeded filters already take 1,122 rows → 1.
create or replace function public.ops_unread_agent_counts(
  p_exclude_not_my_route boolean default false
)
returns table (delivery_id uuid, unread_count bigint)
language sql
stable
security invoker
set search_path to 'public', 'auth'
as $function$
  select dm.delivery_id, count(*)::bigint as unread_count
  from public.delivery_messages dm
  join public.deliveries d on d.id = dm.delivery_id
  where dm.author_role = 'agent'
    and dm.read_at is null
    -- parent delivery still open (see TERMINAL SET above)
    and not exists (
      select 1
      from public.delivery_status_defs sd
      where sd.status = d.current_status
        and sd.category = 'terminal'
    )
    -- deliberate contact only: a plain reply (null) or an actionable flag
    and (dm.issue_type is null or dm.issue_type <> 'cant_reach_client')
    -- reps: drop the reassign-only flag
    and (not p_exclude_not_my_route or dm.issue_type is distinct from 'not_my_route')
  group by dm.delivery_id;
$function$;

grant execute on function public.ops_unread_agent_counts(boolean)
  to authenticated, service_role;
