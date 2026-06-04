# Reda Logistics — System Design Doc (v0.5)

A working document for Uzo to verify before Paschal builds. Everything here is the result of conversation between Paschal and an AI assistant, based on what Paschal understood from Uzo. **It almost certainly contains things that are wrong or need adjustment.** Goal of this doc: catch those things now while they're cheap to fix.

How to read this: skim it. Where something doesn't match how Reda actually works, mark it. Where something is missing, add it. The most important section is **Section 9 — Outstanding questions** at the bottom.

---

## 1. What we're building

A mobile app to replace Google Sheets, Make.com, and most internal WhatsApp coordination for Reda's operations. Built for Uzo (admin), future dispatchers, and agents (riders). End customers and clients (vendors) don't use the app — they continue to interact via WhatsApp.

Stack:
- React Native via Expo (one codebase, Android + iOS)
- Supabase free tier for backend (Postgres + auth + storage + realtime + push)
- OpenRouter (multi-model brokering: `openai/gpt-4.1-mini` for order-field extraction in `bot-parse-message`, `google/gemini-2.5-flash` for address picking in `normalize-address`) + Google Maps Geocoding API for the geocode step. Direct Google AI calls retired 2026-06-03 — Gemini's free tier (20 requests/day) was rate-limiting the address pipeline. Same models, paid billing through OpenRouter.
- Online-with-resilience for v1 (mutations queue locally and retry; full offline-first comes in v2)

The existing WhatsApp ingestion bot stays but is reconfigured — it reads from a single parsing channel that Uzo controls, instead of multiple agent groups. Make.com automation gets retired (saves ₦16k/month).

## 2. Roles & permissions

Five user roles. One codebase, role-based views.

**Admin (Uzo).** Sees everything. Creates users, clients, products, locations, rate cards. Performs stock adjustments + transfers + intakes. Sees Reda's margin. Handles end-of-day rollovers. Reconciles money. Resolves needs-review rows (fix-and-create / discard). Edits customer-facing delivery fields before delivery. Claims follow-ups on soft-status deliveries. Edits own profile / changes own password via the Profile screen (self-service is open to every role, not just admin).

**Dispatcher.** Operational coordinator. Can create, assign, edit, and update statuses on any delivery. Resolves needs-review rows and edits customer-facing fields on pre-delivery rows — same permission surface as admin for those workflows. Claims follow-ups on soft-status deliveries. Cannot edit setup (clients, products, users, rate card). Cannot perform stock adjustments. Cannot see margin. (v1 ships with this role enabled but no accounts created — Uzo is the only dispatcher today. Provisioned for the future.)

**Rep.** Operational representative. Identical to dispatcher EXCEPT for two carve-outs: (1) no stock access (no stock screens, no read on `stock_adjustments`, no place in the stock-pickup notification audience), and (2) no standalone "New delivery" surface — the FAB on the deliveries list and on the rep dashboard, and the `/(rep)/deliveries/new` route, are all gone. Reps still create deliveries indirectly via the bot-review fix flow (Needs Review → fill in the form → Create) since that's part of operational coordination, not original authoring. The server-side `is_admin_or_dispatcher()` helper still treats rep as part of the operational set so review-fix works; the standalone-create restriction is a UI gate via `canCreateDelivery(role)`. Use this role for teammates who book and coordinate deliveries but never handle inventory or write new orders. Reps are the **intermediary layer between clients (vendors) and agents (riders)** — they take the operational heat from clients, coordinate with agents on the ground, and shield agents from any direct vendor relationship.

**Agent (Rider).** Sees only their own deliveries. Updates status on those deliveries. Records payment collected. Sees their own stock in hand. Sees their own per-delivery and per-period earnings. Cannot see margin or Reda's charge. Cannot see other agents' work. **Cannot see which client (vendor) a delivery belongs to** — vendor identity is hidden across the agent app (Today list cards, delivery detail, Earnings, My Stock, and the `listAgentEarnings` service no longer fetches client names from the wire). Only admin and rep see client identity; the policy exists because client relationships are a defensible asset and riders rotate, so exposing vendor names invites poaching.

**Warehouse.** The warehouse-role user **is the physical place where stock is stored** — one identity per location (Shomolu warehouse today; future locations would be additional warehouse-role users). Humans on the warehouse floor share the location's login, and the audit log records every action as the warehouse identity — per-human accountability inside the warehouse is intentionally collapsed in favour of a single books-of-record actor.

Owns the physical stock flow (since 2026-05-27): vendor intakes into self (`bulk_intake`), paired transfers as a participant (`warehouse_issue` from self, `warehouse_return` to self), and shrinkage on own holdings (`loss`, `theft`, `damaged`, `found`). **Cannot** run `correction` (the books-override path stays admin-only as a single accountability anchor) or agent-to-agent `transfer` (operational reassignment, not warehouse work). App surface: Stock dashboard + the three action screens (shared with admin via `scope` prop) + Profile.

