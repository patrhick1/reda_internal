# Reda Logistics App — PRD v0.1

A build-focused product requirements doc for v1 of the Reda Logistics mobile app. Written for Paschal as the builder. References [`reda_system_design_doc.md`](./reda_system_design_doc.md) for the why-and-what; this doc covers the how.

**Status:** Draft. Awaiting Uzo's feedback on system design doc Section 9 before locking. Some sections marked `[pending Uzo]` will be tightened once his answers are in.

---

## 1. Overview

A mobile app that replaces Google Sheets, Make.com, and internal WhatsApp coordination for Reda Logistics' delivery operations. Built for one admin (Uzo), eventual dispatchers and reps, and ~5 delivery agents.

See system design doc for full context. This PRD assumes you've read it.

---

## 2. v1 success criteria

v1 is shippable when these are true:

- Uzo can do a full delivery day in the app without touching the spreadsheet
- Agents can receive assignments, update statuses, and record payments from the app
- The bot ingests forwarded WhatsApp messages and creates assigned deliveries with AI-normalized locations
- Stock auto-decrements on delivery, never drifts from movement history
- Per-client and per-agent reconciliation are queryable for any date range, defaulting to **today** (Uzo reconciles daily, not weekly). Admin can also share a per-client report or his own daily P&L summary out of the app via the system share sheet.
- Make.com automation can be retired safely

**Not required for v1:**
- Maps navigation, customer returns, push to clients, advanced analytics — see system design doc Section 10

**Implicit:** Reda's daily operation continues to work during the cutover. The app and old workflow can run in parallel for a transition period.

---

## 3. Tech stack

- **Mobile + web app:** React Native via Expo (SDK 54). One source tree compiles to two targets: Android (`eas build` / `eas update`) and web (`expo export -p web` → static `dist/` deployed on Vercel free). iOS deferred — no business case until an iPhone user joins. Native-only features (voice calling, biometric unlock, push notifications) are mobile-only and gracefully disabled on web via the `canPlaceCall()` helper + `.web.ts` stubs + `Platform.OS === 'web'` guards.
- **Backend:** Supabase (Postgres + Auth + Storage + Realtime + Edge Functions). No custom server. Clients speak HTTPS to PostgREST + Edge Functions; RLS enforces permissions per-request — identical surface whether the client is the Android app or a browser.
- **AI:** OpenRouter brokering both LLM calls (since 2026-06-03) — `openai/gpt-4.1-mini` for order-field extraction in `bot-parse-message`, `google/gemini-2.5-flash` for address picking in `normalize-address`. Direct Google AI API calls retired because the free tier (20 requests/day) was rate-limiting the address pipeline; OpenRouter routes the same Gemini model on paid billing. Google Maps Geocoding API still called directly. All AI calls happen in Edge Functions, never on the phone (keys stay server-side: `OPENROUTER_API_KEY`, `GOOGLE_MAPS_API_KEY`).
- **Push:** Expo Push API
- **Voice calling (§5.17):** Agora Voice SDK via `react-native-agora` (free tier — 10k voice minutes/month). Ring UX via `react-native-callkeep` (Android ConnectionService → native phone-ringtone vibe). RTC tokens minted server-side by the `issue-agora-token` Edge Function; App Certificate never leaves the server.
- **Hosting:** Supabase managed for the server side (free tier → Pro $25/mo when traffic warrants). Mobile distribution via **EAS Build + Google Play Internal Testing track** + EAS Update for JS-only OTA patches. One-time $25 Google Play Console fee, no monthly mobile-hosting cost. **Web build hosted on Vercel free tier** as a static site (SPA-routed via `mobile/vercel.json`); no Vercel functions used.
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

**User story:** As any user, I can log in to the app with email + password, manage my own password / display name / phone, and (optionally) gate the app behind device biometrics.

**Screens:**
- Login screen (email + password) — password field has a visibility toggle (eye icon); a *Forgot password?* link opens an inline email-only form that calls `supabase.auth.resetPasswordForEmail`. Last-used email is remembered in AsyncStorage and pre-filled on next launch.
- Profile screen — displays display name, role, email + tappable rows for *Edit profile*, *Change email*, *Change password*, *Unlock with Face ID / Fingerprint* (only when the device reports biometric hardware enrolled), and *About Reda → Check for updates* (uses `expo-updates` to pull the latest JS bundle on demand).
- *Edit profile* screen — change display name and phone. Email is shown read-only with a small *Change email →* link that opens the Change email screen (kept separate because email change is security-sensitive and needs re-auth + confirmation roundtrip). Phone formats as you type for Nigerian numbers.
- *Change email* screen — current password (re-auth gate) + new email + confirm new email. Calls `supabase.auth.updateUser({ email })` which mails a confirmation link to the **new** address; the change only applies after the user clicks the link. On confirmation, the `sync_user_email_to_public` trigger on `auth.users` mirrors the new value into `public.users.email`.
- *Change password* screen — current password + new password + confirm; each input has an independent eye toggle.

**Logic:**
- Use Supabase Auth (email + password).
- On successful login, fetch the user's row from `public.users` to determine role; store the role in app state for permission checks.
- If user is `is_active = false`, reject login with "Account deactivated".
- Persist session locally so user stays logged in across app restarts.
- Profile edits go through a self-only `update_self_profile(p_display_name, p_phone)` RPC (security-definer, `auth.uid()`-scoped, audit-logged).
- Change password re-authenticates with the current password (via `signInWithPassword`) then calls `supabase.auth.updateUser({ password })`.
- Change email re-authenticates the same way, then calls `supabase.auth.updateUser({ email })`. Supabase mails the confirmation link to the new address; nothing changes server-side until the user clicks it. After confirmation, `auth.users.email` updates and the `sync_user_email_to_public` trigger (added 2026-05-26) copies the value into `public.users.email`. No custom RPC.
- Biometric unlock stores a single AsyncStorage flag (`reda.biometric.enabled`); on cold start, if set and a Supabase session exists, `AuthGate` renders a lock overlay that requires `LocalAuthentication.authenticateAsync()` before revealing the app. Biometrics gate device access only — the underlying auth token is unaffected.
- Sign-out releases this device's push token via `release_my_expo_push_token` before `auth.signOut()`.

**Edge cases:**
- Invalid credentials → "Invalid email or password".
- Rate-limited → "Too many attempts. Try again in a few minutes."
- Network down → "Cannot connect — check your connection".
- User exists in `auth.users` but not `public.users` → "Account setup incomplete, contact admin".
- Biometric fallback fails → user can tap *Sign out* on the lock screen and log in fresh.

**Acceptance:**
- Login works for admin, dispatcher, rep, agent, warehouse roles.
- Session persists across app restart.
- Deactivated users cannot log in.
- Forgot password mails the reset link to the user's own inbox (not the shared admin inbox).
- Edit profile + change password roundtrip is logged in `audit_log` with `actor_id` = self. Email changes are NOT written to our own `audit_log` — Supabase's `auth.audit_log_entries` already records `user_modified` events, and our sync trigger inherits that source of truth.

---

### 5.2 User & agent management (admin)

**User story:** As admin, I can create, edit, and deactivate users (admins, dispatchers, reps, agents, warehouse).

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
- Role must be one of the five enum values (admin, dispatcher, rep, agent, warehouse)
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
- Clients have name, notes (free-form rules visible to agents), contact info, and an optional **`max_charge_per_delivery` cap** (see "Per-client charge ceiling" below)
- Products are (client, product_name) pairs — same product from different clients = different rows
- Locations have name, aliases (text array for AI matching), optional lat/long
- Rate card holds current rate per location; editing creates a new row and closes the old one (effective_until set)

**Per-client charge ceiling.** Each client can have a `max_charge_per_delivery` cap. If set, the rate-card charge for a delivery's location is clamped to that cap at snapshot time (handled server-side by `effective_rate()`). Used when a client's own threshold sits just below our rate-card amount for a specific area — instead of skipping the order, we take it at the lower cap so we still get the trip and keep the relationship. Null = no cap (the default for most clients). Admin-only to set/edit; cleared via a dedicated "Remove cap" action so an empty edit form doesn't silently wipe a configured cap. The admin-side new-delivery screen shows a preview banner ("Reda charge: ₦9,000 — clamped from rate card ₦10,000") when the cap kicks in. Anchored in `clients.max_charge_per_delivery` + `effective_rate()` + `preview_delivery_charge()` RPCs.

**Per-client EOD auto-cancel (since 2026-05-26).** Each client also has a boolean `auto_cancel_soft_fails` toggle on the catalog edit screen. When **on**, the EOD rollover transitions that client's customer-unreachable soft-failed deliveries to `failed_delivery` (terminal) instead of rolling them forward. Affects only the six "we tried, customer didn't engage" statuses: `not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`. **Does NOT affect**: customer-initiated deferrals (`tomorrow`, `postponed`, `will_call_back`, `follow_up`) or logistics-in-progress statuses (`picked_up`, `waybilled`) — those keep rolling. Default off; enabled today only for **Shalom** (per client's explicit policy preference — they handle the customer relationship and don't want orders accumulating retry history). The auto-cancellation runs inside `run_eod_rollover` via `change_delivery_status('failed_delivery', 'eod_auto_cancel:client_policy')` so audit, sibling coordination, and admin push notifications all fire naturally; the EOD summary push body reports the per-policy cancel count alongside the usual rolled/capped/deduped counts.

**Validation:**
- Client name unique
- Product (client_id, product_name) unique
- Location name unique
- Rate card: charged ≥ 0, agent_payment ≥ 0
- `max_charge_per_delivery` (when set) ≥ 0
- `auto_cancel_soft_fails` is boolean NOT NULL default false

**Edge cases:**
- Deactivating a client should also deactivate its products
- Deactivating a location: existing deliveries to that location still work; new ones to that location are blocked
- Changing a rate card mid-day: existing deliveries keep snapshotted rates
- Per-client cap retroactively raised above the rate card: clamp no-ops; charge equals rate card

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

**Past-date warning + duplicate confirm (since 2026-05-27).** Two UI-layer guards on the New Delivery form, both soft (admin can always override):

- **Past-date Banner.** Whenever the typed `scheduled_date` is before today (Africa/Lagos), an amber *"Scheduled for a past date"* banner appears under the form noting that the assigned agent won't see this delivery on their Today tab. Doesn't block — backfilling yesterday's manual entries during reconciliation is a legitimate workflow.
- **Pre-submit duplicate check.** Before calling `create_delivery`, the form runs `findSimilarOpenDeliveries(agentId, customerPhone, productCatalogId, scheduledDate)` and if any open (non-terminal, non-deleted) row matches, prompts *"Possible duplicate"* with a list of the existing rows by status + address and requires explicit *"Create anyway"*. Mirrors the server-side same-agent sibling guard in `create_delivery` but **ignores raw_address** — that branch is too strict for typo'd addresses (e.g. `"f"` vs `"Festac"`) and lets real duplicates through. We surface the suspicion at the UI and let admin decide. Failure of the pre-check is non-fatal — the server-side guard remains the source of truth.

