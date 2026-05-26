# Reda Logistics App — PRD v0.1

A build-focused product requirements doc for v1 of the Reda Logistics mobile app. Written for Paschal as the builder. References [`reda_system_design_doc.md`](./reda_system_design_doc.md) for the why-and-what; this doc covers the how.

**Status:** Draft. Awaiting Uzo's feedback on system design doc Section 9 before locking. Some sections marked `[pending Uzo]` will be tightened once his answers are in.

---

## 1. Overview

A mobile app that replaces Google Sheets, Make.com, and internal WhatsApp coordination for Reda Logistics' delivery operations. Built for one admin (Uzo), eventual dispatchers, and ~5 delivery agents.

See system design doc for full context. This PRD assumes you've read it.

---

## 2. v1 success criteria

v1 is shippable when these are true:

- Uzo can do a full delivery day in the app without touching the spreadsheet
- Agents can receive assignments, update statuses, and record payments from the app
- The bot ingests forwarded WhatsApp messages and creates assigned deliveries with AI-normalized locations
- Stock auto-decrements on delivery, never drifts from movement history
- Per-client weekly Remit and per-agent weekly earnings are queryable
- Make.com automation can be retired safely

**Not required for v1:**
- Maps navigation, customer returns, push to clients, advanced analytics — see system design doc Section 10

**Implicit:** Reda's daily operation continues to work during the cutover. The app and old workflow can run in parallel for a transition period.

---

## 3. Tech stack

- **Mobile app:** React Native via Expo (SDK 51+)
- **Backend:** Supabase (Postgres + Auth + Storage + Realtime + Edge Functions)
- **AI:** Gemini Flash via Google AI API + Google Maps Geocoding API
- **Push:** Expo Push API
- **Hosting:** Supabase managed (free tier for v1)
- **Source control:** Git, GitHub

Schema lives in `reda_schema.sql`.

---

## 4. Data model summary

12 tables + 1 view. See `reda_schema.sql` for full SQL.

Core entities: `users`, `agent_profiles`, `clients`, `product_catalog`, `locations`, `rate_card`, `deliveries`, `delivery_status_history`, `stock_adjustments`, `agent_location_preferences`, `audit_log`, `address_match_log`. View: `current_stock`.

Key patterns:
- UUIDs everywhere
- Soft delete via `deleted_at`
- RLS enabled on all tables with role-based policies
- `current_status` denormalized on deliveries; `delivery_status_history` is source of truth
- `charged_snapshot` + `agent_payment_snapshot` on deliveries (rates frozen at creation)
- `client_uuid` on mutation tables for idempotency
- Money rule: `Remit = Paid − Charged` (Reda never absorbs underpayment)

---

## 5. Features

Each feature below is a discrete unit of work. Order doesn't imply build order — see Section 7 for that.

### 5.1 Authentication

**User story:** As any user, I can log in to the app with email + password.

**Screens:**
- Login screen (email + password)
- Logout from a profile/settings menu

**Logic:**
- Use Supabase Auth (email + password)
- On successful login, fetch the user's row from `public.users` to determine role
- Store the role in app state for permission checks
- If user is `is_active = false`, reject login with "Account deactivated"
- Persist session locally so user stays logged in across app restarts

**Edge cases:**
- Invalid credentials → standard error
- Network down → "Cannot connect, check your connection"
- User exists in `auth.users` but not `public.users` → likely a bug; show "Account setup incomplete, contact admin"

**Acceptance:**
- Login works for admin, dispatcher, agent, warehouse roles
- Session persists across app restart
- Deactivated users cannot log in

---

### 5.2 User & agent management (admin)

**User story:** As admin, I can create, edit, and deactivate users (admins, dispatchers, agents).

**Screens:**
- Users list (admin only)
- User detail / edit form
- Create user form

**Logic:**
- Create user creates rows in both `auth.users` (via Supabase Admin API) and `public.users`
- Agent role creation also creates `agent_profiles` row
- Editing a user can change display_name, phone, role, is_active
- Deactivating an agent triggers the stock disposition workflow (see 5.10)
- Phone number stored for tap-to-call by agents (and for future direct outreach)

**Validation:**
- Email must be unique (DB enforces)
- Role must be one of the four enum values
- Display name required, non-empty
- If role = 'agent', delivery_capacity must be a positive integer

**Edge cases:**
- Reactivating a previously deactivated agent — restore profile but don't auto-restore stock
- Role change from agent to non-agent — agent_profile row stays for audit; agent_id references remain valid

