# Scope — Rep Performance Tracking

> Trello "Tracking Rep Performance" (Greg Uzo, To work on). "Is there a way we can
> use the app to track rep performance? Let us know which rep is active and which rep
> to fire… no rep dropped any update for a client from 12:12–12:42pm… only one rep has
> been the one notifying clients since."

## 1. Context & the real question

Greg wants to see, from the app: **which reps are actually working** (notifying clients
about their orders) and **whether the team is keeping up** (or dropping updates for
30-minute stretches). This is a measurement/reporting feature — no change to how reps work.

**What a "rep" is in Reda** (confirmed in `mobile/src/lib/permissions.ts` + live DB): reps
are stock-less ops who **cannot edit orders or change delivery status** (manager-only since
2026-06-10). Their job is **comms + follow-ups**. The concrete, logged thing a rep does that
Greg calls "dropping an update for a client" is **marking a client notified** — tapping the
"I've told the vendor on WhatsApp about this status" control, which writes a row to
`delivery_client_notifications` against a specific status-history row.

So "rep performance" ≈ **how much, how fast, and how completely reps notify clients of order
status updates** — plus their thread messages and calls as supporting signals.

## 2. Findings from live data (7-day window) — the metrics already exist

These come straight from the live DB and validate the request; they're also exactly the
numbers the feature should surface:

- **Notifications are a clean rep signal:** 532 of 533 `delivery_client_notifications` rows
  were authored by reps (1 by a dispatcher). 525 in the last 14 days.