**After-hours bump (since 2026-05-27).** Any delivery created at or after **22:00 Africa/Lagos** with `scheduled_date = today` is automatically moved to the next working day (Sunday-skipped via the existing `_ensure_workday` helper). Late-evening orders cannot realistically be served the same day; the spreadsheet-era practice of pushing them to tomorrow becomes a server-side guarantee. The bump lives inside `create_delivery` itself, so both the **manual mobile** path AND the **bot pipeline** get it for free without duplicating logic. Past dates (backfill for reconciliation) and explicit future dates are untouched — the condition is `lagos_hour >= 22 AND p_scheduled_date = lagos_today`. The audit-log payload for bumped rows carries `auto_bumped_after_hours=true` and `original_scheduled_date` so we can measure how often this triggers and tune the 22:00 cutoff if needed. On the New-delivery form, an info banner *"After 10pm Lagos — will land tomorrow"* appears whenever the picked date is today and the device clock reports ≥ 22:00 Lagos, so admins aren't surprised by the bumped value.

**Acceptance:**
- Creates delivery row with all required fields
- Money snapshots populated correctly
- Initial history row created
- Auto-assignment runs if agent left blank
- Past-date warning fires when `scheduled_date` < today (Lagos)
- Pre-submit duplicate prompt blocks accidental same-agent / same-customer / same-product duplicates even when address text differs from the existing row
- After-hours bump fires for any delivery (manual or bot) created at ≥ 22:00 Lagos with `scheduled_date = today`; the row lands on the next working day with the audit-log noting the original date

---

### 5.5 Delivery creation (bot pipeline)

**User story:** As Uzo, I receive each order from the client, then forward it into the **relevant agent's WhatsApp group**; the contractor's bot reads it there and creates a delivery already attributed to that agent.

**Channel reality (how an order reaches the bot).** The client sends the order to Uzo (via their dedicated client group). Uzo forwards it — after any quality-control edits — into the WhatsApp group of the agent he's giving it to. The contractor's bot is a member of **every agent group**, so *the group a message lands in is how we know which agent the order is for*. The bot parses the message in that group and POSTs it to the app with the agent identified. (An earlier design contemplated a single parsing channel replacing the per-agent groups; that did not happen — the per-agent groups are load-bearing precisely because the group doubles as agent attribution.)

**Components:**
- WhatsApp listener (separate from the app — likely an Edge Function or external service) — reads across the agent groups the bot belongs to
- Parser (LLM-assisted or regex-based)
- Address normalization (Maps + Gemini)
- Delivery creator