**Acceptance:**
- Admin can create all four role types
- Agent creation also creates agent profile
- Deactivation prompts stock handling
- All operations write to audit_log

---

### 5.3 Catalog management (admin)

**User story:** As admin, I manage clients (vendors), products, locations, and rate cards.

**Screens:**
- Clients list + detail
- Products list + detail (grouped by client)
- Locations list + detail
- Rate card view (locations × current rates)

**Logic:**
- Clients have name, notes (free-form rules visible to agents), contact info
- Products are (client, product_name) pairs — same product from different clients = different rows
- Locations have name, aliases (text array for AI matching), optional lat/long
- Rate card holds current rate per location; editing creates a new row and closes the old one (effective_until set)

**Validation:**
- Client name unique
- Product (client_id, product_name) unique
- Location name unique
- Rate card: charged ≥ 0, agent_payment ≥ 0

**Edge cases:**
- Deactivating a client should also deactivate its products
- Deactivating a location: existing deliveries to that location still work; new ones to that location are blocked
- Changing a rate card mid-day: existing deliveries keep snapshotted rates

**Acceptance:**
- Admin can manage all catalog entities
- Rate changes are time-bounded, never destructive
- Soft-deactivation works (no hard deletes)

---

### 5.4 Delivery creation (manual)

**User story:** As admin or dispatcher, I can manually create a new delivery in the app.

**Screens:**
- Create delivery form

**Form fields:**
- Customer name (required)
- Customer phone (required)
- Raw address (required, free text)
- Client (dropdown from active clients)
- Product (dropdown from active products for that client)
- Quantity ordered (required, positive int)
- Customer price (required, decimal)
- Location (dropdown; auto-suggest based on raw address if AI normalization is enabled for manual creates)
- Scheduled date (default today)
- Assigned agent (dropdown, optional — empty means use auto-assignment)

**Logic:**
- On submit, if location is set, copy `charged` and `agent_payment` from rate_card to snapshot fields
- Status = 'pending'
- If assigned_agent_id set manually, push notify them
- If unassigned, run auto-assignment (see 5.6)
- Insert initial row in `delivery_status_history` (`from_status` = null, `to_status` = 'pending')
- `created_via` = 'manual'

**Edge cases:**
- Location not in rate card → save delivery with null charged/agent_payment snapshots, flag warning
- Network drops during submit → mutation queues locally (see 5.16)
- Customer phone format → no strict validation, accept whatever Uzo types

**Acceptance:**
- Creates delivery row with all required fields
- Money snapshots populated correctly
- Initial history row created
- Auto-assignment runs if agent left blank

---

### 5.5 Delivery creation (bot pipeline)

**User story:** As Uzo, I forward client messages to a parsing channel; the bot creates a delivery.

**Components:**
- WhatsApp listener (separate from the app — likely an Edge Function or external service)
- Parser (LLM-assisted or regex-based)
- Address normalization (Maps + Gemini)
- Delivery creator

**Logic flow:**
1. Message arrives in parsing channel
2. Parser extracts: customer name, phone, address, product mention, qty, customer price, vendor reference [pending Uzo]
3. Match vendor (client) to `public.clients`
4. Match product to `product_catalog` (for that client)
5. Address normalization (see 5.6)
6. Auto-assignment (see 5.7) — assigns agent
7. Insert delivery row with `created_via = 'bot'`, `bot_raw_message` = original text
8. Insert initial history row
9. Push-notify assigned agent

**Edge cases:**
- Parse failure → write to `address_match_log` or a new `parse_errors` log with raw text; surface in Needs Review queue
- Vendor unknown → delivery created with `client_id` = special "unassigned" record or marked for review
- Product unknown → delivery created but flagged
- Duplicate message (idempotency) → bot can hash the message text + timestamp to avoid double-creating

**Acceptance:**
- Bot successfully parses sample messages from current bot's training data
- Failed parses go to Needs Review, not silently dropped
- All bot-created deliveries have non-null `bot_raw_message`

**Implementation note:** the existing bot architecture should be reused where possible. We're changing what channel it watches and where it writes (DB instead of Sheets). The parsing logic itself may be largely the same. Coordinate with whoever maintains the current bot.

---

### 5.6 AI address normalization

**User story:** As the system, I match a raw customer address to a known location from the rate card.

**Pipeline (runs during delivery creation):**