**Key access rules:**
- **Margin** (Reda's profit per delivery) is admin-only. Agents, dispatchers, and reps should not see what Reda earns on each delivery. Enforced at the API + database level, not just UI.
- **Client (vendor) identity** is reserved for admin and rep. Agents see customer name, address, product, and payment to collect — never the client/vendor name. Today this is enforced in the agent UI plus a service-layer omission on `listAgentEarnings`; the `deliveries_safe` view + `clients` RLS still expose names to anyone who joins them, so a determined agent inspecting network responses could read them. Tighten this server-side if poaching becomes a real incident.

## 3. The delivery lifecycle

### Creation

A client (e.g., Dentora) sends a delivery request to their dedicated client group on WhatsApp. Reda has one client group per client. Format is reasonably structured because clients have been trained.

Uzo reads the request and forwards it (after any quality-control edits — typos, missing info, format normalization) to a **single parsing channel** he controls. This replaces the previous model of forwarding to many agent-specific groups.

The bot watches only that parsing channel. It parses the message to extract: customer name, phone, raw address, product, quantity ordered, customer price, vendor, date.

**After-hours bump (since 2026-05-27).** Any delivery (bot or manual) created at or after 22:00 Africa/Lagos with `scheduled_date = today` is automatically pushed to the next working day. The bump lives inside `create_delivery` so both pipelines pick it up without duplication; past and explicit-future dates are untouched. The Sunday-skip from `_ensure_workday` is reused so a Saturday-22:30 order lands on Monday, not Sunday. Rationale: late-evening orders can't realistically be served the same day, and treating that as a server-side guarantee removes a recurring spreadsheet-era judgment call.

### Address normalization (AI-assisted)

Lagos addresses are messy — no postal codes, informal landmarks, typos, multiple ways to refer to the same place. The bot uses a two-step pipeline to map the raw address to a known location from the rate card:

1. **Substring/word-boundary pre-check** against `locations.name + aliases`. If a clean win, skip the API spend entirely.
2. **Google Maps Geocoding API.** Send the raw address. Maps returns coordinates + structured place names (e.g., "Iganmu, Lagos, Nigeria").
3. **Gemini 2.5 Flash via OpenRouter (if needed).** Send Maps' output + the rate card location list to Gemini through OpenRouter's chat-completions endpoint (not the direct Google AI endpoint — that's free-tier rate-limited). Same model brain, paid billing. Gemini returns:
   ```json
   {
     "matched_location": "Iganmu",
     "confidence": "high",
     "reasoning": "Maps identified the neighborhood as Iganmu, which is in the rate card"
   }
   ```

If Maps returns nothing useful (very informal addresses), the bot falls back to Gemini-only — sends raw address + rate card directly.

**What happens with the result:**
- **High confidence** → location set automatically, delivery proceeds to auto-assignment
- **Medium confidence** → location set, delivery flagged "AI-matched, please verify" in admin view
- **Low confidence / no match** → location stays empty, delivery goes to "Needs Review" queue for Uzo

Every AI-matched location is logged with the raw address, the match, confidence, and reasoning. Over time, this dataset shows where the AI is reliably right (or wrong) and can inform prompt tuning or fallback rules.

**Cost expectation:** Gemini Flash + Maps Geocoding for ~100 deliveries/day is roughly ₦4,500-9,000/month — significantly less than the ₦16k Make.com cost being retired.

### Auto-assignment with sensible defaults

After location is set, the bot picks an agent based on a small scoring function:

1. **Stock filter.** Only agents currently holding stock of the requested product+vendor are eligible. If nobody has stock, delivery stays unassigned and surfaces in the app for Uzo to handle.
2. **Active filter.** Skip deactivated agents.
3. **Location score.** Boost agents whose preferred location/home zone matches the delivery location.
4. **Workload score.** Penalize agents already carrying many pending deliveries today.
5. **Pick highest scorer.** Tie-break by who has the most stock of the product.

The agent gets a push notification immediately. **Uzo doesn't need to open the app for routine assignments.**

If Uzo disagrees with the auto-assignment, he reassigns in the app — one tap, audit-logged.

**Rolled-over deliveries explicitly DO NOT auto-assign (since 2026-05-30).** The `tg_auto_assign_on_insert` trigger gates on `created_via <> 'rollover'` so prior-day soft-fails land on tomorrow's queue **unassigned** — see "End of day" below and PRD §5.11a for the full rationale. Fresh bot/manual orders still go through the algorithm normally.

### In-day flow

Agent receives push notification, opens app, sees delivery details. Calls customer using tap-to-call.

- Customer answers and confirms → status = Available (en route)
- Customer doesn't answer → Not Answering / Number Busy / Switched Off
- Customer defers → Tomorrow / Postponed / Follow Up

Agent travels, delivers, collects payment (cash or transfer), verifies amount.

- Successful → Delivered (agent records `quantity_delivered`, `paid`, `payment_method`)
- Customer refuses → Cancelled
- Other failure modes → Failed Delivery, Unserious, No Product

**All status updates happen in the app**, not in WhatsApp. The agent WhatsApp groups for delivery coordination go away. (Existing agent groups can stay as social/general-chat channels if Uzo wants, but they're no longer part of the delivery workflow.)

**Delivery comms (since 2026-05-16).** When an agent hits a real-world problem (wrong address, can't reach customer, payment dispute, product issue, anything else), they tap the alert icon on the delivery detail, pick an issue chip + optional note, and submit. One atomic operation: a `delivery_messages` row is inserted AND the delivery transitions to the chip's default soft status (e.g. `cant_reach_client → not_answering`, others → `follow_up`). All admins + dispatchers + reps get pushed; any of them can open the delivery and reply with free text, which pushes the agent back. Pairs with the existing `delivery_followups` claim lock — the new soft status auto-enables **I'll handle this**. The thread is "open" iff the parent delivery is non-terminal; terminal status implicitly closes it (no separate `closed_at` field — derived). Replaces the prior WhatsApp/phone fallback with an in-app, audited, push-notified channel.

**Auto-seed thread on intervention status (since 2026-05-27).** When an agent picks a customer-unreachable status (`not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`) from the regular *Update status* sheet, the submit routes through `flag_delivery_issue` instead of plain `change_delivery_status` — so the status changes AND a thread gets seeded without the agent having to also tap the alert icon. Ops users picking those statuses don't trigger the routing (they may be correcting a status post-call). The same agent-side path now drives both entry points; the alert icon remains for the four chip-typed issue flavors (wrong address, payment dispute, product issue, other).

**Ops can seed empty threads (since 2026-05-27).** Loosened the earlier "thread must start with an agent flag" rule so reps can open a coordination conversation proactively. When the thread is empty AND the viewer is admin/dispatcher/rep AND the parent is non-terminal, the MessageThread renders an inline *Message agent* composer. The agent-flag path stays the dominant case.

**Client-notified tag (since 2026-05-27).** Each row in the per-delivery history timeline carries an optional *client-notified* tag — first ops user to tap *Mark client notified* on a row wins; peers see *"<Name> told the client · <time>"*. Backed by `delivery_client_notifications` (keyed by `status_history_id`, denormalized `delivery_id` for cheap per-delivery lookups). Separate companion table — not extra columns on `delivery_status_history` — to keep that table's append-only audit invariant intact (same pattern as `delivery_followups` and `delivery_messages`). RLS lets ops + the row's assigned agent SELECT (informational read for the agent). On the deliveries list, a small green *Notified* pill renders on rows whose latest history entry carries a tag — peers see at a glance which deliveries have already been communicated without opening each one.

**Race-assign coordination (since 2026-05-18).** Uzo's operational reality: assign the same customer/product/day delivery to multiple agents so whoever gets there first delivers it. The system now coordinates this end-to-end:

- **Stand-by signal.** When one of the duplicates transitions `pending → available`, every other sibling's agent gets a *"<Agent first name> is on <customer>. Hold for now."* push. Sibling rows stay open in case the en-route agent fails.
- **Auto-cancel on delivered.** When one sibling reaches `delivered`, every other non-terminal sibling is auto-cancelled with reason "duplicate completed by <Agent>" and a *"Delivery closed"* push. Reconciliation, stock, and agent earnings naturally count only the winner.
- **Cascade scope (since 2026-06-03 — see §3.5).** The trigger `tg_handle_sibling_coordination` fires on every terminal status **except `rolled_over` and `agent_cancelled`** — the two row-level terminals. `rolled_over` is EOD-owned (its dedup is done separately); `agent_cancelled` means "this agent's row is closed but the order is still live for everyone else." For order-level terminals (`delivered`, `cancelled`, `failed_delivery`, `no_product`, `abandoned`) the cascade is correct: when the order is over, the siblings close. For per-row removal (phantom cleanup, "not my delivery"), use `agent_cancelled`. The 2026-06-03 phantom-race incident — cancelling 11 phantoms via `cancelled` and watching the cascade take 12 intended-agent canonicals down with them — is the canonical case `agent_cancelled` solves.
- **Sibling match** runs two checks as **independent alternatives** — two rows are siblings if (a) their bot-message fingerprints match OR (b) their normalized address AND quantity match. The OR is real: even when both rows have fingerprints, the address+qty path still fires. That's load-bearing for typo-drift cases — the contractor's AI re-parses the same WhatsApp message with slightly different formatting on each forward, producing different fingerprints for what is one physical order. Address+qty catches them. Same-day repeat orders to the **same** address don't false-cancel only because legitimate repeats are usually to a different address, different qty, or get marked delivered before the second arrives.
- **Late-add sibling** (Uzo creates a 4th duplicate after agent A is already en route) → the new agent receives the Stand-by push immediately on row creation.
- **Rollover dedup (revised 2026-06-02).** The 23:59 auto-rollover **collapses every sibling group to a single canonical** before rolling forward. Same-agent dupes collapse to one row per agent; cross-agent groups (race-assigns) collapse to one canonical regardless of progression state. The collapse is correct *because rolled rows land unassigned* (see "End of day" below) — preserving multiple parents through EOD would just spawn multiple unassigned phantoms tomorrow, forcing Uzo to dedup by eye in the morning queue. Uzo can re-race fresh tomorrow morning by reassigning to multiple agents again. Prior behavior (2026-05-18 → 2026-06-02) preserved all-pending cross-agent siblings through rollover; that was the right policy when rollovers inherited parent assignments, but stopped making sense after the 2026-05-30 unassigned-rollover change.
- **One-time backfills** ran on 2026-05-18 (matcher-visible duplicates) and 2026-06-02 (matcher-invisible typo-drift duplicates — same phone+product+date+price + trigram-similar raw text). Today's backfill cancelled 153 phantom rows after the matcher consistency fix below landed.
- **Bot smart-reassign (since 2026-05-30).** When Uzo forwards a customer's details to a specific agent on WhatsApp, `bot_create_delivery` checks for an unassigned sibling first (the rolled-over orphan from last night) and **absorbs that row by UPDATEing its `assigned_agent_id` instead of inserting a duplicate**. The match uses the same two-tier predicate as sibling coordination. Race semantics are preserved automatically: the FIRST forward absorbs the orphan; subsequent forwards see an *assigned* sibling, fall through to the existing insert path, and spawn fresh sibling rows for the race. Lets Uzo keep his WhatsApp habit without polluting the audit trail with phantom "the bot also created this" duplicates.
- **Matcher consistency restored (2026-06-02).** Between 2026-05-25 and 2026-06-02, a tightening patch had gated the (b) address+qty path behind "at least one fingerprint is null" inside `bot_create_delivery` (pre-empt + smart-reassign) and the moral equivalent inside `run_eod_rollover.sib_key` (fingerprint-first partitioning). Effect: typo-drifted bot forwards (both have fingerprints, fingerprints differ) silently bypassed dedup at intake, mid-day cascade, and EOD. Restored to the documented (a) OR (b) independence in `_find_sibling_deliveries`, both inlined predicates in `bot_create_delivery`, and the sib_key expression in `run_eod_rollover`.
- **Same-agent dupe → dedup, not spread (since 2026-06-03).** Between 2026-05-19 and 2026-06-03, `bot_create_delivery` had a "spread same-agent dupes to a different agent" behavior: when the contractor's bot re-forwarded an order naming an agent who already held it, the function silently nulled the assignment and let `tg_auto_assign_on_insert` hand it to a different agent — creating phantom multi-agent races the contractor never asked for (the 2026-06-03 incident found 11 such phantoms in a single day across Kenneth, Anjola, Audrey, and Queen Favour). Replaced with: raise `P0001` carrying a `{kind:'duplicate_same_agent', existing_delivery_id, agent_id}` hint; `bot-parse-message` catches the hint and marks the inbound row `status='duplicate'` with `delivery_id` pointing at the canonical row. **No new row, no second agent involved.** Intentional multi-agent races (different agents named on different forwards) are unaffected — that path doesn't enter the dedup branch. See `scripts/fix-bot-create-delivery-no-phantom-race.sql` for the function definition.

### 3.5 Cascade scope and `agent_cancelled` (shipped 2026-06-03)

The sibling cascade was originally designed to fire only on `delivered` ("order fulfilled, close the race"), then expanded in `archive/sibling-cascade-all-terminal.sql` to fire on **every** terminal status. That latter scope is correct for **order-level** terminals (`delivered`, `cancelled`, `failed_delivery`, `no_product`, `abandoned`) — they all describe the whole order ending. It was wrong for **row-level** outcomes: an agent passing on a delivery that isn't theirs, or an admin removing one row of a sibling pair without affecting the other.

Shipped fix: a single new terminal status `agent_cancelled` (label: **"Not my delivery"**), the only non-cascading terminal alongside `rolled_over`.

- Semantically: agent-initiated row close ("not my delivery", customer unreachable after retries) OR admin per-row removal (phantom cleanup, wrong-agent fix).
- Terminal for the row it's set on, but **does not cascade** to siblings — the customer's order is still live, this specific agent's instance is closed.
- Distinct from `cancelled`, which keeps its customer-side semantics ("the customer killed this order") and continues to cascade — correctly.

Implementation ([scripts/add-agent-cancelled-status.sql](scripts/add-agent-cancelled-status.sql)):
1. New row in `delivery_status_defs`: `status='agent_cancelled', label='Not my delivery', category='terminal', sort_order=28`.
2. Transitions generated dynamically — every non-terminal status ↔ `agent_cancelled`, both directions with `requires_reason=true, requires_admin=false`. Matches the existing `cancelled` revert pattern (agent who passed on the row can self-revert with a reason).
3. `tg_handle_sibling_coordination` reproduced verbatim from production with one added exclusion in the terminal-entry check: `and status <> 'agent_cancelled'`, alongside the existing `rolled_over` exclusion.
4. Mobile UI: status appears in the picker via existing data-driven flow ([mobile/src/lib/theme.ts](mobile/src/lib/theme.ts), [mobile/src/components/sheets/UpdateStatusSheet.tsx](mobile/src/components/sheets/UpdateStatusSheet.tsx)). Picking it shows a status-specific warning banner: *"Closes only your row. The order stays open for other agents in the race. You'll need a reason if you reopen it."*
5. New optional `warning?: string` field on `STATUS_META` is the foothold for status-specific copy going forward — additive, every other status keeps its current generic terminal warning.

Scope discipline (settled 2026-06-03):
- `failed_delivery`, `no_product`, `abandoned`, `cancelled`, `delivered` all **continue to cascade**. They describe order-level outcomes that apply to the whole order, not just this agent's instance.
- `agent_cancelled` is the **only** non-cascading terminal we needed. ONE status means "this agent's row is closed, order is still live"; everything else means "this order is done, close the race."
- Reporting / dashboards that bucket on `cancelled` need NOT include `agent_cancelled` — they're different events and count separately.

Smoke test in [scripts/smoke-agent-cancelled.sql](scripts/smoke-agent-cancelled.sql) covers four cases: (1) agent_cancelled doesn't cascade, (2) cancelled still does (regression control), (3) revert path works without admin, (4) null reason rejected.

### End of day

**Auto-rollover at 23:59 Lagos (since 2026-05-17; time moved to 23:59 later — old "21:00" mentions in SQL comments are stale).** The [scheduled-eod-check](supabase/functions/scheduled-eod-check/index.ts) Edge Function runs nightly via Supabase Scheduled Edge Functions. It signs in as the **Reda System** admin user (a real `users` row — `system@reda.local`, role=admin) and calls `run_eod_rollover_all_stuck()`. This walks every distinct `scheduled_date <= current_date` that still has at least one non-terminal delivery and calls `run_eod_rollover(date)` per group. All admins get one confirmation push. The system-user pattern means the cron is indistinguishable from an admin running EOD manually — existing role checks pass naturally and audit attribution shows "Reda System" rather than a faceless service-role call.

**Sunday-skip.** Reda's work week is Mon–Sat. The `_ensure_workday(candidate)` helper inside `rollover_delivery` bumps a Sunday candidate to Monday — applied uniformly to both the default `+1 day` AND any explicit override, so a future caller passing Sunday by mistake never silently schedules work on a non-operational day. The one place to extend if Reda starts observing holidays.

**Manual path still available.** Uzo can still open the EOD screen and tap **Roll all forward** — same backend, same idempotency. Useful for clearing early or re-running after fixing something.

Rolling over creates a NEW row for tomorrow (linked via `parent_delivery_id`), copying customer info, product, quantity, address, location, customer_price. The old row flips to `rolled_over` (terminal). Stock is NOT moved — stock attribution is via delivered-side-effects, not assignment.

**Rolled rows land unassigned (since 2026-05-30).** Per PRD §5.11a, Uzo declined an auto-routing seed for rollover assignment because agents' schedules churn (leave, sickness, new joiners, departures) and the rotation he runs requires human judgment the app can't honestly model. `rollover_delivery` now inserts the new row with `assigned_agent_id = NULL`; the auto-assign trigger skips `created_via='rollover'` so nothing automatically guesses; every rolled-over delivery surfaces on tomorrow's queue under the existing **Unassigned** filter chip on the deliveries list. Uzo clears the queue in 3–5 minutes via multi-select + bulk reassign (long-press a row to enter select mode, tap to toggle, "Assign N" picks an agent via a search-filterable bottom sheet, single round-trip through the `bulk_assign_deliveries` RPC). Alternatively he can keep forwarding orders to agents on WhatsApp exactly as before — the bot smart-reassign (see Race-assign coordination above) absorbs the unassigned orphan into whatever agent he named.

**Carry-cap only counts genuine soft-fails (since 2026-05-30).** The 3-strike rule (mark `unserious` after 2 rollovers) now fires only when the parent's status was a customer-unreachable one — `not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`. Operational rollovers (a row that sat as `pending` because nobody assigned it, an `available` row that never got attempted, a `picked_up` row the agent didn't deliver) carry without burning a strike. Captured per-rollover in `audit_log` as `is_strike_rollover: true|false`.

## 4. Money model

Per delivery, the system tracks:

| Field | What it means | Source |
|---|---|---|
| Customer Price | What the customer was supposed to pay | Manual at creation |
| Quantity Ordered | What customer ordered | From bot or manual |
| Quantity Delivered | What actually changed hands | Agent records at delivery |
| Paid | What was actually collected | Agent records |
| Payment Method | Cash or Transfer (defaults to Cash) | Agent records |
| Location | Geographic area (AI-matched to rate card) | Bot pipeline or manual |
| Charged | Reda's fee for the trip | Auto from rate card |
| Agent Payment | What Reda pays the agent | Auto from rate card |
| Cash POS Fee | ₦500 when cash + paid > 0, else 0 (since 2026-05-29) | Stamped server-side at delivered-time |
| Margin | Charged − Agent Payment | Computed |
| Remit | Paid − Charged − Cash POS Fee | Computed |

### Key money rules

**Remit is calculated from Paid, not from Customer Price.** This means **Reda never absorbs a customer underpayment.** If customer paid less than expected, the client receives proportionally less. Example (cash payment):

- Customer Price: ₦19,000 (the agreed price)
- Paid: ₦15,000 (what the customer actually gave the agent, in cash)
- Charged: ₦7,000 (Reda's location-based fee)
- Cash POS Fee: ₦500 (Reda's cost to bank the cash, passed through to the client)
- Remit to client: ₦15,000 − ₦7,000 − ₦500 = ₦7,500

For a transfer payment the Cash POS Fee is 0 and Remit = Paid − Charged.

**Cash POS Fee is a pass-through, not Reda revenue.** It represents the per-delivery cost a POS operator charges Reda to convert collected cash into a bank balance. The client absorbs it because their customer chose cash; if everyone paid by transfer, the fee wouldn't exist at all. Snapshotted at delivered-time so a future fee adjustment doesn't retroactively change historical remits — same pattern as Charged and Agent Payment. Hardcoded as ₦500 today; per-client variance would be a `clients.cash_pos_fee` column when actually needed.

**Rate card** drives Charged and Agent Payment. Keyed by Location only — same rate regardless of which agent does the delivery.

**Charged is per-trip, not per-unit.** Same fee whether agent delivers 1 unit or 5 to the same address.

**Per-client charge ceiling.** Each client row carries an optional `max_charge_per_delivery`. If set, the rate-card charge for the delivery's location is clamped to that cap at snapshot time. Null = no cap (default; most clients). Used for clients whose own threshold sits just below our rate for a location — Dentora in Ibeju-Lekki, for example — so we still take the trip at a small concession instead of skipping the order. Admin-only to set, edit, or clear (cleared via a dedicated "Remove cap" action so an empty form doesn't silently wipe a configured cap). The clamp lives in `effective_rate()`; `preview_delivery_charge()` returns the same numbers for the admin-side preview on the new-delivery screen.

**Rates are snapshotted** on the delivery at creation. Rate card edits don't affect existing deliveries.

**Admin can override** Charged or Agent Payment per-delivery (reason required).

**Agent earns only on successful deliveries** (Delivered). Failed/Cancelled = no agent payment.

**Daily remittance to clients (and agents).** Uzo reconciles every day. The reconciliation tab defaults to today, with chip presets for Yesterday / Last 7 days / Custom. Per-client report can be shared from the app via the system share sheet (plain text into WhatsApp). v1 shows the numbers + share; v2 adds a mark-as-remitted workflow.

**Remit math:**
- `customer_price` = what the customer is supposed to pay the agent for this trip (flat, per delivery — not per unit).
- `paid` = what the customer actually paid.
- `charged_snapshot` = Reda's per-delivery fee from `rate_card` for the delivery's location, snapshotted at create time.
- **Remit to client = paid − charged_snapshot.** Reda always takes its fee out of what was actually collected, never out of what was promised.
- Customer outstanding = `customer_price − paid` (the client's collection problem, not Reda's).

**Agent settlement to Reda:** rhythm to confirm. Cash and transfer recorded identically (no bank integration).

## 5. Partial deliveries

Customer ordered N units, agent delivers fewer. Common enough to model.

**The rule:** record what actually happened. If agent delivered 1 of 2 units:

- `quantity_ordered` = 2
- `quantity_delivered` = 1
- `paid` reflects payment for 1 unit
- Stock decrements by 1
- Status = Delivered

The remaining unit stays with the agent (default) or returns to warehouse — agent's choice at delivery time, dispatcher can adjust.

**Client rules influence what agent is allowed to do.** Free-form **client notes** field on each client record, displayed prominently on agent's delivery screen. Examples:

> *"Dentora: Do not deliver partial orders. If customer cannot take full order, mark as Failed Delivery."*

> *"Gizlab: Partial deliveries OK. Confirm with customer they're aware they're paying for less."*

Agent reads, agent follows. Audit log captures what actually happened.

## 6. Stock model

Stock is tracked at the (User, Product) level where "user" can be an agent or the warehouse — both modeled as `users` rows with `role IN ('agent', 'warehouse')`. `current_stock` is a view that always computes from raw movements; it never stores derived values and can never drift from itself.

**Two locations for stock:** agent's hand, warehouse (currently one — Shomolu).

**Movements:**
- **Delivery completion** — when a delivery flips to `delivered`, the view automatically decrements the assigned agent's holding by `quantity_delivered`.
- **Single-row stock adjustments** (`create_stock_adjustment`): `loss`, `theft`, `damaged`, `found`, `correction`, `bulk_intake`.
- **Paired stock adjustments** (`create_stock_transfer`, two atomic linked rows): `transfer` (agent↔agent), `warehouse_issue` (warehouse → agent), `warehouse_return` (agent → warehouse).

All stock movements are admin-only (`is_admin()` enforced in the RPCs).

**Workflows surfaced in the app:**
- **Receive stock** — the named entry point for vendor intakes. Bulk multi-row form. Defaults destination to the active warehouse user but allows direct-to-agent for field intakes. Each row enqueues a separate `bulk_intake` adjustment, so the queue dead-letters per-row rather than all-or-nothing.
- **New transfer — Warehouse issue / Warehouse return** — bulk multi-row mode for the high-volume warehouse-to/from-agents patterns (morning kit issue, end-of-day returns).
- **New transfer — Transfer (agent ↔ agent)** — single-row for the less common case.
- **Adjustment** — single-row form, reason picker scoped to write-off and correction reasons (no `bulk_intake` here; the Receive flow owns intake).
- **Stock screen tabs**: *By holder* (default — every active warehouse user is always shown, even when empty) and *By client* (per-client roll-up with warehouse vs agents split, tappable cards drill into a per-client detail with *Share with client* plain-text snapshot).

**Stock availability and auto-assignment** (since 2026-05-20):
- Auto-assign uses stock as a **soft preference** (`eligible DESC` sort), not a hard filter — stocked agents come first but stockless agents remain assignable as last resort.
- Creating + assigning a delivery never blocks on stock. `tg_notify_pickup_needed` pushes admins+dispatchers when the assignee is short and the agent's assignment push gets a pickup hint. The negative-stock notification stays as a safety net.
- The stock block now sits on **`change_delivery_status`** at the `'delivered'` transition: `current_stock(agent, product) >= quantity_delivered` or raise `insufficient_stock`. One chokepoint instead of two.

## 7. Status state machine

Status changes are validated against a state machine.

**Source of truth.** All valid statuses live in `public.delivery_status_defs(status, label, category, sort_order)`. `deliveries.current_status` and `delivery_status_history.{from_status, to_status}` are FK'd back to that table (since 2026-05-22). `delivery_status_transitions(from_status, to_status, requires_admin, requires_reason)` encodes the allowed edges, also FK'd. Adding a new status is a single insert in `delivery_status_defs` + the transition rows.

**Status categories** (current list — query `delivery_status_defs` for authoritative):
- Initial: Pending
- Active: Available
- Soft failure (retry-able): Not Answering, Number Busy, Switched Off, Tomorrow, Postponed, Follow Up, Not Connecting, Not Around, Will Call Back, Not Available, Picked Up, Waybilled
- Terminal: Delivered, Cancelled, Failed Delivery, Unserious, No Product, Rolled Over, Abandoned, Deferred To Client

**Forward transitions** (free, no special permissions):
- Pending → anything
- Active → terminal or soft failure
- Soft failure → Active, another soft failure, or terminal

**Backward/corrective transitions** require:
- A reason field
- Admin role only

**Every status change recorded in `delivery_status_history`** with: from, to, who, when (server time), when-the-user-said-it-happened, reason if required, notes. Immutable. Visible to everyone (read-only).

**Side effects re-derive from scratch** on every change. Reverting Delivered → Failed Delivery correctly reverses stock and money math.

**Stock guard at delivered** (since 2026-05-20): `change_delivery_status(... to='delivered' ...)` enforces `current_stock(assigned_agent_id, product_catalog_id) >= quantity_delivered` or raises `insufficient_stock`. This is the *only* place stock blocks a workflow — create/assign no longer check (see §6).

## 8. Edge case decisions

- **Marked-Delivered-by-mistake:** admin corrects; side effects auto-reverse.
- **Customer changes address mid-flight:** admin/dispatcher uses the **Edit** icon on the delivery detail (admin + dispatcher, pre-delivery statuses only). `update_delivery_fields` rewrites the row with a full audit-log diff; the screen acquires an `edit_locks` row first so a second admin opening it sees *"<Name> is editing this — Take over"* rather than racing.
- **Bot creates duplicate row:** admin soft-deletes one. (The bot pipeline dedupes on `wasender_message_id`, but two webhook submissions of the same order from different relays will both land — confirmed in the wild on 2026-05-16 when the contractor double-sent the same Ajudua/Ikorodu order from two phones.)
- **Bot can't determine vendor / address / which client's product:** row lands in `bot_inbound_messages.status='needs_review'`. Admin/dispatcher tap the row → in-app **Fix & create** screen with the form pre-filled from `parse_result`; pick the missing piece, submit. The created delivery is linked back to the inbound row via `resolve_inbound_to_delivery`. Spam / duplicate / not-a-real-order rows take the **Discard** path (`discard_inbound`) instead, moving them to `status='error'` with a reason.
- **Two admins go to call the same customer:** for soft-status deliveries (`not_answering` / `number_busy` / `switched_off` / `tomorrow` / `postponed` / `follow_up`), the delivery detail shows a yellow *"Needs follow-up"* banner with **I'll handle this**. The claim writes to `delivery_followups` (PK on `delivery_id`); peers see *"<Name> is handling this"* on the detail screen and as a small claimer-avatar pill on the deliveries list. The claim auto-clears the moment `current_status` changes (`tg_clear_followup_on_status_change`).
- **Stock count mismatch:** admin records a stock adjustment with reason.
- **Agent quits mid-day:** "deactivate agent" workflow prompts to disposition their stock.
- **Customer pays partial:** Reda never absorbs the loss. Remit = Paid − Charged.
- **Customer overpays:** allowed. Treated as tip / Reda discretion.
- **Partial delivery:** record what was actually delivered. Leftover stays with agent or returns to warehouse.
- **Location not in rate card:** delivery created with empty money fields, flagged as warning, quick-add to rate card available.
- **Same delivery synced twice (network glitch):** all mutations include client-generated UUID; server deduplicates.
- **Customer returns product after delivery:** out of scope for v1. Admin handles manually.
- **End-of-day rollover:** dedicated screen showing all unfinished deliveries.
- **Delivery scheduled for tomorrow:** `scheduled_date` field separate from `created_date`.
- **Bot parse failure:** "Parse Errors" view for admin.
- **Hard delete of completed delivery:** never. Soft delete / void only.
- **Agent doesn't open the app:** push notification + dispatcher sees "assigned but not acknowledged" deliveries and can directly contact the agent.
- **Auto-assignment is wrong:** Uzo reassigns in the app, audit-logged.
- **No agent has stock for an auto-assigned delivery:** delivery stays unassigned, surfaces for Uzo to handle (probably means issuing stock from warehouse first).
- **Admin manually assigns to a stockless agent:** allowed (matches operational reality — agents often pick up stock from warehouse en route). The agent's assignment push appends a *"pick up N from warehouse first"* hint, and a separate *"Stock pickup needed"* push goes to admins+dispatchers prompting a warehouse transfer. The negative-stock notification fires only if the agent then marks delivered without picking up.
- **AI low-confidence on address:** delivery goes to Needs Review queue with raw address visible.
- **Gemini/Maps API down or slow:** bot queues the delivery without location, retries the API call; if still failing after N retries, surfaces in Needs Review queue.
- **AI returns wrong location:** Uzo corrects in the app; correction logged in the address-match audit data for future analysis.

## 9. Outstanding questions for Uzo

The important section. Please respond to whichever apply:

1. **Single parsing channel + auto-assign direction.** v1 plans to eliminate the per-agent WhatsApp groups. Instead, you forward client messages to one parsing channel. The bot extracts details, normalizes the address using Maps + Gemini, auto-assigns an agent based on stock + location + workload, and notifies the agent. You only open the app for exceptions (Needs Review, overrides, end-of-day, reconciliation). Does this match how you'd want to operate?

2. **Auto-assignment factors.** The system would consider: who has stock, agent's preferred location, current pending workload, total stock held. Anything else important to how you currently decide manually? (E.g., agent strength, time of day, specific customer history?) Those would need to be factors too, or accepted as cases where you override.

3. **Bot vendor source.** When you forward to the parsing channel, where does the vendor name come from? Is it in the client's original message? Do you add it when reformatting? Or should the bot infer it from which original client group the message came from?

4. **Client messages structured enough?** Do clients send messages clean enough that the bot can parse them, or do you currently rewrite when forwarding?

5. **Agent settlement rhythm.** ~~When does the agent remit collected money to Reda? Daily? Weekly? End-of-route?~~ **Resolved (2026-05-15):** daily. Reconciliation tab defaults to today and Uzo squares up with each agent + each client end-of-day.

6. **Rate card structure.** Can Paschal see your current rate card? Confirmed it's keyed by location only?

7. **End-of-day timing.** Do you do the rollover workflow at a fixed time, or whenever you get to it?

8. **Permission edge case.** Can a dispatcher mark a delivery Delivered without input from the agent, or must updates come from the agent directly?

9. **Client rules format.** Free-form text notes per client sufficient, or do you have specific rules across many clients that would benefit from being structured (toggleable flags)?

10. **Make.com retirement.** v1 replaces the Make.com automation. Anything it does we're missing?

11. **Push notifications.** Are all agent phones capable (recent Android, app not battery-restricted)?

12. **Agent location preferences.** v1 will let you set each agent's preferred location(s) or home zone. Is "home zone" the right concept, or do agents have multiple preferred areas?

13. **AI confidence thresholds.** The system will auto-fill location on high confidence, flag it on medium, and route to Needs Review on low. We can tune these thresholds based on early data — but want your gut feel on how aggressive auto-fill should be vs. how much you want to review.

14. **Anything missing?** Flag it.

## 10. v1 scope (what ships first)

**In v1:**
- Auth (login, role assignment)
- Setup screens (users with location preferences, clients with notes, products, locations, rate card) — admin only
- Delivery creation (manual + via bot), view, edit, soft-delete
- **AI-assisted address normalization** (Google Maps + Gemini)
- **Auto-assignment** (stock + location + workload scoring)
- **Manual reassignment** override in app
- Push notifications, multi-device:
  - Agent on every assignment (`deliveries` trigger) — body appended with *"pick up N from warehouse first"* if their stock is short.
  - Admin + dispatcher when an agent is manually assigned without enough stock (`tg_notify_pickup_needed`).
  - Admin + dispatcher when the bot's parse queue grows (`bot_inbound_messages` `needs_review`).
  - Admin on terminal status changes — delivered, cancelled, failed_delivery, unserious, no_product (`tg_notify_delivery_status_change`).
  - Admin when an agent's stock goes negative (`stock_adjustments` post-insert balance check).
  - Admin daily at 20:00 Lagos if anything is still pending past its scheduled date (Supabase scheduled Edge Function + Cron job).
  - Tokens stored per-device in `push_tokens`; fan-out via the generic `send-notification` Edge Function with auto-pruning of `DeviceNotRegistered`.
- Account self-service: edit own profile (display name + phone), change own password (re-auth + `auth.updateUser`), forgot password (`resetPasswordForEmail`), optional biometric unlock gate (`expo-local-authentication`), and on-demand JS bundle pulls via *Check for updates* (`expo-updates`).
- Agent location preferences with **soft-avoid** tier (`agent_locations.kind IN ('preferred','avoid')`) — auto-assign ranks tier 1 (preferred) → tier 2 (neutral) → tier 3 (avoid) before falling through to workload/stock/random.
- Bulk warehouse transfer (issue + return) — multi-row form fans out to N `create_stock_transfer` calls via the existing queue.
- Bulk receive — multi-row vendor intake recorded against warehouse (default) or an agent directly.
- Per-client stock view + shareable plain-text snapshot.
- Status updates with state machine validation + history
- Agent stock view + warehouse stock view
- Stock adjustments (admin, 9 reasons)
- Per-client view (Remit owed) — daily-first, range-selectable, with per-delivery drill-down and **Share with client** plain-text report
- Per-agent view (earnings) — daily-first, range-selectable
- Daily Summary tab (Reda's own P&L) with shareable summary text
- Daily dashboard
- End-of-day rollover workflow
- Agent mobile experience (own deliveries, tap-to-call, status update, payment record, partial delivery, own stock, own earnings, client notes visible)
- Audit log + status history (visible to all, read-only)
- Online-with-resilience
- Single parsing channel for bot ingestion
- Needs Review queue for parse failures and low-confidence matches **with an in-app Fix & create flow** — admins/dispatchers tap a row, pre-filled form opens, they pick the missing location/product/client, submit, and the inbound row is linked back to the created delivery. Spam / duplicate rows take the **Discard with reason** path.
- **Pre-delivery edit of customer-facing fields** (admin + dispatcher only) — name, phone, address, product, quantity, customer price, location, agent. Frozen once the delivery is in a terminal status.
- **Edit lock** primitive (`edit_locks` table + acquire/release/heartbeat RPCs) gating both the Fix-review screen and the Edit-delivery screen so two admins can't silently overwrite each other.
- **Follow-up claim** on soft-status deliveries (`delivery_followups`) — first admin/dispatcher to call the customer claims it; peers see "<Name> is handling this" until the status changes.
- **In-app help guide** — role-aware sections rendered via `react-native-markdown-display` in collapsible cards; AppBar `?` icon deep-links to the topic for the current screen. The printable `reda_admin_runbook.md` is generated from `mobile/src/help/content.ts` by `mobile/tools/build-runbook.mjs`; `check:runbook` guards against drift.

**Explicitly out of v1 (v2 or later):**
- Outbound WhatsApp from app
- Customer returns workflow
- Auto-status detection (GPS, photo)
- Maps integration on agent app (for turn-by-turn navigation)
- Advanced analytics / CSV export
- Client portal
- Full offline-first
- Bulk delivery actions (multi-select)
- Mark-as-remitted workflow
- Structured client rules (toggleable)
- Smarter auto-assignment learning (currently rule-based scoring; ML version is v3+)
- AI fine-tuning on Reda's address data (use logged data; fine-tune in v2 if quality justifies it)

## 11. Build timeline

Realistically 8-12 weeks for v1 given Paschal's other commitments. Full-time would be 5-6 weeks. The biggest complexity factors:

- Agent app + push notifications
- Auto-assignment logic
- AI address normalization pipeline (Maps + Gemini integration, prompt iteration, confidence handling)

The intent: ship v1, Uzo's team uses it for a few weeks, then v2 is informed by actual usage rather than theory.

---

## 12. Internal voice calling (added post-v1 PRD)

Reda's day-to-day coordination has historically run on WhatsApp — agent rings admin, admin rings agent, both burn personal airtime and the call trail lives outside the system. PRD §5.17 brings that comms layer inside the app.

**What it is.** Any active internal user can place a 1:1 voice call to any other active user. The OS rings with the user's chosen system ringtone (no custom audio bundled). Full lock-screen UI, Bluetooth headset accept/end, system call-log entry — same model WhatsApp uses on Android, because under the hood it's the same Android telecom framework (`ConnectionService`).

**Audio path.** Agora Voice SDK. App ID is public, App Certificate stays server-side only. RTC tokens are minted by a Supabase Edge Function (`issue-agora-token`) with a 5-minute TTL; refreshed automatically via Agora's `onTokenPrivilegeWillExpire`. Agora's free tier (10k voice minutes/month) covers Reda's projected ~1.2k min/month indefinitely. **Crucially: audio never touches Supabase storage** — peer-to-peer through Agora's SD-RTN. Zero impact on the storage quota.

**Three signaling layers, one job each:**
- **Push** wakes the device. A trigger on `calls` insert calls `send_edge_notification` → `send-notification` Edge Function with `audience: 'call_invite'` → Expo Push API → callee's device wakes up.
- **Supabase Realtime** is state truth after wake. App-wide subscription filtered to `callee_id = <me>` for incoming-call detection; per-call subscription on the in-call screen for state updates.
- **CallKeep** owns the ring UX. Once a ringing row arrives, the app calls `RNCallKeep.displayIncomingCall(...)` and the system takes over with the native phone-call UI.

**Multi-device guarantee.** A user signed in on N phones gets rings on all N. The first to accept wins — enforced atomically at the DB layer (`update calls set status='accepted' where status='ringing' returning *` — zero-row return raises `40001`). The losing device's Realtime subscription sees the row flip and dismisses CallKeep with no toast spam. Agora UIDs are derived from per-device UUIDs (FNV-1a 32-bit hash) so any accidental duplicate join gets kicked deterministically.

**Why not Twilio / PSTN / WebRTC raw?** Costs and tech debt:
- Twilio/Africa's Talking — adds telco minutes ($0.04–$0.08/min) + Nigerian SIM regulatory complexity. Only worth it if calling external numbers.
- Raw `react-native-webrtc` — free but requires self-hosting a STUN/TURN server for NAT traversal on the Lagos network. Operational pain not worth it at this scale.
- LiveKit cloud — similar pricing to Agora, less mature RN SDK for Android-only.

**What's NOT in scope (v2+ candidates):** group calls (3+), video, call recording, presence/online dots, PSTN bridging to customers, iOS (CallKeep already wraps iOS CallKit via the same JS API for when iOS lands).

Implementation lives in [reda_prd.md §5.17](reda_prd.md) and the migration script [`scripts/internal-calls.sql`](scripts/internal-calls.sql). Edge functions: [`supabase/functions/issue-agora-token`](supabase/functions/issue-agora-token), [`supabase/functions/send-notification`](supabase/functions/send-notification) (extended with the `call_invite` audience).

---

*Last updated: 2026-05-19. §12 added when voice calling shipped on top of v1.*
