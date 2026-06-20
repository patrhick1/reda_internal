# Postpone Handling & Visibility — Feature Scope

**Status:** Core implemented (mobile-only, no schema) · **Author:** investigation 2026-06-17

## Implementation status (2026-06-17)

**Built & CI-green (`typecheck` + `lint` + `format:check`):**
- §5.4 `listPostponed(role)` — ops-wide, all postponed across dates, soonest-first
  (`mobile/src/services/deliveries.ts`).
- §5.2 Ops list **"Postponed" filter** + per-row **"Postponed to ‹date›"** pill, with select-mode
  guard and a tailored empty/refresh state (`mobile/src/screens/deliveries/List.tsx`).
- §5.1 Agent Today — due-today `postponed` rows bucket as **Active** (not Soft fail)
  (`mobile/app/(agent)/today/index.tsx`).
- Shared `formatYmdShort` extracted to `mobile/src/lib/format.ts` (agent screen de-duplicated onto it).

**Deferred (per recommendation):**
- §5.3 row snapshot tag ("Postponed ‹day› · ‹who›") — the detail "Handed to you" banner already
  carries who/when; deferred unless wanted on the row (would need a per-row history read or a
  snapshot column).
- §5.2 "show `scheduled_date` on *every* row in All-dates mode" — only the postponed rows show it
  for now (the core need).

**Awaiting user sign-off (neither blocks the shipped core):**
- §7 keep-assigned (recommended; = current behavior, no code) vs unassign-on-postpone.
- §5.3 whether the row snapshot tag is wanted (and its DB snapshot columns).

---

## 1. Context

Uzo's scenario: agent **Olawale** called a customer Monday; the customer postponed to
**Wednesday**. On Wednesday the order showed up under **Soft fail** (that's how Uzo found it),
still **assigned to Olawale**. Uzo reassigned it to **Anthony** (going that way today), but the
status stayed **postponed** and it remained under **soft fail**.

Two concerns:
1. Why was a postponed order still assigned to the original agent (Olawale)?
2. After reassigning to Anthony, the status stayed `postponed` — confusing for the new agent,
   and it's still filed under soft-fail.

Plus: **can Ops see all postponed orders and their postpone-to dates?** Today — not cleanly.

## 2. Verified current behavior (source of truth: deployed functions)

- **Postpone keeps the agent.** The postpone path (`change_delivery_status` → `postponed`
  with a future `scheduled_date`) edits the **same row in place**. Its `UPDATE` sets
  `current_status` and `scheduled_date` only — it **never sets `assigned_agent_id`** (it only
  reads it for the auth/stock guards). So the row stays the original agent's. Only the **EOD
  rollover** creates a new *unassigned* child; **postpone does not unassign — by design.**
- **Reassign keeps the status.** `update_delivery_fields` sets `assigned_agent_id` (and other
  edited fields) but has **no `current_status`** in its `UPDATE`. So swapping the agent leaves
  the status at `postponed`.
- **`postponed` is `soft_failure` category** (`delivery_status_defs`), so it's filed under the
  "Soft fail" bucket and is subject to the carry-cap.
- **Future-dated postponed orders are parked.** EOD (`run_eod_rollover`) only touches rows
  with `scheduled_date = p_for_date`; the catch-up sweep only goes up to `current_date`. So a
  postponed order is untouched until its date arrives.
- **On its due date, if still `postponed`, it rolls like a soft-fail.** No special branch (only
  `follow_up` has one). It goes through `rollover_delivery`: a fresh `pending` child for the
  next workday, parent stamped `rolled_over`, and **counts toward the carry-cap** (→ `unserious`
  at `rollover_count >= 1`). Dedup/sibling cancels still take precedence.

**Conclusion:** both of Uzo's observations are correct and are *working as designed* — not
bugs. The gap is **presentation/visibility**, not mechanics.

## 3. Existing building blocks (reuse — do NOT rebuild)

- **Postponed pill** — `STATUS_META.postponed` = amber "Postponed" (`mobile/src/lib/theme.ts`).
- **Agent "Postponed to ‹date›" line + Postponed filter chip** — added this session on the
  agent Today screen (`mobile/app/(agent)/today/index.tsx`), backed by `listAgentPostponed`
  (`mobile/src/services/deliveries.ts`) for the agent's own **future-dated** postponed orders.
- **Rolled-from snapshot** — `rolledFromLabel` (`mobile/src/services/deliveries.ts`) renders
  the compact *"was Not answering · 16 Jun"* tag on list rows (`List.tsx`) and detail
  (`Detail.tsx`); precedent for a compact "where this came from" tag.
- **"Handed to you" banner** — on the agent delivery detail (`app/(agent)/today/[id].tsx`),
  shows *"Set to Postponed by Olawale · ‹date›. Check the messages before calling…"* (Gap 5,
  shipped).
- **Reassign push to old agent** — `tg_notify_assignment_push` pushes the agent who lost the
  row (Gap 4, shipped).

## 4. The gaps to close

### Agent side
- On its **due date** a postponed order shows under **Soft fail** (a "failed attempt" bucket),
  not as upcoming work. `statusBucket('postponed') === 'soft'`.
- No compact "postponed ‹when› · ‹who›" context on the row (only on the detail banner).

### Ops side (`mobile/src/screens/deliveries/List.tsx`)
- **No dedicated "Postponed" filter.** The status filters are
  `all | active | available | soft | done | unassigned`; postponed is buried under **soft**
  with every other soft-fail.
- **To see all postponed across dates** ops must use **All dates + Soft fail** (mixed and
  unsorted).
- **Ops rows do not render `scheduled_date`.** The date is shown only at the screen level
  (header subtitle). So in "All dates" mode the **postpone-to date of each row is invisible** —
  ops can't tell when an order is postponed to without opening it.

## 5. The fix

Display/visibility only. **Roll/cap/status semantics are unchanged** — so rollover and
reporting stay exactly as they are (no data-integrity risk).

### 5.1 Agent Today screen (`mobile/app/(agent)/today/index.tsx`)
- **Bucket a postponed row in the today list as ACTIVE, not soft.** The today list is already
  date-scoped to today, so any `postponed` row there is by definition **due today** → present
  it as live work (keep the amber "Postponed" pill). Net change: special-case `postponed` into
  the `active` bucket within this screen's bucketing (do **not** change global `statusBucket`,
  which other screens rely on).