- **Severe imbalance (Greg's "only one rep"):** last 7 days — **Joshua 252**, Moyo 113,
  Joan 96, Adetunji 53, Test Rep 5. One rep is doing ~half the work.
- **Coverage gap (Greg's "dropped updates"):** of **893** customer-meaningful status updates
  (transitions into active/soft-fail statuses) in 7 days, only **488 (54.6%) were notified to
  the client → 405 were never communicated.**
- **Speed:** median time-to-notify **3.7 min**, average **18.7 min** (a long tail).
- **Silence windows are real:** multiple business-hours (09:00–18:00 Lagos) gaps of **31–48
  min** between consecutive rep actions, plus one 3h22m gap — i.e. Greg's 30-minute window is
  a recurring pattern, not a one-off.

> **Baseline recomputed 2026-06-22 (Phase 1 build) against the LOCKED broader denominator.**
> The 54.6% above used the narrower active+soft set and pre-dates the **2026-06-21 deliveries
> wipe** — it is no longer comparable. On current post-wipe data the RPCs report (last 7d):
> **94.5–94.8% coverage** (≈343/362 notifiable transitions notified), **median 2.1 min** to
> notify, **~11–12 open backlog** items. `delivery_status_history` only goes back to 2026-06-21,
> so the tool is forward-looking — historical comparison to the 54.6% is apples-to-oranges.
> Leaderboard (last 7d): Joshua 136, Moyo 85, Joan 75, Adetunji 45 (Test Rep excluded). Numbers
> drift live; these were a point-in-time read while validating the RPCs.

## 3. What to measure (two lenses)

### Lens A — Per-rep activity ("who's active / who to fire")
A leaderboard over a chosen date range, per active rep:
- **Client notifications** (primary KPI) — count + trend.
- **Thread messages** posted, **calls** initiated.
- **Last active** (max timestamp across the above) → "idle for N min/hours".
- A small **per-day sparkline / hourly bars** so an idle rep or an over-relied-on rep (the
  Joshua case) is obvious at a glance.

### Lens B — Team coverage / SLA ("are we dropping the ball")
A top-of-screen health panel for a date range (default today):
- **Notifiable updates**, **% notified**, **# un-notified (backlog)**.
- **Oldest un-notified update age** (the "this order's status changed 40 min ago and no rep
  has told the client" alarm).
- **Median time-to-notify**.
- A **live indicator**: "last team notification N min ago" — turns red past a threshold
  (this is the direct answer to "no one dropped an update for 30 minutes").

## 4. Data model (read-only; signals already captured)

| Signal | Table | (rep) | (time) | (delivery) | Notes |
|---|---|---|---|---|---|
| ★ Client notified | `delivery_client_notifications` | `notified_by_user_id` | `notified_at` | `delivery_id`, `status_history_id` | THE primary KPI; 99.8% rep-authored |
| Thread message | `delivery_messages` | `author_id` (+`author_role='rep'`) | `created_at` | `delivery_id` | replies/notes/flags |
| Call | `calls` | `caller_id` | `created_at` | `related_delivery_id` | low volume today |
| Status update (denominator) | `delivery_status_history` | `changed_by_user_id` (agent) | `effective_at` | `delivery_id`, `to_status` | the update a rep is meant to communicate |

- **"Notifiable" definition (LOCKED by Greg 2026-06-22):** tie the SLA denominator to the
  **same predicate that drives the "To notify" pill** — `awaitsClientNotification` in
  `mobile/src/lib/theme.ts`. That is an **exclusion list**: a status update is notifiable
  unless its `to_status` is one of `NOTIFY_EXEMPT_STATUSES` = `{pending, delivered,
  rolled_over, agent_cancelled}`. So notifiable = available, available_evening, every
  soft-fail, **and every non-delivered terminal** (cancelled, failed_delivery, no_product,
  abandoned, deferred_to_client, unserious, picked_up, waybilled). The backend RPC must mirror
  this exact exempt set (read it from one shared source of truth so the metric and the pill can
  never drift apart). **Implication:** this is broader than the original "active + soft_failure"
  proposal, so the coverage % will not match the 54.6% measured in §2 (that used the narrower
  set) — recompute against the new denominator before quoting a baseline to Greg.
  - **Measurement grain:** per **status-history transition** (each notifiable transition is one
    event that should get a `delivery_client_notifications` row within the target window). This
    matches how notifications are keyed (`status_history_id`) and faithfully measures "an update
    was dropped." The pill is just the per-current-row surface of the same predicate.
- `delivery_followups` is currently **empty** — not a usable signal yet; ignore for v1.
- **Honest limitation:** `delivery_client_notifications` records the rep's *claim* that they
  messaged the vendor on WhatsApp (a tap), not the actual WhatsApp send. It's the best proxy
  available and matches how the team already works, but it can be gamed by tapping without
  messaging. Worth stating on the screen / to Greg.

## 5. Backend (new, admin-only)

All new RPCs are `SECURITY DEFINER`, `search_path = public, auth`, and **gate on `is_admin()`
first** (reps/dispatchers must NOT see peer or self performance). Pure reads — no writes, no
schema changes to existing tables.

- `rep_activity_summary(p_from timestamptz, p_to timestamptz)` → one row per active rep:
  `rep_id, display_name, notifies, messages, calls, last_active_at`.
- `rep_notify_coverage(p_from timestamptz, p_to timestamptz)` → one row:
  `notifiable_updates, notified, pct_notified, not_notified, median_minutes_to_notify,
  backlog_open (un-notified, still non-terminal), oldest_open_update_age_minutes,
  last_team_notify_at`.
- `rep_activity_timeline(p_rep_id uuid, p_from, p_to)` (Phase 2 drill-down) → ordered actions
  with `gap_minutes` between consecutive ones, for spotting silence windows per rep.

**Indexes to add** (the only DDL): `delivery_client_notifications (notified_by_user_id,
notified_at)`, `delivery_messages (author_id, created_at)`, and
`delivery_status_history (to_status, effective_at)` — verify each against the live DB before
adding (some may exist). Volumes are small (hundreds–thousands of rows/week), so even without
indexes the RPCs are cheap; add them for headroom.

## 6. Frontend (new admin-only screen)

A new admin tab, e.g. **Admin → "Rep performance"** (or under an "Ops health" section). Reps
and dispatchers do not see it. Layout:
- **Top:** the Lens B coverage/SLA panel + the live "last team action N min ago" indicator.
- **Below:** the Lens A per-rep leaderboard (sortable by notifications / last-active), each
  row tappable → Phase 2 per-rep timeline.
- A simple date-range switch (Today / 7d / custom) mirroring the reconcile screens.
- Reuse existing patterns: the reconcile screens (`(rep)/reconcile`) and `RepDashboard` show
  the card/stat/date-range idiom to copy.

## 7. Phasing

1. **Phase 1 (core, ~self-contained):** the two summary RPCs + the admin screen (leaderboard +
   coverage panel), date-range read-only. Delivers everything Greg asked to *see*. Indexes.
2. **Phase 2:** per-rep drill-down timeline with gap highlighting; a configurable "silence"
   threshold; optional **admin push** when the team's last notification is older than N min
   during business hours (turns the passive report into the alert Greg implicitly wants).
3. **Phase 3 (optional):** extend the same engine to **agents** (status-update responsiveness),
   and/or a weekly digest.

## 8. Non-goals / boundaries

- Not reading or sending WhatsApp content; not auto-notifying clients.
- No change to `mark_client_notified` mechanics or rep permissions.
- Reps/dispatchers get **no** visibility into this (admin-only).
- Agents are out of scope for v1 (Phase 3 candidate).
- Exclude `Test Rep` / inactive users from the leaderboard.

## 9. Decisions — RESOLVED by Greg/Uzo 2026-06-22

1. **Which status updates "require" a client notification?** → **Use the "To notify" pill set.**
   Denominator = the `awaitsClientNotification` predicate (exclusion list: not pending /
   delivered / rolled_over / agent_cancelled). See §4 for the full implication and the
   measurement grain (per-transition). Backend mirrors the same exempt set.
2. **Target time-to-notify?** → **5 minutes.** Drives the thresholds: green ≤ 5 min,
   amber/red beyond. The live "last team action" indicator and any silence alert key off 5 min.
3. **Live alerts vs on-demand report?** → **Implementer's choice, optimise for efficiency.**
   Lean toward the cheap option: surface the live "last team notification N min ago" indicator
   in the screen (no infra cost); add the push alert only if it can be done without a polling
   loop (e.g. piggyback an existing trigger/cron). Don't add a heavy scheduler just for this.
4. **Reps only, or agents too?** → **Reps only for now.** Agents stay a Phase 3 candidate.

## 10. Risk notes

- Metric is **self-reported** (a tap), not proof of an actual WhatsApp message — state it.
- The 54.6% coverage figure includes updates that may legitimately not need notifying
  (rapid re-changes, duplicates); the denominator definition (Q1) will refine it.
- Timezone: all timestamps are UTC; render in **Africa/Lagos** and compute "business hours"
  in Lagos (as the analysis above did).