**Logic flow:**
1. External WhatsApp automation POSTs to `/functions/v1/inbound-message` with the raw message text (and optionally a `parsed` block if it already extracted structured fields its end). Contract in [reda_bot_intake_contract.md](reda_bot_intake_contract.md).
2. Row lands in `bot_inbound_messages`; a DB webhook fires `bot-parse-message`.
3. **Contractor pre-parse + LLM merge (revised 2026-06-03).** If the contractor sent a `parsed` block with `product_name` AND `raw_address` AND a normalizable `customer_phone` all populated, trust those fields and skip the LLM call entirely. If ANY of those three is missing, call `openai/gpt-4.1-mini` via OpenRouter and **merge**: contractor's fields stay where present, the LLM fills only the gaps. Never discard the contractor's good fields just to recover one empty one (that prior behavior was today's bug — see iteration log). The LLM extraction prompt also carries a phone-as-name fallback ("if the message has no name, use customer_phone digits as customer_name") so we don't lose row that contractors handle via that convention.
4. Match vendor (client) to `public.clients` — disambiguated by `client_hint` if the contractor supplied one.
5. Match product to `product_catalog` (trigram).
6. Address normalization (see 5.6) — short-circuited at high confidence if the contractor provided a `parsed.location` value that matches a known location name/alias.
7. **Agent attribution (normally pre-set from the group).** Because the order is read out of a specific agent's group, the contractor's `parsed.assigned_agent` (display name, email, or phone) is normally present and names that agent — so for bot-created orders the agent is usually **pre-assigned and auto-assignment (§5.7) is skipped**. It must resolve to exactly one active agent; ambiguous or unknown values are treated as unset, and only then does auto-assignment pick the agent. The resolution outcome (`resolved` / `no_match` / `ambiguous`) is stored in `bot_inbound_messages.parse_result.agent_resolution` for auditing.
8. Insert delivery row with `created_via = 'bot'`, `bot_raw_message` = original text.
9. Insert initial history row.
10. Push-notify assigned agent (whether pre-assigned by the bot or chosen by auto-assignment — same `notify_assignment_push` trigger).

**Edge cases:**
- Parse failure → row lands as `status='needs_review'`; surface in Needs Review queue
- Vendor unknown → no product match → row stays in Needs Review
- Product unknown → same
- Duplicate message (idempotency) → dedupe on `wasender_message_id`. When the contractor doesn't supply one, we derive it from `sha256(received_at + from_phone + text)`, so identical retries dedupe automatically.
- **Contractor re-forwards the same order naming the same agent (since 2026-06-03).** When `bot_create_delivery` is called with `p_assigned_agent_id = X` and X already holds an open sibling (same customer+product+date, fingerprint OR norm_address+qty match), it raises `P0001` with hint `{kind:'duplicate_same_agent', existing_delivery_id, agent_id}`. `bot-parse-message` catches the hint, marks the inbound row `status='duplicate'` pointing at the canonical delivery, no new row is created, no second agent is involved. Replaces a 2026-05-19 design that silently nulled the assignment and let `tg_auto_assign_on_insert` hand the row to a *different* agent — which created phantom multi-agent races the contractor never asked for (the 2026-06-03 cleanup found 11 such phantoms across Kenneth/Anjola/Audrey/Queen Favour in one day). Intentional multi-agent races (different agents named on different forwards) still work — that's a different code path. See [scripts/fix-bot-create-delivery-no-phantom-race.sql](scripts/fix-bot-create-delivery-no-phantom-race.sql).

**Fix-and-create flow (admin + dispatcher):**
- Tap any row on the Needs Review tab to open a detail screen with the original message at the top and a pre-filled form below (customer name, phone, address, client, product, quantity, customer price, agent — all sourced from `parse_result.extracted` + `parse_result.product` + `parse_result.agent_resolution`).
- Product-ambiguity rows render the top candidates as chips above the product picker; tapping a chip pre-selects both client + product.
- `customer_phone` strings of the shape "08…1 or 08…2" are split client-side; the alternate appears as a tap-to-swap link.
- **Create delivery** calls `create_delivery` then `resolve_inbound_to_delivery(inbound_id, new_delivery_id)` — the inbound row flips to `status='created_delivery'` with `delivery_id` set.
- **Discard** prompts for a reason (spam / duplicate / not a real order / other), calls `discard_inbound(inbound_id, reason)` — row moves to `status='error'` with `error_text='discarded: <reason>'`.
- Both flows require a fresh edit lock (`acquire_edit_lock('bot_inbound', id)`); peers see "<Name> is fixing this — Take over" if they open the same row.

**Acceptance:**
- Bot successfully parses sample messages from current bot's training data
- Failed parses go to Needs Review, not silently dropped
- All bot-created deliveries have non-null `bot_raw_message`
- Admin/dispatcher can fix a `needs_review` row in-app without leaving the screen; the resolved row carries `delivery_id` so the audit chain is intact.

**Implementation note:** the WhatsApp automation is **external** to this system — a third-party specialist owns the bot and posts to our intake endpoint over HTTPS with a shared bearer secret. We don't own its code. The intake contract ([reda_bot_intake_contract.md](reda_bot_intake_contract.md)) is the integration surface. As long as he hits the contract, the rest is ours.

---

### 5.6 AI address normalization

**User story:** As the system, I match a raw customer address to a known location from the rate card.

**Pipeline (runs during delivery creation):**

0. **Substring/word-boundary pre-check** against `locations.name + aliases`. If a clean win, skip the API spend entirely (no Maps, no LLM).
1. Send raw address to Google Maps Geocoding API
2. If Maps returns a recognizable neighborhood: pass Maps' structured output + rate card location list to `google/gemini-2.5-flash` via OpenRouter
3. If Maps returns nothing useful: pass raw address + rate card list to Gemini-via-OpenRouter directly
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
- Maps API timeout (>5s) → fall through to Gemini-via-OpenRouter only
- OpenRouter request timeout (>30s) → set location_id = null, surface in Needs Review
- API quota exceeded → log error, queue delivery for retry. (Note: prior to 2026-06-03 the address pipeline called Google AI directly and hit the 20-req/day free-tier cap every morning, silently dropping every subsequent address to `confidence='none'`. Routing through OpenRouter eliminated that cap.)

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

**User story:** As the system, I pick the best agent for a new delivery without an explicit assignee. Admin can override at creation time and the system also accepts manual assignment to a stockless agent (handled separately in 5.10 — pickup notifications fire instead of blocking).

**Algorithm** (lives in `public.auto_assign_delivery(p_delivery_id)`):

1. Candidate pool = all `users where role='agent' and is_active = true`.
2. **Stock preference (soft)**: compute `eligible = current_stock.quantity_on_hand >= delivery.quantity_ordered`. Stocked agents come first via `eligible DESC`, but stockless agents remain assignable as last resort. The stock check that *blocks* a delivery now lives in `change_delivery_status` at the moment of transitioning to `'delivered'`, not at auto-assign time (since 2026-05-20).
3. **Preference tier (soft, via `agent_locations`)**:
   - Tier 1 — `(agent, location)` is `kind='preferred'`.
   - Tier 2 — agent has no row for this location (whether or not they have other preferences).
   - Tier 3 — `(agent, location)` is `kind='avoid'` (still assignable as last resort).
4. **Order**: `eligible DESC, has_open_sibling ASC, preference_tier ASC, agent_pending_workload ASC, stock DESC, random()`.
5. Pick the first row. Returns `NULL` only when no active agents exist at all.

**Tie-breakers** are baked into the order above. The trailing `random()` ensures any remaining tie produces a deterministic-per-call but balanced distribution over time.

**Logic:**
- Runs once at delivery insert via the `tg_auto_assign_on_insert` trigger when `assigned_agent_id IS NULL`.
- Result stored in `assigned_agent_id`; re-snapshots `agent_payment_snapshot` if the chosen agent has a per-agent bonus.
- Admin can override at creation (`create_delivery` accepts an explicit `p_assigned_agent_id`) or later by re-running the assign in the app.
- Every run writes the candidate list + chosen agent to `audit_log` for traceability.

**Edge cases:**
- No agent has stock → a stockless agent is still picked (soft preference); the `tg_notify_pickup_needed` trigger fires admins+dispatchers and the agent's assignment push gets a *"pick up N from warehouse first"* hint. The block point is now at delivered-time (§5.9), not assign-time.
- Delivery has no `location_id` → preference_tier collapses to 2 for all agents (location-agnostic).
- Manual assignment to a stockless agent → `create_delivery` accepts any agent regardless of stock. The `tg_notify_pickup_needed` trigger fires admins+dispatchers + the agent's assignment push gets a *"pick up N from warehouse first"* hint. See 5.10 and 5.14.

**Acceptance:**
- Deterministic given identical inputs (within `random()`'s contract).
- Returns null rather than a bad assignment when no eligible candidate exists.
- Audit log contains the full candidate set with their eligibility, preference_tier, stock, and workload.

---

### 5.8 Delivery list + detail (all roles)

**User story:** Each user sees the deliveries relevant to them.

**Screens:**
- Delivery list (filterable)
- Delivery detail

**List view by role:**
- **Agent:** today's assigned deliveries (RLS filters automatically).
- **Dispatcher/Admin:** all deliveries. Filter by date, agent, status, **customer name** (case-insensitive substring, client-side narrow over the fetched list — see [List.tsx](mobile/src/screens/deliveries/List.tsx)), client, location. Default view: today.

**Sort (all roles, since 2026-05-30):** **most recent status change DESC across all statuses** (uses `delivery_status_history.changed_at`, falling back to `created_at` for rows with no history). A row cancelled 30 seconds ago sits above a pending row untouched all day — Uzo's mental model that "most recent change wins" regardless of where the row is in its lifecycle. Implemented in [listDeliveries](mobile/src/services/deliveries.ts) as a second IN-query against `delivery_status_history` + client-side merge — no schema changes. Supersedes the earlier non-terminal-first bucket (2026-05-16 → 2026-05-30) and the per-role rules before that. Same rule applies to the admin home "Recent activity" preview (first 4 of the same fetch).

**Filter chips include `Unassigned` (since 2026-05-30 surfaces a real bucket; chip was already there as a passive filter).** Multi-select bulk reassign — long-press to enter select mode, tap rows to toggle, "Assign N" opens a search-filterable agent picker — ships behind `canBulkAssignDelivery` (admin + dispatcher; reps continue using the single-row reassign on the Edit screen). Used heavily for the rolled-over-unassigned morning queue described in §5.11a. Backed by `bulk_assign_deliveries` RPC; not queued — matches the existing `reassignToSubAgent` precedent and Uzo's typical wifi conditions.

**"Notified" pill on list rows (since 2026-05-27).** When the most-recent `delivery_status_history` row has been tagged via `mark_client_notified` (see §5.9), a small green *Notified* pill renders next to the StatusPill on the list row. Lets peers see at a glance which deliveries have already been communicated to the customer without opening each one. Implementation: `listDeliveries` records the latest history-id per delivery (same sub-query already used for sort) and fires one cheap lookup against `delivery_client_notifications` keyed on that set; merges `latest_notified: boolean` into each row. Hidden when the latest history row is untagged.

**Review tab badge (since 2026-05-27).** Admin / dispatcher / rep bottom-nav *Review* icon shows a red pill with the count of `bot_inbound_messages.status='needs_review'` rows whenever there's pending review work. Cheap HEAD-count via `countNeedsReview()` polled every 30s plus refresh on AppState foreground; errors are swallowed so a network blip stalls the value at its last good read instead of flickering. Hidden when count is 0.

**Detail view shows:**
- Customer info: name, phone (tap-to-call), raw address (tap to open in maps app)
- Product: name, quantity_ordered
- Money: customer_price (**per-trip flat amount, NOT multiplied by quantity** — enforced in `MarkDeliveredSheet` + the four list/detail screens that compute totals); for admin also charged, agent_payment, margin, remit; for agent also their agent_payment if delivered
- Client name and notes (prominent — these are the client rules)
- Status with state machine UI (only valid transitions clickable)
- Status history timeline (everyone reads, no one edits) — each row's reason + notes text is `selectable` (long-press → native Copy menu); for rows with a reason or notes, a small **Copy note** pill (since 2026-05-27, requires app version ≥ 1.1.1) does one-tap copy of `reason\nnotes` to the clipboard via `expo-clipboard`. Reps WhatsApp the customer after every status change; this removes the retype. Pill flips to a green "Copied" state for ~1.5 s then reverts.
- Notes field (editable)
- Parent delivery reference if this is a rollover

**Edit customer-facing fields (admin + dispatcher, pre-delivery only):**
- An **Edit** icon in the AppBar opens a stripped form (same `DeliveryFieldsForm` as New delivery) with the row's current values pre-filled. Save calls `update_delivery_fields(p_delivery_id, ...)` which `coalesce`s each field — only changed fields are sent.
- Server-side gate: caller must be admin or dispatcher AND the delivery's `current_status` must be in the pre-delivery set (`active` + `soft` buckets — `pending`, `available`, `not_answering`, `number_busy`, `switched_off`, `tomorrow`, `postponed`, `follow_up`). Terminal statuses freeze the row to protect snapshots + stock decrements.
- Edit lock: the screen acquires a 5-minute `edit_locks` row (with 60-second client heartbeat) so two admins editing the same delivery see "<Name> is editing this — Take over" rather than silently overwriting each other.

**Follow-up claim (admin + dispatcher + rep, soft-statuses only):**
- When a delivery is in a soft status (customer didn't answer / line busy / phone off / tomorrow / postponed / follow up / not around / not available / not connecting / will call back), a yellow "Needs follow-up" banner offers **I'll handle this**. Tapping it inserts a `delivery_followups` row scoped to the caller; other admins/dispatchers/reps see "<Name> is handling this — Take over" both on the detail screen and as a small claimer-avatar on the deliveries list.
- A trigger on `deliveries.current_status` auto-deletes the claim on any status change (even soft→soft). Manual **Release** is also available.
- **Live across peers (since 2026-05-27).** Both the per-delivery banner ([FollowupClaimBanner](mobile/src/components/delivery/FollowupClaimBanner.tsx)) and the screen-level avatar pill on the deliveries list subscribe via `postgres_changes` on `delivery_followups` (added to `supabase_realtime` publication the same day). Peers see a claim / take-over / release within ~100–300 ms without refocusing. Subscription plumbing is the [`useSupabaseChannel`](mobile/src/hooks/useSupabaseChannel.ts) hook, which uses `useId()` to suffix the channel topic per mount and side-step a supabase-js singleton race during Fast Refresh / strict-mode double-mount. Followup statuses are derived from `delivery_status_defs.needs_followup` so SQL gate (`claim_followup`) and UI gate (`canClaimFollowup`) read from one source.

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

**Delivery comms thread (since 2026-05-16):**
- Each delivery has an optional message thread attached via `delivery_messages`. Agents start the thread by tapping the **alert** icon in the AppBar → picks a tagged issue chip (`wrong_address` | `cant_reach_client` | `payment_dispute` | `product_issue` | `other`) + optional note. Submitting calls [`flag_delivery_issue`](scripts/delivery-messages.sql) which (a) inserts the message row and (b) atomically transitions `current_status` to the default mapped soft status (`cant_reach_client → not_answering`, `wrong_address/payment_dispute/product_issue → follow_up`, `other → no change unless agent opts in`) via the existing `change_delivery_status`. One submission, one transaction — no drift between status pill and open-issue state.
- Admins and dispatchers see the thread inline on the delivery detail, get a push (`audience='admins+dispatchers'`) on flag, and reply via free-text composer using [`reply_to_delivery`](scripts/delivery-messages.sql). The assigned agent gets a push (`audience='user'`) on each reply.
- Thread is **open** iff the parent delivery is non-terminal. Terminal status closes it implicitly (no `closed_at` column, no auto-close trigger — derived from `deliveries.current_status`). Replies on terminal deliveries are rejected (`22023`).
- **Ops can seed an empty thread (since 2026-05-27).** The original "thread must start with the agent's flag" rule was too strict once reps started coordinating proactively. When the thread is empty AND the viewer is admin/dispatcher/rep AND the parent is non-terminal, MessageThread renders a *"Message agent"* composer so ops can open a conversation without waiting for the agent to hit a snag. Permission helpers `canSeedThread` / `canPostOnThread` carry the rule client-side; the agent-flag path remains the dominant case.
- `mark_messages_read(p_delivery_id)` clears unread state from the counterparty's side on focus. The admin home surfaces an "Open issues from agents" attention block (see [delivery-messages.ts:listOpenIssuesForOps](mobile/src/services/delivery-messages.ts)) that lists every flagged delivery whose parent is still open.
- Pairs with the existing `delivery_followups` claim lock — because the flag transitions to a soft status, the **I'll handle this** button auto-enables on the same screen. Issue thread = "what's going on"; follow-up claim = "who's handling it."

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
- terminal = delivered, cancelled, agent_cancelled, failed_delivery, unserious, no_product, abandoned, deferred_to_client, rolled_over
- non-cascading terminals (only ones that DON'T close sibling rows): `agent_cancelled` (agent-side row close — "Not my delivery") and `rolled_over` (EOD-owned). See §5.16.

**UI for status change:**
- Status field on delivery detail shows current status
- Tap to change → modal with valid next statuses (state machine filters options)
- If transition is backward, modal also requires a reason. Reason / Note-to-ops field is a 4-row multiline input (since 2026-05-27, via the shared [`Input`](mobile/src/components/ui/Input.tsx) component's `multiline numberOfLines={N}` props) so long context — *"customer said he did not remember ordering anything; vendor should send him a photo of the products"* — wraps instead of scrolling horizontally. Any caller that wants the same treatment passes `multiline` on `Input`.
- If new status = 'delivered': prompt for `quantity_delivered` (default = quantity_ordered) and `paid` + `payment_method`
- If new status = 'postponed' (since 2026-05-27): a YYYY-MM-DD date input is required with `+1 / +2 / +3 / +7` quick chips. Validation: format must match `YYYY-MM-DD` and the date must be **strictly after today** (Lagos). Sundays auto-bump to Monday via the server-side `_ensure_workday` helper. The date threads through `change_delivery_status` as `p_new_scheduled_date`; the server ignores it for every status except `postponed`.
- If client_rules say "no partial deliveries" and `quantity_delivered < quantity_ordered`: warn but allow (audit will capture)

**Auto-seed message thread on intervention-class status (agent only, since 2026-05-27).** When an agent picks one of the six customer-unreachable statuses (`not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`) from *Update status*, the submit routes through the existing `flag_delivery_issue` RPC instead of plain `change_delivery_status`. Result: status changes AND a `delivery_messages` row gets seeded (issue_type = `cant_reach_client`, note = the reason text) so ops know there's something to handle without the agent having to also tap the caution icon. UI surfaces a *"This will also message ops so they can help."* hint banner; the reason field's label switches from *Reason* to *Note to ops*. Ops users (admin/dispatcher/rep) using the same sheet skip this routing — they may legitimately pick those statuses for their own reasons (e.g. correcting a status post-call) without seeding a thread. Mapping table lives in [delivery-messages.ts → STATUS_AUTO_ISSUE](mobile/src/services/delivery-messages.ts) next to `ISSUE_DEFAULT_STATUS` so the inverse-mapping symmetry is visible. Implementation: new queue job kind `flag_delivery` mirrors the existing `change_delivery_status` executor so agents in spotty coverage keep offline resilience.

**Client-notified tag per status-history row (since 2026-05-27).** Each row in the delivery history timeline now has a *"Mark client notified"* button for admin/dispatcher/rep (gated by `canMarkClientNotified`). One tap inserts a `delivery_client_notifications` row keyed on `status_history_id`; first-tap wins via PK conflict, peers see *"<Name> told the client · <time>"*. Lets multiple reps coordinate so one of them owns the WhatsApp ping to the customer for a given status change. The latest-history tag also surfaces as the *Notified* pill on the deliveries list (see §5.8). Permission: ops-only by `canMarkClientNotified`; the agent assigned to the delivery has SELECT access on `delivery_client_notifications` (informational read — they don't act on it). Anchored by [scripts/client-notified-tag.sql](scripts/client-notified-tag.sql) + [services/clientNotifications.ts](mobile/src/services/clientNotifications.ts). **Realtime-live**: the detail screen subscribes via `postgres_changes` filtered to `delivery_id=eq.<id>` so a peer's tap renders the green check on every other open phone within ~100–300 ms without refocusing (same `useSupabaseChannel` pattern as the follow-up claim).

**Logic:**
- Insert row in `delivery_status_history`
- Update `current_status` on delivery
- If transition = 'delivered': set `quantity_delivered`, `paid`, `payment_method`, and `cash_pos_fee_snapshot` (₦500 when `payment_method='cash' AND paid > 0`, else 0 — see §5.12 and the Cash POS fee paragraph below)
- If transition = 'delivered': **enforce stock** — `current_stock(assigned_agent_id, product_catalog_id) >= quantity_delivered`, else raise `insufficient_stock` (P0001). Skipped when the row has no assigned agent. This is the single chokepoint for stock; `create_delivery` no longer guards (since 2026-05-20).
- If transition = 'cancelled' and previous was 'delivered': reverse the stock decrement (no explicit code needed; current_stock view recomputes from history)
- All in a single transaction via Postgres function (see 5.15)

**Cash POS fee (since 2026-05-29; default corrected 2026-06-04).** Mark-delivered surfaces default `payment_method = 'transfer'`, which the live data overwhelmingly supports — **≈98% of delivered orders are transfer** (last 60 days; 95.5% last 14 days), only ~2% cash. (An earlier revision of this section claimed cash was "by far the more common case" and described a cash default; that was stale — the code already defaulted to transfer, and the measured mix confirms transfer is correct.) When the agent confirms with `method = 'cash' AND paid > 0`, the server stamps `cash_pos_fee_snapshot = 500` on the row inside `change_delivery_status` — the per-delivery POS-to-bank conversion fee Reda incurs when cashing out collected cash, passed through to the client as a deduction from their remit (see §5.12). Transfer rows stamp 0. Snapshotted at delivered-time rather than derived so a future fee adjustment doesn't retroactively change historical client remits — same pattern as `charged_snapshot` and `agent_payment_snapshot`. The `MarkDeliveredSheet` shows a hint banner when cash is picked: *"₦500 will be deducted from the client's remit (POS charge for banking the cash). Doesn't change what you hand over."* Agent's own "Remit to Reda" number is unchanged because the agent still hands over the full collected cash; the deduction lives on the client-remit side of the books.

**Agent bulk "Mark delivered" (since 2026-06-04).** On the agent Today screen ([mobile/app/(agent)/today/index.tsx](mobile/app/(agent)/today/index.tsx)), an agent can **long-press an order to enter select mode, tap to select several, and mark them all delivered in one action** — the end-of-route "everyone paid the expected amount" fast path. Each selected order is marked delivered with **its own `customer_price` as the amount paid** and **`quantity_ordered` as the quantity**; **payment method is a single shared toggle for the batch, default Transfer**. There is **no bulk RPC** — the sheet ([mobile/src/components/sheets/BulkMarkDeliveredSheet.tsx](mobile/src/components/sheets/BulkMarkDeliveredSheet.tsx)) enqueues one ordinary `change_delivery_status` job per order through the existing offline mutation queue, so the action is offline-resilient and every row is ownership-checked, stock-checked, and POS-fee-stamped server-side exactly like a single delivery (and idempotent per-row on re-drain). Only **eligible** rows are selectable — non-terminal AND with a `location_id` set (`change_delivery_status` rejects `delivered` with no location); ineligible selections are previewed as skipped. **Paid-in-full only**: partial/short payments or partial quantities are not a bulk case — the agent deselects that order and uses the single-row `MarkDeliveredSheet`. Cash batches stamp the ₦500 POS fee per order as usual. Gated by `canBulkMarkDelivered` (agent-only — ops keep single-row + their existing bulk-status tools).

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

**User story:** As admin, I record vendor intakes, move stock between warehouse/agents, fix bookkeeping errors, and see how much of each client's product Reda holds across the operation. As agent, I see my own current stock.

**Role access** (since 2026-05-27 — was admin-only before):

| Role | Reads | Writes |
|---|---|---|
| Admin | All stock everywhere | Every reason on `create_stock_adjustment` + every paired reason on `create_stock_transfer`. Owns the books-override path (`correction`) and agent-to-agent reassignment (`transfer`). |
| Warehouse | All stock everywhere (read-only dashboard inherits the admin pattern) | Vendor intake into self (`bulk_intake`); paired transfers where they're a participant (`warehouse_issue` from self / `warehouse_return` to self); shrinkage on own holdings (`loss`, `theft`, `damaged`, `found`). **Cannot** run `correction` (admin-only books override) or `transfer` (agent → agent). |
| Dispatcher | Audit log only — no Stock tab in the dispatcher route group. Coordinates but doesn't issue. | None. |
| Rep | None — RLS on `stock_adjustments` is tightened so rep accounts see no stock data anywhere. | None. |
| Agent | Own `current_stock` rows (read-only). | None directly. Stock decrements happen as a side effect of marking deliveries delivered. |

Server-side guard lives in [scripts/warehouse-stock-ops.sql](scripts/warehouse-stock-ops.sql) — `create_stock_adjustment` and `create_stock_transfer` carry an `admin OR warehouse-scoped check, else 42501` permission block at the top. Audit log records the actor (`auth.uid()`) so a warehouse intake shows as the warehouse identity, not as an admin. **Stock-pickup-needed push** (`tg_notify_pickup_needed`) now targets BOTH admins AND warehouse staff (audience `warehouse_pickup`) since warehouse can issue from the warehouse app directly.

**Screens:**
- Agent: "My stock" list (read-only) showing `current_stock` rows for them.
- Admin Stock screen with:
  - **Top buttons**: *Receive stock* (primary), *New transfer*, *Adjustment*.
  - **Tab toggle**: *By holder* (default — every active warehouse user is always shown, even when empty) and *By client* (per-client roll-up with warehouse vs agents split + tappable cards).
- **Warehouse Stock screen (since 2026-05-27)** — same dashboard data as admin (holder list + low/negative chips). Same three action buttons at the top: *Receive stock*, *New transfer*, *Adjustment*. The action screens are the same shared components ([mobile/src/screens/stock/](mobile/src/screens/stock/)) rendered with `scope='warehouse'`, which (a) locks the holder/warehouse side of every write to the caller server-side (matching the SQL guard `p_agent_id = auth.uid()` / `p_from_user_id = auth.uid()`), (b) hides reasons the warehouse role can't run (`correction`, agent-to-agent `transfer`). Admin renders the same screens with `scope='admin'` — byte-identical UI to the prior route — keeping the two surfaces in a single component tree with one branching point.
- **Receive stock** (new) — bulk vendor intake. Destination defaults to the single active warehouse user; admin can switch to an agent for direct field intakes. Warehouse callers see the destination locked to themselves. Add one or more `(client → product → qty)` rows. Shared notes (e.g. *"Invoice #1234"*). Each row enqueues an independent `create_stock_adjustment` with `reason='bulk_intake'` (positive delta) — per-row failure semantics via the queue.
- **New transfer** — adapts by reason:
  - `transfer` (agent ↔ agent): single-row picker (existing).
  - `warehouse_issue` / `warehouse_return`: **bulk mode** with shared warehouse + shared agent at the top + multi-row `(client, product, qty)`. Each row fans out as its own `create_stock_transfer` call. One submit = one agent receiving (or returning) a stack of products — mirrors the real workflow ("Nnenna comes, picks up everything she's collecting, leaves"). Switch agents = new submit.
- **Adjustment** — single-row form for write-offs and bookkeeping. Reason picker now lists everything *except* `bulk_intake` (intakes use the Receive flow).
- **Per-client stock detail** — tappable from the By-client tab and from Catalog → Clients → *View stock*. Shows total qty across all holders + warehouse / agents split per product. The screen **merges the client's full active catalog** with `current_stock`, so products at zero across every holder still render with a red "Out of stock" pill (a `0` total has signal — Uzo needs to know what to chase). *Share with client* button generates a plain-text snapshot; out-of-stock lines render as `OUT OF STOCK` so the client sees what's depleted.
- The **By-client tab** likewise merges `listClients()` with the stock-driven groups, so any active client (e.g. one just added in Catalog, or with everything sold through) appears with `Nothing in stock right now · 0 units` in red rather than silently disappearing.

**Reason taxonomy:**
- Single (`create_stock_adjustment`): `loss`, `theft`, `damaged`, `found`, `correction`, `bulk_intake`.
- Paired (`create_stock_transfer`): `transfer`, `warehouse_issue`, `warehouse_return`. Each creates two adjustments linked by `related_adjustment_id`, atomic per transfer.
- Mobile centralizes the categorization (`ADJUSTMENT_REASONS = SINGLE_REASONS - bulk_intake`) so UI partitioning doesn't drift.

**Workflow nudge — warehouse staging:**
- Vendor delivers stock → admin uses *Receive stock* (defaults to warehouse) → admin uses *New transfer → Warehouse issue* (bulk) to issue to specific agents when they pick up. This keeps `current_stock.warehouse_qty` meaningful and is the pattern reflected in the By-client view's warehouse-vs-agents split.
- The Receive screen still allows targeting an agent directly for legitimate field intakes — same data path as the historical pattern, just no longer the default.

**Stockless assignment (cross-ref 5.4 / 5.14, since 2026-05-20):**
- `create_delivery` accepts any `p_assigned_agent_id` regardless of stock. Auto-assign likewise picks stockless agents as last resort. The stock check was moved to `change_delivery_status` at the `'delivered'` transition (§5.9) so a delivery can be created, assigned, and worked on while stock is in flight.
- Two notifications fire on commit: agent gets the assignment push with a *"pick up N from warehouse first"* suffix, and admins+dispatchers get a separate *"Stock pickup needed"* push (via `tg_notify_pickup_needed`).
- The negative-stock trigger remains the after-the-fact safety net.

**Edge cases:**
- Stock-sufficiency policy (since 2026-05-24): every stock-decrementing operation must show that the source can cover it, except `correction` adjustments which stay as the explicit "books were wrong" escape hatch. Three guard points, identical error shape:
  - `change_delivery_status -> 'delivered'` — assigned agent must have ≥ `quantity_delivered`.
  - `create_stock_transfer` (any reason) — source user must have ≥ `quantity` (skipped when source is inactive, i.e. the deactivation sweep, so we don't deadlock catch-up).
  - `create_stock_adjustment` (`loss` / `theft` / `damaged`) — user must have ≥ `|quantity_delta|`.
- `correction` adjustment is the only path that can produce a negative balance — used when reality differs from the books and admin is admitting the books are wrong. `notify_negative_stock` still fires whenever a balance lands negative, so it never goes silent.
- Same agent on multiple bulk rows → allowed; each becomes its own adjustment.
- Receive with no active warehouse user → empty-state on the destination select, submit blocked.

**Acceptance:**
- Receive screen records N intakes in one submit; queue handles offline + retries.
- By-client tab math reconciles against By holder for every (client, product) pair.
- Bulk transfer round-trip: 3 rows = 6 stock_adjustments (3 paired) atomic per row.
- Negative-stock notification fires within seconds of the triggering adjustment.

---

### 5.11 End-of-day rollover

**User story:** As admin, at end of day I want stuck deliveries rolled forward automatically — and a way to do it myself if I want to.

**Two paths, same backend:**

1. **Auto-rollover cron (since 2026-05-17).** [supabase/functions/scheduled-eod-check/index.ts](supabase/functions/scheduled-eod-check/index.ts) runs at **23:59 Lagos** (22:59 UTC) every night via Supabase Scheduled Edge Functions. (Originally scheduled at 21:00; moved later. Old "21:00" mentions in SQL comments and earlier doc revisions are stale.) It signs in as the **Reda System** admin user (a real `users` row — see [scripts/system-user-setup.sql](scripts/system-user-setup.sql)) and calls `run_eod_rollover_all_stuck(p_reason='auto_eod_cron')`. The function walks every distinct `scheduled_date <= current_date` that still has at least one non-terminal delivery and calls `run_eod_rollover(date)` per group. All admins get one confirmation push (success: "Rolled N deliveries forward. Tap to review."; no-op: "All clear — nothing to roll."; failure: "Auto end of day FAILED — open the EOD screen and run it manually."). Audit attribution is honest because the cron is logged in as a real user.

2. **Manual EOD screen** ([mobile/app/(admin)/eod.tsx](mobile/app/(admin)/eod.tsx)). Single **Roll all forward** button that calls `run_eod_rollover(today)`. Used when an admin wants to clear early or re-run after fixing something. Idempotent — the inner `rollover_delivery` skips parents that already have a rollover child.

**Sunday-skip.** Reda's work week is Mon–Sat. The `_ensure_workday(candidate)` helper inside [scripts/phase6-rollover.sql](scripts/phase6-rollover.sql) bumps a Sunday candidate forward to Monday, applied **uniformly** to both the default `+1 day` AND any explicit `p_new_scheduled_date` override. A Saturday-night rollover lands on Monday; a Monday-night rollover lands on Tuesday. When holidays are added, this is the one function to extend.

**What `rollover_delivery` does, per parent (since 2026-05-30 the new row lands unassigned — see §5.11a for the rationale):**
- Mints a new `deliveries` row with `current_status='pending'`, `created_via='rollover'`, `parent_delivery_id=<old>`, copying customer info, product, quantity, address, location, customer_price. **`assigned_agent_id` is intentionally `NULL`** so Uzo surfaces the row on the deliveries list's Unassigned filter and decides every reassignment himself (§5.11a). The `tg_auto_assign_on_insert` trigger now skips rows where `created_via='rollover'` so the algorithm doesn't immediately pick someone via workload.
- Re-snapshots `charged_snapshot` and `agent_payment_snapshot` from `current_rate_for_location()` for the new date (falls back to the old snapshots if no rate exists). Uses scalar variables for the rate columns so missing-location rollovers don't fail with "record not yet assigned."
- Flips the original row to `rolled_over` via `change_delivery_status` — same audit trail, same trigger fanout.
- Idempotent per `(parent_delivery_id, created_via='rollover')` — re-runs are no-ops.
- **Carry-cap strike rule (since 2026-05-30):** the cap-trip-to-`unserious` after 2 rollovers only fires when the parent's status was a customer-unreachable one (`not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`). Operational rollovers (`pending`, `available`, `picked_up`, `postponed`, `follow_up`, `tomorrow`, `waybilled`, …) carry without ticking the counter. The customer-unreachable set is the same one §5.11's per-client EOD auto-cancel uses — single canonical definition. Audit-log records `is_strike_rollover: true|false` on every rollover.

**Stock is NOT moved by rollover.** Stock attribution is via delivered-side-effects + explicit adjustments; a pending row never moved stock. Under the new null-assignment behaviour the stock physically stays with yesterday's assignee (the system never knew about a "transfer" — stock tracks against the agent who last accepted it); once Uzo reassigns via the Unassigned queue, the new agent may need a warehouse transfer if they don't have enough on hand, which `tg_notify_pickup_needed` already signals.

**Per-client EOD auto-cancel (since 2026-05-26).** Inside the same `run_eod_rollover` loop, after the same-agent and race-lost dedup branches, the row's client is checked for the `auto_cancel_soft_fails` policy (see §5.3). If the policy is on AND `current_status` is in the customer-unreachable set (`not_answering`, `not_around`, `not_available`, `not_connecting`, `number_busy`, `switched_off`), the row is transitioned to `failed_delivery` via `change_delivery_status` and the loop continues — no rollover child is minted. The cancel count is surfaced in the EOD summary admin push alongside the usual rolled/capped/deduped counts. Currently enabled for **Shalom** only; toggle-able for any client via Catalog → Clients → Edit.

**Edge cases:**
- 0 stuck deliveries → cron sends the "All clear" push so admins know it ran.
- Pre-existing rolled child → silently skipped (idempotency dedupe).
- Parent without `location_id` → re-snapshot falls back to old snapshot, no error.
- Agent marks delivered at 23:59:30 while cron rolls at 23:59:00 → the second action fails because the parent is now terminal. Same race the manual EOD already has; mitigation is operational (the team picks 23:59 Lagos deliberately — by then field agents are off the road).

**Acceptance:**
- Cron rolls every stuck date forward without admin intervention.
- All admins receive exactly one confirmation push per nightly run.
- Sunday rollovers always land on Monday, regardless of who/what computed the target date.
- Manual EOD button still works and produces identical results.

**Sibling dedup at rollover (since 2026-05-18; cross-agent policy revised 2026-06-02).** When multiple non-terminal siblings exist for the same `(customer_phone_normalized, product_catalog_id, scheduled_date)` group on the rolled date AND they match the two-tier sibling rule (see §5.16 Sibling coordination), `run_eod_rollover` collapses each group to a single canonical before rolling:

- **Same-agent dupes:** the canonical is the most-progressed-most-recently-touched row for that agent; the rest are cancelled with reason `'duplicate not completed, same-agent deduped on rollover'`.
- **Cross-agent groups (race-assigns):** collapse to one canonical regardless of progression state. If any sibling has progressed past pending, the most-progressed wins and others cancel with reason `'race lost, deduped on rollover'`. If all are still pending, the canonical is chosen by status/updated/created/id ordering and others cancel with reason `'duplicate not completed, cross-agent deduped on rollover'`.

The all-pending-cross-agent collapse is intentional and tied to the 2026-05-30 unassigned-rollover behavior: rolled children land with `assigned_agent_id = NULL`, so preserving N parents through EOD just spawns N unassigned phantoms tomorrow — Uzo would have to dedup by eye in the morning queue. Collapsing at EOD gives him one row per real order; he can re-race fresh tomorrow morning by reassigning to multiple agents. (Prior behavior 2026-05-18 → 2026-06-02 preserved all-pending cross-agent siblings, which was correct when rollovers inherited the parent's agent but stopped making sense after the unassigned-rollover change.)

The grouping key (`sib_key`) inside `run_eod_rollover` is computed as `md5(_norm_address(raw_address) || '|' || quantity_ordered)` — same as the matcher's Tier 2 — so that typo-drifted bot forwards with different fingerprints but identical addresses get correctly grouped. Prior versions used `coalesce(text_fingerprint, md5(...))` which silently bypassed dedup whenever both rows had fingerprints; revised 2026-06-02. (See reda_system_design_doc.md §3 "Race-assign coordination → Matcher consistency restored" for the related fix that landed in `_find_sibling_deliveries` and `bot_create_delivery` on the same date.)

**Resolved-sibling backstop — must mirror the cascade exclusion (fixed 2026-06-04).** Beyond the same-agent / cross-agent collapse above, `run_eod_rollover` checks each *live* row before rolling it: if a sibling already reached a terminal state that settled the order, the live row is cancelled (*"Another agent already handled this order (<status>). Closed as duplicate."*) instead of rolling forward. This backstop must use the **same `{agent_cancelled, rolled_over}` exclusion as the live Stage-2 cascade** (§5.16). Originally it matched on *any* terminal status, which meant a sibling closed as `agent_cancelled` (row closed, order still live) — or even `rolled_over` — would wrongly cancel the live row. The 2026-06-04 incident: the 2026-06-03 phantom-race cleanup closed phantom rows with plain `cancelled` (should have been `agent_cancelled`), the cascade cancelled the intended-agent rows too, the operator restored those to `pending`, and that night's rollover backstop re-cancelled all of them by reading the dead phantom sibling as "handled" — **9 real orders rolled nothing forward.** Fix: the backstop now excludes `{agent_cancelled, rolled_over}`, identical to the cascade; `cancelled` is kept as a resolving terminal in both places (a cancelled order is dead and should close its siblings consistently). Anchored in [scripts/fix-rollover-resolved-sibling-match-cascade.sql](scripts/fix-rollover-resolved-sibling-match-cascade.sql); the 9 lost orders were restored unassigned to the next operating day via [scripts/restore-june4-lost-rollover-orders.sql](scripts/restore-june4-lost-rollover-orders.sql).

---

### 5.11a Manual rollover assignment + Unassigned queue (since 2026-05-30)

**Problem Uzo raised (WhatsApp 2026-05-29).** Soft-failed deliveries were rolling over to the **same agent** the next day. Backtest of the last 30 days (Q2 in [scripts/route-assignment-backtest.sql](scripts/route-assignment-backtest.sql)) found 30+ agent/location pairs with ≥6 back-to-back-day streaks — Iya Ayo alone had ~100 "same agent, same area, two days running" instances across 9 locations (11x Ikoyi, 11x Ojodu Berger, 10x Agege, …). Uzo's manual workaround: filter the soft-fails on his Google Sheet each morning and forward each prior-day agent's set to a different agent on WhatsApp. App was doing the opposite of his intent.

**Initial proposal — rejected by Uzo (2026-05-30).** A first design seeded `agent_locations` (the existing preferred/avoid table — empty in production) from Uzo's Location Sharing/Remittance sheet and let `auto_assign_delivery` pick a per-rollover agent using its existing preferred-tier + workload-balancing logic. Q1 of the same backtest showed the empirical pattern would have supported this (per-agent personal clusters of 40–70% share, workload-balancing already spreading the rest). Uzo's reason for rejection: agents' schedules churn (leave, sickness, new joiners, departures); the rotation he runs requires human judgment the app can't honestly model. He wants to assign every rollover himself.

**What we shipped instead — five changes** ([scripts/manual-rollover-assignment.sql](scripts/manual-rollover-assignment.sql)):

1. **Rollover lands unassigned.** `rollover_delivery` inserts the new row with `assigned_agent_id = NULL` (was: copied from parent). Every rolled-over delivery surfaces in tomorrow's queue under the existing **Unassigned** filter chip on the deliveries list — Uzo decides every assignment.

2. **Auto-assign trigger skips rollovers.** `tg_auto_assign_on_insert` gates on `created_via <> 'rollover'`. Without this gate, the trigger would call `auto_assign_delivery` and reintroduce the same system-picks-an-agent behaviour we're removing. Fresh bot/manual orders still auto-assign normally.

3. **Strike-cap only counts genuine soft-fails.** The 3-strike carry cap (mark `unserious` after 2 rollovers) used to fire on *any* rollover. Now it fires only when the parent's status was a customer-unreachable one — the same six statuses the per-client EOD auto-cancel uses: `not_answering, not_around, not_available, not_connecting, number_busy, switched_off`. Operational rollovers (a `pending` row nobody assigned, an `available` row that never got attempted, a `picked_up` row the agent didn't deliver) carry without burning a strike. The audit_log records `is_strike_rollover: true|false` on every rollover.

4. **Multi-select + bulk reassign on the deliveries list.** Long-press a row to enter select mode; tap more rows to add them; the bottom action bar shows **"Assign N"**. Picker is a search-filterable bottom sheet ([mobile/src/components/sheets/BulkAssignSheet.tsx](mobile/src/components/sheets/BulkAssignSheet.tsx)) listing all active top-level agents. New direct-RPC service function `bulkAssignDeliveries(ids, agentId)` calls a new `bulk_assign_deliveries` Postgres function (admin+dispatcher only; skips terminal/deleted rows; returns the count actually updated for the success toast). Not queued — matches the existing `reassignToSubAgent` precedent. New permission helper `canBulkAssignDelivery` (admin OR dispatcher; rep is excluded because bulk routing is dispatch-team work).

5. **Bot smart-reassign (preserves Uzo's WhatsApp habit).** `bot_create_delivery` now checks, immediately after the existing same-agent pre-empt step, whether an **unassigned** open sibling already exists for this (`customer_phone_normalized`, `product_catalog_id`, `scheduled_date`) with the canonical two-tier match (text fingerprint OR normalized address + quantity, from [sibling-coordination.sql:107-120](scripts/sibling-coordination.sql#L107-L120)). When one is found, the bot UPDATEs that row's `assigned_agent_id` instead of inserting a duplicate, returns the orphan's id, and writes a `bot_smart_reassign` audit row. Effect: when Uzo forwards a customer's details to one agent on WhatsApp, the bot absorbs the unassigned rollover into that assignment — clean handover, no duplicate. When he forwards to multiple agents (race-assign), the second+ messages see an *assigned* sibling, fall through to the existing insert path, and spawn fresh race rows. Existing sibling-cancel-on-delivery cascade then closes the losers when one delivers.

**Existing sibling-collapse-on-rollover behaviour is preserved unchanged.** Per §5.11 "Sibling dedup at rollover (since 2026-05-18)", multiple sibling rows on a rolled date already collapse to one row tomorrow. That's how race-assignment doesn't multiply across days, and it remains the canonical mechanism — manual rollover assignment layers on top of it without touching it.

**Operational outcome.** Uzo clears tomorrow's queue in ~3-5 minutes via multi-select on the Unassigned filter; or, if he prefers, forwards orders to agents on WhatsApp exactly as before and the bot absorbs the rollovers into the WhatsApp-named agents. Same result either way.

**Trade-offs accepted:**
- Bulk-assign uses a direct RPC, not the mutation queue. Network blips during the morning batch surface as immediate errors. Acceptable because Uzo's typical conditions are office wifi; revisit if blips become a complaint.
- Multi-select state lives in-screen only — no cross-screen handoff. Switching date or filter while in select mode retains existing selections; the server-side `bulk_assign_deliveries` silently skips any stale ids (terminal/deleted) so the worst case is a "Assigned N" toast where N is smaller than expected.
- Rep role has the existing single-row reassign affordance (Edit screen) but not bulk reassign. Plan-of-record per Uzo: bulk is a dispatch operation.

**Deliberately NOT built:**
- The `agent_locations` seed — invalidated by Uzo's pivot. A future implementer should re-read this section before reviving the idea.
- A daily-route-plan table or in-app screen — same data-entry problem Uzo was pushing back against.
- A queue-based bulk-assign job kind.
- A UI distinction between rolled-over-unassigned vs bot-couldn't-assign rows — Uzo wants them in one bucket.

**Verification probes (live after the SQL is pasted).** Each runs read-only via [scripts/db.mjs](scripts/db.mjs):

1. `select assigned_agent_id from public.deliveries where created_via='rollover' and created_at >= current_date` → all NULL.
2. Join `audit_log` on `(entity_id, changed_at)` between the `is_strike_rollover` field and the `old_status` field to confirm only customer-unreachable parents have `is_strike_rollover='true'`.
3. `select count(*) from public.audit_log al join public.deliveries d on d.id=al.entity_id where al.reason like 'auto_assign%' and d.created_via='rollover'` → 0.
4. Manual smoke on the preview build: long-press a row, multi-select, "Assign N", pick agent, confirm rows move to that agent's filter and a single `bulk_assign` audit row exists per delivery.

---

### 5.16 Sibling coordination (race-assignment auto-cancel)

**User story:** Uzo deliberately creates the same customer/product/day delivery for multiple agents so whoever gets there first delivers it. The system needs to coordinate this without forcing Uzo to change his workflow.

**The pattern in live data.** A duplicate-probe in May 2026 found 15+ groups: customers like Emmanuel Umukoro × 4 agents, Joel FBM × 3, Yetunde × 3, all sharing identical phone + product + scheduled_date. Some were bot-pipeline forwards (same WhatsApp text reaching the bot multiple times under different `wasender_message_id`); others were manual New-Delivery copies.

**Two-tier sibling match** (see [scripts/sibling-coordination.sql](scripts/sibling-coordination.sql)):
1. Same `scheduled_date`.
2. Same `customer_phone_normalized` (via `_norm_phone` — strips formatting, trims `234` country code and leading `0` so `+2348033017212` / `08033017212` / `8033017212` all collapse to one value).
3. Same `product_catalog_id`.
4. AND ONE OF:
   - **Tier 1** (bot-bot): both rows have non-null `bot_raw_message` AND the text matches case-insensitively. Catches bot duplicates even when AI parser produced slightly different addresses/quantities across them.
   - **Tier 2** (manual or fallback): same `lower(trim(raw_address))` AND same `quantity_ordered`.

**False-positive protection.** Same-day repeat orders for the same customer (e.g. a bar ordering at 9am and again at 5pm) have either different `bot_raw_message` OR different address/quantity → NOT siblings. Verified against production data where Paul Phillip × 3 (3 distinct addresses) and Damilare Michael × 3 (3 addresses, 2 quantities) correctly return zero siblings.

**Two-stage trigger** (`tg_handle_sibling_coordination` on `deliveries.current_status`):
1. **Stage 1 — Stand-by signal.** Fires on `pending → available` (single-shot guard against thrash). Siblings stay open; only their agents are notified: *"<Agent first name> is on <customer>. Hold for now."* via `send-notification` audience=`user`.
2. **Stage 2 — Auto-cancel.** Fires on transition into **any terminal status EXCEPT `rolled_over` and `agent_cancelled`** (per `archive/sibling-cascade-all-terminal.sql`, updated 2026-06-03 in [scripts/add-agent-cancelled-status.sql](scripts/add-agent-cancelled-status.sql)). Each sibling whose `current_status` is still non-terminal is flipped to `cancelled` with a `delivery_status_history` row attributed to the **Reda System** user. Sibling's agent (if any) gets *"<Other agent> handled the same order (<terminal status>). Closed as duplicate."*

**Non-cascading terminal `agent_cancelled` (shipped 2026-06-03).** Order-level terminals — `delivered`, `cancelled`, `failed_delivery`, `no_product`, `abandoned` — describe the whole order ending (fulfilled, customer killed it, undeliverable, stock blocker, field abandonment), so closing siblings is correct. `agent_cancelled` (label: **"Not my delivery"**) means *this specific agent's row is closed but the order is still live for everyone else* — an agent passes on a delivery that isn't theirs, or admin removes one row of a sibling pair without affecting the other. It is the only non-cascading terminal (alongside `rolled_over`, which is owned by EOD machinery). The 2026-06-03 phantom-race incident is the canonical case it solves: cancelling 11 wrongly-spread phantom rows via `cancelled` cascaded into 12 intended-agent canonicals being cancelled too (had to restore via `cancelled → pending`). `agent_cancelled` would have closed only the phantom side. Self-serve by the assigned agent, reason required, admin-revertible. See [reda_system_design_doc.md §3.5](reda_system_design_doc.md) for design.

**The `{agent_cancelled, rolled_over}` exclusion is not trigger-local — it must be mirrored anywhere code asks "did a sibling already settle this order?" (since 2026-06-04).** The EOD rollover has its own such check (the resolved-sibling backstop in §5.11), and it originally matched on *any* terminal status, so an `agent_cancelled` sibling would still cancel the live row at rollover time — defeating the non-cascading guarantee. It now uses the identical exclusion list. **Operational rule:** any per-row close that must NOT end the order (phantom cleanup, "not my delivery", admin removing one row of a sibling pair) uses `agent_cancelled`, never `cancelled` — the 2026-06-04 loss of 9 orders traced to a manual phantom cleanup that used `cancelled` and cascaded into the intended rows.

**Late-add coverage** (`tg_signal_new_sibling` on `deliveries` INSERT). If Uzo creates a new duplicate AFTER another agent already went `available`, the new agent receives the "Stand by" push immediately on row creation.

**Performance.** Partial index `deliveries_sibling_lookup_idx on (customer_phone_normalized, product_catalog_id, scheduled_date) where customer_phone_normalized is not null and deleted_at is null` keeps the sibling lookup at ~constant cost regardless of total delivery count.

**Audit + reconciliation impact.**
- Cancelled siblings are visible in `delivery_status_history` with explicit `reason` text — searchable and auditable.
- Client remit and agent earnings now naturally count only the winning row (cancelled rows are excluded from the `where current_status='delivered'` filter in [scripts/phase6-reconciliation.sql](scripts/phase6-reconciliation.sql)).
- Stock `current_stock` view sums `quantity_delivered` only for delivered rows — cancelled siblings don't decrement.

**One-time backfill** ([scripts/cleanup-existing-sibling-duplicates.sql](scripts/cleanup-existing-sibling-duplicates.sql)) runs the sibling matcher across existing data once and cancels in-place. Wrapped in a transaction with a `RAISE NOTICE` summary so admin can review before COMMIT.

**Edge cases:**
- Sibling with no `assigned_agent_id` → cancelled but no push (silent). Common immediately after rollover before Uzo re-assigns.
- Status change `pending → not_answering → available` → Stage 1 does NOT fire (the guard requires `OLD=pending`, not any-to-available). Stage 1 still fires on the first legitimate `pending → available`.
- Winning agent reverts a `delivered` (admin-only) → siblings stay cancelled (no auto-uncancel). Uzo can manually re-create if needed.

**Acceptance:**
- Creating 4 duplicate rows for the same order and marking one delivered → the other 3 auto-cancel.
- Reconciliation for that day shows the client billed once, not 4×.
- Stock for that product decrements once, not 4×.
- A same-day repeat order from the same customer with a different address is NOT auto-cancelled.
- Audit log captures the rollover decision

---

### 5.12 Reconciliation views & reports

**User story:** As admin, I reconcile **daily** with both my agents and my clients. I can pick any other range when I need to (yesterday, last 7 days, custom). For any client I can produce a per-delivery report and share it via WhatsApp; I can also share my own daily P&L summary.

**Screens:**
- Reconciliation tab with three sub-tabs:
  - **By client** — per-client totals for the selected range. Tap a row to drill into the per-delivery breakdown for that client.
  - **By agent** — per-agent totals (deliveries, earnings owed).
  - **Summary** — Reda's own P&L for the range: customer owed/paid/outstanding, Reda delivery fees, remit owed to clients, agent payments, Reda margin.
- Range chips: **Today** (default), **Yesterday**, **Last 7 days**, **Custom** (date inputs).
- Per-client detail view (new): summary card + scrollable per-delivery list + **Share with client** button that opens the system share sheet with a formatted plain-text report.

**Money model (all per-delivery, never per-unit):**
- `customer_price` — what the customer was supposed to pay the agent at the door for this trip. Flat per delivery. Set by the client.
- `paid` — what the customer actually paid.
- `charged_snapshot` — Reda's per-delivery fee from `rate_card` keyed by `location_id`, snapshotted at create time.
- `agent_payment_snapshot` — what Reda pays the assigned agent for this trip, snapshotted at create time (and re-snapshotted at auto-assign if a per-agent bonus applies).
- `cash_pos_fee_snapshot` (since 2026-05-29) — ₦500 when the delivery was paid in cash (`payment_method='cash' AND paid > 0`), 0 otherwise. Snapshotted at delivered-time inside `change_delivery_status` so a future fee change doesn't retroactively shrink historical remits. Pass-through to the client, NOT Reda revenue — it represents the POS-to-bank conversion cost Reda incurs cashing out the collected cash. Hardcoded today; per-client variance (e.g. a client paying its own POS fees) would be a `clients.cash_pos_fee` column when actually needed.

**Logic:**
- Per-client report row math (from `client_remit_summary`):
  - `total_customer_price = SUM(customer_price)`
  - `total_paid           = SUM(paid)`
  - `outstanding          = total_customer_price - total_paid` (customer short-pay)
  - `total_reda_fee       = SUM(charged_snapshot)`
  - `total_cash_pos_fee   = SUM(cash_pos_fee_snapshot)` *(0 for transfer rows and for any pre-2026-05-29 row whose column is NULL — coalesced to 0)*
  - `total_remit          = total_paid - total_reda_fee - total_cash_pos_fee` *(what Reda owes the client back)*
- Per-agent earnings (from `agent_earnings_summary`):
  - `total_earnings = SUM(agent_payment_snapshot)` *(no multiplication by quantity)*
- Per-delivery drill-down (from `client_remit_detail`) includes `reda_fee`, `cash_pos_fee`, and `remit` per row.
- **Reda margin is unchanged.** Cash POS fee is a pass-through to the client; it does NOT contribute to Reda's gross. The Summary tab's *Reda margin = total_reda_fee − total_agent_payments* keeps the same shape it had pre-cash-POS-fee.

**Edge cases:**
- Partial payments: `remit` uses actual `paid` − `reda_fee` − `cash_pos_fee`. Reda never absorbs underpayment — outstanding is the client's collection problem.
- Voided deliveries: excluded automatically (`deleted_at` filter).
- Date range crossing rate changes: snapshots ensure historical rates.
- A delivery whose location wasn't in the rate card at create time: `reda_fee = 0`, so `remit = paid − cash_pos_fee` for that row. Surfaces in the report; admin can backfill or accept.
- Pre-2026-05-29 delivered rows: `cash_pos_fee_snapshot` is NULL; the `SUM(coalesce(..., 0))` treats them as 0 so already-settled historical remits are unaffected. The change applies forward from the first cash delivery marked after the SQL was pasted.

**Acceptance:**
- Numbers match manual `SUM`s from raw delivery rows.
- Share button produces clipboard-ready plain text that lists per-delivery customer-paid / Reda fee / remit plus totals.
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

**Client (vendor) identity is hidden from agents (since 2026-05-27).** The earnings list shows only product + customer + amount — never the client/vendor name. Same redaction applies on the agent Today list, the agent delivery-detail screen, and *My Stock*. `listAgentEarnings` doesn't even fetch `clients(name)` from the wire. Canonical write-up in [reda_system_design_doc.md §2 Key access rules](reda_system_design_doc.md).

**Acceptance:**
- Agent sees own earnings only
- Numbers match admin's per-agent view for same agent + same date range
- No vendor/client name visible on any agent surface

---

### 5.14 Push notifications

**User story:** As an agent, I get notified when a delivery is assigned to me — including a pickup hint if my stock is short. As admin/dispatcher, I get pushed on operationally significant events I should react to.

**Architecture:**

- **Multi-device tokens.** `public.push_tokens(user_id, token UNIQUE, platform, device_label, created_at, last_seen_at)` replaces the legacy single `users.expo_push_token` column. A user signing in on N phones gets N rows; a phone changing owners flips the row's `user_id` via UPSERT on the unique token. Sign-out removes the row via `release_my_expo_push_token`.
- **Generic Edge Function: `send-notification`.** Accepts `{audience, …}` body shapes (`user`, `admins`, `admins+dispatchers`, `assignment`, `status_change`), resolves audience → user IDs → all their tokens, batches up to 100 messages to Expo's push API per call, and auto-prunes tokens that respond `DeviceNotRegistered`. Deployed with `--no-verify-jwt` since it's only ever called from inside the cluster.
- **Trigger layer (Postgres + pg_net):**
  - `notify_assignment_push` — on `deliveries` insert/update where `assigned_agent_id` changes. Calls `send-notification` with `audience: 'assignment'`; the function appends the stock-shortfall hint to the body when applicable.
  - `notify_pickup_needed` — same edge, but only fires when the chosen agent's current_stock can't cover the delivery; pushes admins+dispatchers.
  - `notify_delivery_status_change` — fires when `current_status` enters a notify-worthy terminal: `delivered`, `cancelled`, `failed_delivery`, `unserious`, `no_product`. Pushes admins via `audience: 'status_change'` with a friendly body (*"Funke delivered to Mr Adeyemi · Ikeja · ₦18,000 collected"*).
  - `notify_bot_review` — on `bot_inbound_messages` reaching `status='needs_review'`. Pushes admins+dispatchers.
  - `notify_negative_stock` — after every `stock_adjustments` insert; if the resulting `current_stock.quantity_on_hand` is negative, pushes admins.
- **Scheduled function: `scheduled-eod-check`.** Supabase Cron at `59 22 * * *` (UTC, = 23:59 Lagos UTC+1). Triggers the EOD rollover (collapses sibling groups, rolls non-terminal rows to tomorrow unassigned). Time aligned with §5.11 — old `0 19 * * *` (~20:00 Lagos) schedule was stale.
- **Mobile-side wiring** (`mobile/src/lib/notifications.ts`):
  - `configureNotifications()` runs once at module load — sets `setNotificationHandler` so foreground pushes still raise a banner+sound (without it Android/iOS drop them silently), and creates the Android `default` HIGH-importance channel.
  - `useNotificationTapRouting(role)` mounted inside `AuthGate` — consumes `getLastNotificationResponseAsync` (cold-start) + subscribes to `addNotificationResponseReceivedListener` (warm). Routes on `data.route` first (`review`, `stock`, `eod`) then on `data.delivery_id`, picking the role-appropriate path. No-op on `Platform.OS === 'web'`.
  - `usePushTokenRegistration` calls `set_my_expo_push_token(token, platform, device_label)` on login; caches the live token in AsyncStorage so sign-out can release it.

**Notification copy:**
- Assignment (agent): `"<customer> — <location> — <product> × <qty>"` — plus `" — pick up N from warehouse first"` when the agent is short.
- Pickup needed (admins/dispatchers): `"<agent> needs N more <product> for <location>. Issue a transfer from warehouse."`
- Status change (admins): friendly per-status (Delivered / Failed / Cancelled / Customer not serious / Out of stock).
- Bot review (admins/dispatchers): `"A WhatsApp message couldn't be parsed — open Review."`
- Negative stock (admins): `"<agent> is at <-N> on <product>"`.
- Auto EOD success (admins): `"Rolled N deliveries forward. Tap to review."` (fired by [scheduled-eod-check](supabase/functions/scheduled-eod-check/index.ts) at 23:59 Lagos).
- Auto EOD no-op (admins): `"All clear — nothing to roll."`
- Auto EOD failure (admins): `"Auto end of day FAILED — open the EOD screen and run it manually. (<error>)"`

**Edge cases:**
- Token rotates (Expo invalidates) → `DeviceNotRegistered` response → function auto-deletes the row from `push_tokens`.
- User signs out → device's row removed; if they sign back in the registration hook re-inserts.
- Android battery optimization killing notifications → admin runbook documents the "exempt Reda from battery optimization" step for agents.
- No push token (permission denied) → user just doesn't get pushes; everything else still works.

**Acceptance:**
- A user signed in on two phones receives the same push on both.
- Tapping a notification deep-links: assignment → delivery detail; review → `/(admin)/needs-review` or `/(dispatcher)/review`; stock → `/(admin)/stock`; eod → `/(admin)/eod`.
- Foreground notifications display (regression-tested — silent foreground was the pre-fix gap).
- Audit-style traceability: every push goes through `send-notification` which logs status code + pruned-token count in `net._http_response`.

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

These (and additional RPCs added during testing) live in security-definer functions that check the caller's permissions internally. Patterns to highlight:

- `update_self_profile(p_display_name, p_phone)` — self-only profile edit; `auth.uid()`-scoped, audit-logged.
- `set_my_expo_push_token(p_token, p_platform, p_device_label)` / `release_my_expo_push_token(p_token)` — multi-device push token lifecycle.
- `set_agent_locations(p_agent_id, p_preferred_ids, p_avoided_ids)` — admin-only; atomic replace of an agent's location preferences with conflict guard ("location cannot be both preferred and avoided").
- `create_delivery(...)` — admin/dispatcher only. Snapshots rates, writes the initial history row, audit-logs, idempotent on `client_uuid`. Stockless agents are accepted; the stock block now sits on `change_delivery_status` at the `'delivered'` transition. `tg_notify_pickup_needed` fires when the assigned agent's `current_stock < quantity_ordered`.
- `update_delivery_fields(p_delivery_id, p_customer_name?, p_customer_phone?, p_raw_address?, p_location_id?, p_client_id?, p_product_catalog_id?, p_quantity_ordered?, p_customer_price?, p_assigned_agent_id?)` — admin/dispatcher only, pre-delivery statuses only, `coalesce`s missing fields, requires the caller holds an `edit_locks` row for the delivery; full diff written to `audit_log`.
- `resolve_inbound_to_delivery(p_inbound_id, p_delivery_id)` — flips a `bot_inbound_messages` row to `status='created_delivery'` and links the new delivery; called from the in-app fix-review flow after `create_delivery` succeeds.
- `discard_inbound(p_inbound_id, p_reason)` — moves a needs-review row to `status='error'` with `error_text='discarded: <reason>'`; for the spam / duplicate / not-a-real-order cleanup path.
- `acquire_edit_lock(p_entity_type, p_entity_id, p_takeover?)` / `release_edit_lock` / `heartbeat_edit_lock` — pessimistic 5-minute lock on `delivery` or `bot_inbound` rows; take-over writes a `delivery_followup` / `edit_lock` audit row. Used by Edit-delivery and Fix-review screens to prevent two admins clobbering each other's work.
- `claim_followup(p_delivery_id, p_takeover?)` / `release_followup(p_delivery_id)` — admin/dispatcher claim that they're handling the customer call/WhatsApp for a soft-status delivery. Soft-statuses only; auto-released by `tg_clear_followup_on_status_change` on any status change. No TTL — claim outlives a screen session; peer take-over is audited.
- `flag_delivery_issue(p_delivery_id, p_issue_type, p_note, p_new_status, p_client_uuid)` — agent-only (must be the assigned agent). Idempotent on `p_client_uuid` via a partial unique index on `delivery_messages.client_uuid`. When `p_new_status` is non-null, wraps `change_delivery_status` in the same transaction (auth.uid() propagates through security-definer so the inner role check still sees the agent). Returns the inserted `delivery_messages` row.
- `reply_to_delivery(p_delivery_id, p_text, p_client_uuid)` — admin/dispatcher only. Rejects when (a) no agent flag exists yet for this delivery (prevents ops seeding), (b) the parent delivery is in a terminal status. Idempotent on `p_client_uuid`.
- `mark_messages_read(p_delivery_id)` — single UPDATE; caller's role decides which direction is "incoming" (agents mark ops messages read, ops marks agent messages read). No audit.
- `_ensure_workday(p_candidate date) → date` — immutable helper. Reda's work week is Mon–Sat; returns `p_candidate` unchanged for Mon–Sat or bumps Sunday → Monday. Applied uniformly inside `rollover_delivery` to both default and explicit-override paths.
- `run_eod_rollover_all_stuck(p_reason text default 'auto_eod_cron')` — admin/dispatcher only. Walks every distinct `scheduled_date <= current_date` that still has a non-terminal delivery and calls `run_eod_rollover(date)` per group. Called by the [scheduled-eod-check](supabase/functions/scheduled-eod-check/index.ts) cron, which signs in as the Reda System admin user so the inner role checks pass naturally.

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

### 5.17 Internal voice calling

**User story:** As an internal user (admin / dispatcher / rep / warehouse), I can place a 1:1 voice call to any other active internal user from the Team directory in Profile, or redial from Call history. As an **agent**, I can ring the *whole ops team at once* (admin + dispatcher + rep) to flag an urgent delivery issue — the call goes to whoever picks up first.

**Screens:**
- **Team directory** ([app/(call)/team.tsx](mobile/app/(call)/team.tsx)) — roster of active users grouped by role, tap to call. Reached from Profile → Team directory. **Agent variant (since 2026-05-27):** when the viewer's role is `agent`, the same route renders a single big green **Alert team** CTA instead of the directory; one tap fires a team-broadcast call. Agents cannot dial individual users.
- **Call screen** ([app/(call)/call/[callId].tsx](mobile/app/(call)/call/%5BcallId%5D.tsx)) — caller name, status, duration timer, mute, speaker, end. Shared between caller and callee (`isCaller = userId === call.caller_id`).
- **Call history** ([app/(call)/history.tsx](mobile/app/(call)/history.tsx)) — own calls newest first; missed/declined/cancelled colored red; tap-to-redial. Team-call rows redial via `initiateTeamCall` not `initiateCall` so the broadcast semantics carry through.
- **Incoming call UI** — provided by the system telecom framework via `react-native-callkeep`; full-screen lock-screen UI with the user's chosen system ringtone, Bluetooth headset accept/end support. No custom screen. Team-call rings render as **"Team call · `<Agent>`"** in CallKeep so the callee knows it's a broadcast page; the in-app overlay's Decline button reads **Dismiss** (local-only) because the server refuses `decline_call` on `callee_audience='ops_team'` rows — declining on behalf of the whole team would kill the page for peers who haven't seen it yet.

**Logic:**
- Audio via Agora Voice SDK (`react-native-agora`). App Certificate stays server-side only — tokens minted by the [issue-agora-token](supabase/functions/issue-agora-token/index.ts) Edge Function with a 5-minute TTL. Mobile refreshes on `onTokenPrivilegeWillExpire`.
- Ring UX via [react-native-callkeep](https://github.com/react-native-webrtc/react-native-callkeep) (Android `ConnectionService`). Same model WhatsApp uses on Android. No bundled ringtone — OS plays the user's selection.
- **Three signaling layers, one job each**:
  - **Push** wakes the device. Trigger `notify_call_invite_push` on `calls` insert calls `send_edge_notification` with `audience: 'call_invite'`; the [send-notification](supabase/functions/send-notification/index.ts) function resolves recipients — for 1:1 it's the `callee_id`; for `callee_audience='ops_team'` it fans out to every active admin + dispatcher + rep — and pushes to all their `push_tokens`.
  - **Supabase Realtime** drives state truth. `useIncomingCallSubscription` watches `calls` filtered to `callee_id=eq.<me>` for 1:1; ops users get a second sub filtered to `callee_audience=eq.ops_team` for team rings. `useOutgoingCallSubscription` watches the specific in-progress call row regardless of audience.
  - **CallKeep** drives the ring UI. `coord.presentIncoming()` calls `RNCallKeep.displayIncomingCall`; the system rings; user taps Answer → coord runs `accept_call` RPC + fetches token + Agora `joinChannel` + navigates to the in-call screen.
- **Audience-targeted calls (since 2026-05-27).** `calls.callee_audience text not null` (`'user' | 'ops_team'`) with a CHECK constraint enforcing `(callee_audience='user') = (callee_id is not null)` — every row is *either* targeted at a named user *or* fanned to ops, never both, never neither. `initiate_call` gains a 5th `p_callee_audience` param (default `'user'` keeps old callers binary-compatible); when caller role is `agent`, audience MUST be `'ops_team'` — agents are hard-blocked from dialing individuals. `accept_call` branches on audience: for ops-team rings, the atomic UPDATE assigns `callee_id = v_user` AND flips `callee_audience='user'` as part of the same write, so the invariant holds post-accept and the rest of the lifecycle (tokens, end_call, history, expire sweep) treats the row identically to 1:1. The partial unique index `calls_one_ringing_per_callee` is narrowed to `where callee_audience='user'` so ops-team rings don't fight 1:1 ringing rules.
- **Multi-device callee (1:1) AND multi-callee (ops-team)**: same atomic primitive in both cases — `update calls set status='accepted' ... where status='ringing' ...` with a partial returning clause; zero-row return raises 40001. The losing accepter (whether a peer device on a 1:1 ring or a peer rep on a team ring) sees the row leave its sub's filter on UPDATE and CallKeep dismisses without toast spam. Edge Function token gate verifies `accepted_device_uuid = req.device_uuid` — the losing device gets no token even if it tries to accept. Stable per-device Agora `uid` via FNV-1a 32-bit hash of `device_uuid` so accidental dupes self-kick.
- Optional `related_delivery_id` links the call into a specific delivery's audit context (column on `calls`, FK to deliveries, `on delete set null`). For team-page calls the agent's "Alert team" button on a delivery automatically threads the delivery id through so whichever rep picks up has full context immediately.
- Idempotency via `client_uuid` (uuid; partial unique index) plus partial unique indexes on `(caller_id) where status='ringing'` and `(callee_id) where status='ringing' and callee_audience='user'`. The caller-side index naturally prevents one agent from spamming the team with concurrent pages.

**Edge cases:**
- **Stale push tap** (call already missed/cancelled): tap-handler short-circuits on `ringing_until` past now → routes to call history with the call highlighted instead of mounting a ghost ring.
- **Callee / team offline** (no push tokens or all unreachable): server-side `expire_ringing_calls` cron at 1-minute cadence (was 30s before 2026-05-27 — see §6 Operations on cron-cost tuning) flips the row to `missed`. Caller's "calling..." UI clears via Realtime on the row transition.
- **Mic permission denied at accept**: `ensureMicPermission()` is called inside `coord.answer` before `acceptCall` — denial fires `decline_call(p_reason='mic_denied')` so the caller's UI clears immediately instead of waiting 45s. For team-page rings: dismisses locally only (no `decline_call`), other peers keep ringing.
- **Token expiry mid-call**: Agora SDK fires `onTokenPrivilegeWillExpire` → refresh via [issue-agora-token](supabase/functions/issue-agora-token/index.ts) → `engine.renewToken(...)`.
- **Network drop mid-call**: Agora auto-reconnects. Connection state surfaces as "Reconnecting…" via `onConnectionStateChanged` (state=4).
- **Cancelled calls leaving zombie Agora channels**: caller's `cancel_call` triggers Agora `leaveChannel`; Agora channels are ephemeral with no participants.

**Acceptance:**
- Any pair of active internal users can complete a voice call end-to-end on Android.
- Agents can fire an ops-team broadcast and any active admin / dispatcher / rep can pick it up; only one wins, peers dismiss cleanly.
- Concurrent rings prevented: partial unique indexes on `caller_id` (all audiences) and `callee_id` (1:1 only) where `status='ringing'`.
- Multi-device callee: only one device joins the channel; the others' CallKeep UIs dismiss within 1s via `coord.externallyDismissed`.
- Push, Realtime, and DB stay consistent under cold-start, backgrounded, and foregrounded paths.
- No audio is persisted server-side — Supabase Storage stays at zero usage from this feature.
- All state transitions audit-logged via `write_audit('call', …)` — per-field rows in `audit_log`.
- Free-tier Supabase resource usage stays well under quota (calls table ~250 bytes/row × ~1k calls/month; Realtime ~20 concurrent channels vs 200 budget; Edge Function invocations ~10k/month vs 500k budget; pg_net response log pruned daily).

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

### Operations (added 2026-05-27 after the expo-clipboard OTA incident)

**Native-module rebuild discipline.** Adding any package that ships a native module (e.g. `expo-clipboard`, `react-native-callkeep`, `react-native-agora`) requires a new `eas build` BEFORE the JS that imports it can be safely OTA'd. Any `eas update` that pushes import-of-a-new-native-module to existing binaries will crash on open. The guard:

1. `npx expo install <module>` updates package.json.
2. **Bump `mobile/app.json` version** (e.g. 1.1.0 → 1.1.1) in the same commit. Because `runtimeVersion.policy = "appVersion"`, expo-updates segments JS bundles by app version — old binaries on 1.1.0 keep getting 1.1.0 bundles; new 1.1.1 binaries get the new JS. No coordination needed for rollout; users update at their own pace.
3. `eas build --profile preview --platform android` produces the new APK.
4. `eas update --channel preview` publishes the JS, tagged to the new version.
5. Distribute the new APK; old binaries stay safe on their last bundle.

Skipping step 2 is what caused the 2026-05-27 white-screen incident — `expo-clipboard` JS shipped via OTA to a 1.1.0 binary that didn't have the native module linked, so the Detail screen force-closed for everyone. CI could enforce this with a pre-`eas update` check that fails if `package.json` added a dep but `app.json` version didn't move — open item.

**Cron-cost tuning.** Sub-minute pg_cron schedules write to `cron.job_run_details` per run AND drive WAL replication events on every UPDATE; both are CPU costs that compound at scale. The `internal-calls-expire-ringing` job ran at 30s for 8 days before being moved to 60s on 2026-05-27 once CPU pressure forced an audit. Heuristic: a cron whose work is sub-millisecond and frequently no-ops should be the longest interval the UX tolerates, not the shortest the use case theoretically wants. For Reda's call-expiry sweep, 60s instead of 30s delayed the `ringing → missed` transition by at most 30s in the Call History screen — invisible. The cron schedule string follows pg_cron's two-form syntax: `'[1-59] seconds'` for sub-minute, standard 5-field cron (`* * * * *`) for ≥1 minute.

**Compute-tier sizing.** Reda spent its first weeks on the Free / Nano tier (Shared CPU, burstable AWS t-class). Daily-max CPU climbed from ~55% to 100% over the week leading up to 2026-05-27 — symptomatic of approaching the burst-credit baseline. The diagnosis came from comparing `pg_stat_statements` cumulative cost against the per-minute Supabase Metrics API (`https://<ref>.supabase.co/customer/v1/privileged/metrics`, Basic auth with `service_role`). Symptom shape on a credit-throttled burstable: high user+system mode, iowait ≈ 0, load avg > #cores. Fix: bump Compute Add-On to Micro ($10/mo) or Small ($15/mo) — both give 2-core *dedicated* ARM CPU and remove the credit cap. Memory hasn't been a bottleneck; pick the tier on CPU need, not RAM.

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
- **Demo:** a full operating day, Uzo runs daily reconciliation and shares a per-client report via WhatsApp.

### Milestone 5: Bot + AI pipeline (week 8-10)
- Bot integration (reads from the per-agent WhatsApp groups, creates deliveries attributed to the group's agent)
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
- Mark-as-remitted workflow
- Structured client rules (toggleable flags)
- Smarter auto-assignment learning (ML-based)
- AI fine-tuning on Reda's address data
- Voice calling extensions: group calls (3+ participants), video, call recording, presence/online indicators, PSTN bridging from in-app, iOS CallKit (CallKeep already wraps it via the same API when iOS lands)


---

*Last updated: this conversation. Will be revised when Uzo's Section 9 feedback comes in.*