- *(optional)* compact snapshot tag on the row — *"Postponed ‹day› · ‹who›"* (see §5.3).
- The **future-dated Postponed chip** + "Postponed to ‹date›" line already exist — unchanged.

### 5.2 Ops list (`mobile/src/screens/deliveries/List.tsx`)
- **Add a dedicated "Postponed" filter** to the `Filter` union. It shows **all postponed
  orders across dates**, sorted by **postpone-to date (soonest first)**, regardless of the date
  preset. Backed by a new ops-wide service call (§5.4).
- **Show the postpone-to date on the row** — reuse the agent's "Postponed to ‹date›" line. At
  minimum render it for `postponed` rows; ideally show `scheduled_date` on every row when the
  date preset is **All dates** (since the screen-level date no longer identifies the row).
- *(optional)* **Re-bucket due-today postponed as active** in the ops list too (date-aware:
  `postponed` with `scheduled_date <= today` → active; future → the Postponed filter).

### 5.3 Snapshot tag *(optional, both surfaces)*
A compact *"Postponed ‹day› · ‹who›"* on the row, mirroring `rolledFromLabel`. Source options:
- **Cheapest:** leave the who/when on the **detail banner** (already shipped) and skip the row
  tag for v1 — the row already shows the amber pill + the postpone-to date.
- **If wanted on the row:** derive from the latest `delivery_status_history` row, or add a
  `postponed_from`/`postponed_by` snapshot column stamped at postpone time (mirrors
  `rolled_from_status`/`rolled_from_date`). A snapshot column avoids a per-row history read.
  → **Recommend deferring** unless Uzo wants the who/when visible without opening the row.

### 5.4 Service (`mobile/src/services/deliveries.ts`)
- Add **`listPostponed()`** — the ops-wide twin of `listAgentPostponed`: `current_status =
  'postponed'`, ordered by `scheduled_date` asc, **without** the `assigned_agent_id = me`
  scope. Reads through the role-scoped view (`deliveries_admin` / `deliveries_safe`), so RLS
  still applies. Reuses the same join + line-item pipeline.

## 6. Real-life walkthrough (with the fix)

**Customer Mrs. Bisi, Ajah. Assigned to Olawale.**