1. Send raw address to Google Maps Geocoding API
2. If Maps returns a recognizable neighborhood: pass Maps' structured output + rate card location list to Gemini
3. If Maps returns nothing useful: pass raw address + rate card list to Gemini directly
4. Gemini returns:
   ```json
   {
     "matched_location_id": "uuid or null",
     "confidence": "high | medium | low | none",
     "reasoning": "1-2 sentence explanation"
   }
   ```
5. Outcome:
   - `high` → set delivery.location_id automatically
   - `medium` → set delivery.location_id but flag the delivery for admin review
   - `low` / `none` → leave location_id null; delivery goes to Needs Review queue

6. Insert row in `address_match_log` with all inputs/outputs

**Confidence calibration [pending Uzo's input on his preference]:**
- Default thresholds: tune after first month of real usage
- All AI matches logged with raw inputs so accuracy can be analyzed

**Error handling:**
- Maps API timeout (>5s) → fall through to Gemini-only
- Gemini API timeout (>10s) → set location_id = null, surface in Needs Review
- API quota exceeded → log error, queue delivery for retry

**Prompt sketch for Gemini (iterate on this):**
```
You are normalizing Nigerian delivery addresses to a known list of locations.

Known locations: [list from rate_card]
Maps API response: [if available]
Raw address: "{raw_address}"

Match the address to ONE known location. Return JSON:
{
  "matched_location_id": "string or null",
  "confidence": "high | medium | low | none",
  "reasoning": "1-2 sentences"
}

Rules:
- "high" = clear match, named in address
- "medium" = strong inference from landmarks/context
- "low" / "none" = ambiguous; return null
```

**Acceptance:**
- Maps + Gemini integration works end-to-end
- All matches log to address_match_log
- Failed matches surface in Needs Review queue
- Cost stays within budget (estimated ₦4.5k-9k/month)

---

### 5.7 Auto-assignment

**User story:** As the system, I pick the best agent for a new delivery.

**Algorithm:**
```
function assignAgent(delivery):
  candidates = users where role='agent' and is_active=true

  # Stock filter
  candidates = filter where agent has current_stock for delivery.product_catalog_id >= delivery.quantity_ordered

  if candidates is empty:
    return null  # unassigned, surfaces in Needs Review

  # Score each candidate
  for agent in candidates:
    location_score = priority_score for (agent, delivery.location_id) from agent_location_preferences (default 50 if not set)
    workload_score = 100 - (10 * agent.pending_workload)  # penalize busy agents
    stock_score = min(10, agent.stock_for_product / delivery.quantity_ordered)
    total = location_score * 0.5 + workload_score * 0.3 + stock_score * 0.2

  return agent with highest total
```

**Tie-breakers:**
- Higher current stock wins
- If still tied, alphabetical by display_name (stable, deterministic)

**Logic:**
- Run once at delivery creation
- Result stored in `assigned_agent_id`
- If Uzo reassigns later (5.8), the original assignment + override is logged in audit_log

**Edge cases:**
- No agent has stock → null assignment, delivery in Needs Review
- All agents deactivated → null, surfaces immediately
- Algorithm output is "wrong" by Uzo's judgment → he overrides in the app

**Acceptance:**
- Deterministic given same inputs
- Always returns null rather than a bad assignment when constraints can't be met
- Logs reasoning to audit_log (which factors contributed)

---

### 5.8 Delivery list + detail (all roles)

**User story:** Each user sees the deliveries relevant to them.

**Screens:**
- Delivery list (filterable)
- Delivery detail

**List view by role:**
- **Agent:** today's assigned deliveries (RLS filters automatically). Sort: status priority (Available → Pending → soft failures → terminal), then scheduled time.
- **Dispatcher/Admin:** all deliveries. Filter by date, agent, status, client, location. Default view: today.

**Detail view shows:**
- Customer info: name, phone (tap-to-call), raw address (tap to open in maps app)
- Product: name, quantity_ordered
- Money: customer_price; for admin also charged, agent_payment, margin, remit; for agent also their agent_payment if delivered
- Client name and notes (prominent — these are the client rules)
- Status with state machine UI (only valid transitions clickable)
- Status history timeline (everyone reads, no one edits)
- Notes field (editable)
- Parent delivery reference if this is a rollover

**Logic:**
- RLS on `deliveries` handles role-based filtering automatically
- Tap-to-call uses native `tel:` URL
- Tap-to-open-address uses platform-specific URL (`geo:` on Android)

**Edge cases:**
- Customer phone is invalid format → tap-to-call still attempts, OS handles failure
- Status history is empty (somehow) → shouldn't happen, but show "no history" message defensively

**Acceptance:**
- Agent sees only own deliveries
- Admin sees everything including margin
- Dispatcher sees everything except margin
- Tap-to-call works on both Android and iOS

---

### 5.9 Status updates + state machine

**User story:** As an agent, I update a delivery's status. As admin, I can correct status (backward transitions).

**Status state machine:**

| From | To | Allowed by | Reason required |
|---|---|---|---|
| pending | available, soft failures, terminal | agent, dispatcher, admin | no |
| available | terminal, soft failures | agent, dispatcher, admin | no |
| soft failure | available, soft failure, terminal | agent, dispatcher, admin | no |
| terminal | any | admin only | yes |

Where:
- soft failures = not_answering, number_busy, switched_off, tomorrow, postponed, follow_up
- terminal = delivered, cancelled, failed_delivery, unserious, no_product

**UI for status change:**
- Status field on delivery detail shows current status
- Tap to change → modal with valid next statuses (state machine filters options)
- If transition is backward, modal also requires a reason (text field)
- If new status = 'delivered': prompt for `quantity_delivered` (default = quantity_ordered) and `paid` + `payment_method`
- If client_rules say "no partial deliveries" and `quantity_delivered < quantity_ordered`: warn but allow (audit will capture)

**Logic:**
- Insert row in `delivery_status_history`
- Update `current_status` on delivery
- If transition = 'delivered': set `quantity_delivered`, `paid`, `payment_method`
- If transition = 'cancelled' and previous was 'delivered': reverse the stock decrement (no explicit code needed; current_stock view recomputes from history)
- All in a single transaction via Postgres function (see 5.15)

**Edge cases:**
- Concurrent status updates (agent and dispatcher both updating same delivery) → last write wins via timestamp; both rows in history
- Network drop during status update → mutation queues locally, retries
- Reverting Delivered to something else after stock has been physically delivered → admin only, with reason logged

**Acceptance:**
- State machine enforces valid transitions
- Side effects (stock, money) correctly reflected via current_stock view
- All status changes audit-logged via history table
- Idempotent on retry (client_uuid)

---

### 5.10 Stock management

**User story:** As admin, I manage stock adjustments. As agent, I see my current stock.

**Screens:**
- Agent: "My stock" list (read-only) showing current_stock for them
- Admin: stock view showing all agents + warehouse, stock adjustment form

**Adjustment form fields:**
- Agent (dropdown, includes warehouse user)
- Product (dropdown from active product_catalog)
- Quantity delta (signed int, non-zero)
- Reason (dropdown from 9 reasons)
- Notes (optional)
- For Transfer reason: also pick "related agent" → creates two paired rows

**Logic:**
- Insert into stock_adjustments
- For transfers, insert two rows linked by `related_adjustment_id`
- Idempotent via `client_uuid`

**Validation:**
- quantity_delta != 0
- Reason in allowed enum
- Transfer reason requires related agent

**Edge cases:**
- Adjustment that would push stock negative → allow, but flag visually in current_stock view (could mean data entry error or actual debt)
- Transferring to/from warehouse → uses the warehouse user role
- Reversing a wrong adjustment → admin inserts an opposite adjustment with reason "correction"

**Acceptance:**
- All 9 reasons supported
- Transfers create linked rows
- current_stock view reflects adjustments immediately
- Agent can see own stock but cannot adjust

---

### 5.11 End-of-day rollover

**User story:** As admin, at end of day I review unfinished deliveries and decide what to do with each.

**Screens:**
- End-of-day screen, shown when admin opens app after [pending Uzo's preferred time]

**List view:**
- All deliveries with non-terminal status from today (or earlier)
- Each row shows: customer, agent, product, status, days-in-this-status

**Per-row actions:**
- Cancel: status → cancelled (terminal)
- Roll over to tomorrow:
  - Sub-option: same agent, stock stays
  - Sub-option: different agent, transfer stock (pick new agent)
  - Sub-option: return to warehouse, reassign tomorrow

**Logic:**
- "Cancel" → status change with reason "End of day cleanup"
- "Roll over" → 
  - Create new delivery row with `parent_delivery_id` = original
  - Set `scheduled_date` = tomorrow
  - Copy customer info, product, quantity, customer_price
  - Old delivery's status changes to terminal-ish (probably "follow_up" or specific "rolled_over" status — [pending Uzo, may want a new status])
  - For stock transfer sub-options: create paired stock_adjustments

**Edge cases:**
- 0 unfinished deliveries → show celebratory empty state
- 20+ unfinished → batch UX with bulk actions
- Admin closes app mid-rollover → partial state is fine, can resume

**Acceptance:**
- Each unfinished delivery has a clear action
- Stock dispositions correctly handled
- New rollover rows have parent_delivery_id set
- Audit log captures the rollover decision

---

### 5.12 Reconciliation views

**User story:** As admin, I see per-client weekly Remit owed and per-agent weekly earnings.

**Screens:**
- Reconciliation tab with two views:
  - Per-client: client → date range → total Remit, breakdown by delivery
  - Per-agent: agent → date range → total earnings, breakdown by delivery

**Logic:**
- Per-client Remit: `SUM(paid - charged_snapshot) WHERE current_status = 'delivered' AND client_id = ? AND created_date BETWEEN ?`
- Per-agent earnings: `SUM(agent_payment_snapshot) WHERE current_status = 'delivered' AND assigned_agent_id = ? AND created_date BETWEEN ?`

**Edge cases:**
- Partial payments: still uses snapshotted charged, Remit = actual paid - charged
- Voided deliveries: excluded automatically (deleted_at filter)
- Date range crossing rate changes: snapshots ensure historical rates

**Acceptance:**
- Numbers match manual SUMs from raw delivery rows
- Date range controls work
- Drill-down to individual deliveries from totals

---

### 5.13 Agent earnings view (agent)

**User story:** As an agent, I see my per-delivery and per-period earnings.

**Screens:**
- "My earnings" tab on agent app

**Views:**
- Today: sum of agent_payment_snapshot for delivered today
- This week: same, for week to date
- This month: same, month to date
- List view: each delivered delivery with its agent_payment_snapshot

**Logic:**
- Filter to current user's deliveries only (RLS)
- Only count delivered status

**Acceptance:**
- Agent sees own earnings only
- Numbers match admin's per-agent view for same agent + same date range

---

### 5.14 Push notifications

**User story:** As an agent, I get notified when a new delivery is assigned to me.

**Implementation:**
- Expo Push API
- On user login, request notification permission
- Store Expo push token in `users.notes` field or new column (TODO: add column to schema if not already there) — actually, add `expo_push_token` column to public.users in a follow-up migration
- On delivery creation with `assigned_agent_id` set: send push to that agent's token

**Notification content:**
- Title: "New delivery"
- Body: "Customer name — Location — Product × Qty"
- On tap: open the app to that delivery detail

**Edge cases:**
- No push token (didn't grant permission) → silently fail, log warning
- Token invalid (expired) → catch error, mark token null, prompt re-grant on next login
- Android battery optimization killing notifications → document for Uzo to instruct agents

**Acceptance:**
- New assignment triggers notification within 30 seconds
- Tapping notification opens correct delivery
- Permission flow works on first login

---

### 5.15 Atomic operations (Postgres functions)

**User story:** As the API layer, I can perform complex multi-table operations in a single transaction.

**Functions to write:**

```sql
-- Change delivery status with all side effects in one transaction
create or replace function public.change_delivery_status(
    p_delivery_id uuid,
    p_to_status text,
    p_reason text,
    p_notes text,
    p_quantity_delivered int,
    p_paid decimal,
    p_payment_method text,
    p_client_uuid text,
    p_effective_at timestamptz
) returns void ...

-- Create a delivery with auto-assignment and history initialization
create or replace function public.create_delivery(
    -- many params
) returns uuid ...

-- Rollover delivery: cancel old, create new, handle stock
create or replace function public.rollover_delivery(
    p_delivery_id uuid,
    p_disposition text,        -- 'same_agent' | 'different_agent' | 'warehouse'
    p_new_agent_id uuid,       -- if 'different_agent'
    p_client_uuid text
) returns uuid ...
```

These will be written in a separate `reda_functions.sql` file. Pattern: use `security definer` so they run with elevated privileges, but check user permissions internally.

---

### 5.16 Online-with-resilience

**User story:** When the agent's network drops, the app continues working and syncs when network returns.

**Implementation:**
- Use a local SQLite cache for current screen's data (Expo SQLite or WatermelonDB-lite setup)
- Mutation queue: every state-changing API call goes through a queue
- Queue persists across app restarts
- On network return: drain queue
- Each mutation includes `client_uuid` for idempotency on retry

**UI states:**
- Online: standard
- Slow (mutation queued > 5s): "Saving..." indicator
- Offline (no network): banner "You're offline — changes will sync when you reconnect"
- Sync error after multiple retries: red banner, "Some changes failed to sync — tap to review"

**Scope for v1:**
- Status updates: queued + retried
- Payment recording: queued + retried
- Other mutations (delivery creation, stock adjustments): require network (admin features, network is usually fine in warehouse)

**Edge cases:**
- Mutation succeeds on server but app didn't get the response (network drop after server received) → idempotency via client_uuid handles this
- App killed before queue flushes → queue persists, drains on next launch
- User logs out with pending mutations → block logout or flush first

**Acceptance:**
- Agent can update statuses offline; changes sync within 60 seconds of network return
- No data loss across app restart
- No duplicate mutations from retries

---

## 6. Non-functional requirements

### Performance
- App cold start: < 3 seconds on a low-end Android (Tecno/Infinix mid-range)
- Delivery list load: < 1 second for 100 deliveries
- Status update: < 500ms perceived (optimistic UI)

### Security
- All API access through Supabase RLS — no service role keys in the app
- Push tokens hashed before logging
- No PII (customer phone numbers) in client-side logs or analytics
- Margin data never reaches non-admin clients (RLS-enforced)

### Reliability
- App crashes captured (Sentry or similar) — out of v1 scope but plumbing should be ready
- Database backups: Supabase free tier includes daily backups, retention 7 days

### Accessibility
- Tap targets minimum 44px
- Tested in bright sunlight (Lagos outdoor usage)
- Status colors should not rely on color alone (also use text/icon)

---

## 7. Build order

Suggested sequence. Each milestone is independently testable.

### Milestone 1: Foundation (week 1-2)
- Expo project setup
- Supabase client + auth integration
- Login screen + role-based routing
- User & catalog management screens (admin only)
- **Demo:** admin can create users, clients, products, locations, rate card

### Milestone 2: Manual delivery flow (week 3-4)
- Manual delivery creation (5.4)
- Delivery list + detail (5.8)
- Status state machine (5.9)
- Stock adjustments (5.10)
- **Demo:** admin can create delivery, assign manually, mark delivered, see stock decrement

### Milestone 3: Agent app (week 5-6)
- Agent login + role-specific UI
- Agent delivery list, detail, status updates
- My stock view, my earnings view (5.13)
- Push notifications (5.14)
- **Demo:** agent receives push, opens app, marks delivered

### Milestone 4: Reconciliation + EOD (week 7)
- Reconciliation views (5.12)
- End-of-day rollover workflow (5.11)
- **Demo:** full week of operations, Uzo runs weekly reconciliation

### Milestone 5: Bot + AI pipeline (week 8-10)
- Bot integration (reads from parsing channel, creates deliveries)
- AI address normalization (Maps + Gemini)
- Needs Review queue
- **Demo:** Uzo forwards real client messages, bot creates real deliveries, AI normalizes addresses

### Milestone 6: Polish + offline (week 11-12)
- Online-with-resilience (5.16)
- Error handling + edge case coverage
- Performance pass
- Beta with Uzo + 1 agent
- **Ship v1**

This is 12 weeks part-time. Compress by 30-40% if going full-time.

---

## 8. Open questions

Items deferred until Uzo's feedback on system design doc Section 9:

1. Bot vendor source resolution
2. Confidence thresholds for AI normalization
3. End-of-day timing preference
4. Dispatcher delivery-marking permission
5. Push notification readiness across all agent phones
6. Client rules format (free-form vs structured)
7. Agent settlement rhythm (for v2 mark-as-settled features)
8. Anything else Uzo flags

---

## 9. Out of scope (v2 candidates)

Tracking for future. Don't build any of these in v1.

- Outbound WhatsApp from app (status notifications to clients)
- Customer returns workflow
- Auto-status detection (GPS, photo confirmation)
- Maps integration on agent app (turn-by-turn navigation)
- Advanced analytics / CSV export
- Client portal
- Full offline-first (only "online-with-resilience" in v1)
- Bulk delivery actions (multi-select)
- Mark-as-remitted workflow
- Structured client rules (toggleable flags)
- Smarter auto-assignment learning (ML-based)
- AI fine-tuning on Reda's address data


---

*Last updated: this conversation. Will be revised when Uzo's Section 9 feedback comes in.*