- **Mon — Olawale calls.** Customer says "come Wednesday." Olawale marks **Postponed**, picks
  Wed in the calendar. Row stays his; `status=postponed`, `scheduled_date=Wed`; history logs
  "Olawale → Postponed, Mon." It leaves Monday's list and appears in Olawale's **Postponed
  chip** as *"Postponed to Wed 19 Jun."* *(built)*
- **Tue — parked.** Not on anyone's Today list; Tuesday EOD ignores it (`scheduled_date > today`).
- **Wed AM — Uzo.** Opens the ops **Postponed** filter *(new)* → sees every postponed order with
  its **postpone-to date** and current agent. Mrs. Bisi's order: due today, Olawale's. No more
  hunting under Soft fail.
- **Wed — Uzo routes.** Anthony covers Ajah today; Uzo reassigns Olawale → Anthony. Status
  stays `postponed` (fine now). Olawale gets an *"Order reassigned"* push *(shipped)*; it drops
  off his list.
- **Wed — Anthony.** The order is in his **active Today work** *(new bucketing)* with the amber
  **Postponed** pill, not under soft-fail. He taps in → **"Handed to you" banner** *(shipped)*:
  *"Set to Postponed by Olawale · Mon 17 Jun. Check the messages before calling…"* He calls,
  she's home, marks Delivered.
- **Wed EOD — if not reached.** Still `postponed` at 23:59 → rolls like a normal soft-fail
  (fresh `pending` child, parent `rolled_over`, counts toward the cap). **Unchanged** by this
  fix.

## 7. Open decision (please confirm)

**Assignment on postpone:**
- **(a) Keep it assigned** (continuity — the agent who built rapport keeps the thread) and rely
  on the new ops Postponed view + active bucketing to make day-of reassignment easy.
  **← Recommended.** The walkthrough shows surfacing solves Uzo's friction without unassigning.
- **(b) Unassign on the postpone date** so whoever covers the area claims it (loses the
  "Olawale already spoke to them" continuity).

The rest of the fix (visibility/bucketing) is independent of this choice.

## 8. What we explicitly do NOT change

- The `postponed` status value, its `soft_failure` category, and its **roll + carry-cap
  semantics** on the due date. (Only the *display bucket* on the day-of changes.)
- Reassignment behavior (still swaps agent only). Status is left intact on purpose.
- No new EOD branch for `postponed` (unlike `follow_up`, which closes out).

## 9. File / function touch-list

**Mobile:**
- `mobile/src/services/deliveries.ts` — add `listPostponed()` (ops-wide); reuse types.
- `mobile/src/screens/deliveries/List.tsx` — add "Postponed" `Filter`; per-row postpone-to
  date; optional due-today→active bucketing.
- `mobile/app/(agent)/today/index.tsx` — bucket due-today `postponed` as active; *(optional)*
  snapshot tag.
- *(optional, if snapshot-on-row wanted)* a small render helper mirroring `rolledFromLabel`.

**DB (only if snapshot-on-row is approved — §5.3):**
- `deliveries` — add `postponed_from_date` / `postponed_by` snapshot columns; stamp them in the
  postpone path. Otherwise **no schema change** — this fix is mobile-only.

## 10. Test checklist

- Postpone an order to a future date → owner sees it in the Postponed chip with the right date;
  it's off the today list; future EOD doesn't touch it.
- On the due date → it appears as **active** work (not soft-fail) for the assigned agent, amber
  Postponed pill.
- Ops **Postponed** filter → lists all postponed across dates, sorted by postpone-to date, each
  row showing its date; works under any date preset.
- Reassign a due-today postponed order → new agent sees it as active + the "Handed to you"
  banner on detail; old agent gets the reassign push and loses it.
- Leave it unworked past 23:59 on its due date → rolls + counts toward the cap exactly as today.

## 11. Sequencing

1. Confirm §7 (keep-assigned vs unassign) and whether the §5.3 row snapshot is wanted.
2. Service: `listPostponed()`.
3. Ops list: Postponed filter + per-row date.
4. Agent Today: due-today→active bucketing.
5. *(optional)* snapshot tag (+ schema if approved).
6. CI trio (`typecheck` + `lint` + `format:check`); smoke test the walkthrough.
7. Commit; OTA via `eas update --branch preview`.
