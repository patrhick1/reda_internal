# Delivery Instructions — Feature Scope

**Status:** Decisions signed off 2026-06-18 · ready to build · **No code/schema applied yet**

**Signed-off decisions (§9):** (1) build **Phase 1 + Phase 2 together** — Phase 2 is self-extracted from the raw message, no contractor dependency (see §2 / §7); (2) agent display = **labeled card, noticeable but calm** (not an alarm banner), under the address; (3) **locked after delivery** (pre-delivery only, existing terminal lock); (4) **detail screens only** — no list-row marker.

**Verified against the live system 2026-06-18** (psql + code): every load-bearing claim below holds — `bot_create_delivery` delegates to `create_delivery` via **named args**, `update_delivery_fields` has the exact 3-way `customer_phone_alt` pattern + terminal lock, `rollover_delivery` copies an explicit column list incl. `customer_phone_alt`, both views are explicit append-safe lists already exposing `customer_phone_alt`, and there is **exactly one overload** of each RPC today (see the §5 DROP/CREATE note).

## 1. Goal

Add a free-text **delivery instructions** field to a delivery — special handling notes
the agent needs when fulfilling it (e.g. _"use side gate", "call on arrival", "ask for
the gateman", "don't ring the bell"_). The field must be:

- enterable by ops at create and edit time,
- visible to the **agent** who executes the delivery (and to ops),
- **carried forward** when a delivery rolls over / is postponed,
- (Phase 2) optionally captured automatically from the WhatsApp intake.

## 2. Key findings from the current system

- **No existing field to reuse.** There is no delivery-level note/instruction/hint column
  today. `delivery_status_history.notes` is a *per-status-change reason* — a different
  concept — and must not be repurposed.
- **One real insert point.** `create_delivery` is the single `INSERT` into `deliveries`.
  The manual "New delivery" UI calls it directly; the WhatsApp bot reaches it too because
  `bot_create_delivery` validates/dedupes then **delegates to `create_delivery`**. So one
  column threaded through `create_delivery` covers both manual and bot creation.
- **Edits are partial + terminal-locked.** `update_delivery_fields` rejects terminal rows
  ("only pre-delivery rows can be edited") and applies partial updates via `coalesce(...)`.
  `customer_phone_alt` already uses a clean 3-way pattern (`null` = keep, `''` = clear, else
  set) that the instructions param should mirror exactly.
- **Rollover has its own insert.** `rollover_delivery` copies an explicit column list into
  the child row, so the new column must be added there to carry instructions forward.
- **Views are append-only friendly.** `deliveries_admin` (admin) and `deliveries_safe`
  (everyone else) select **explicit column lists** ending in the LATERAL `latest_*` joins.
  A new column can be **appended at the end** via `CREATE OR REPLACE VIEW` — no DROP needed.
- **Bot parse does not extract instructions today, but we can self-extract.** Neither
  `bot-parse-message` nor `mybot-parse-message` asks the model for an instructions field today.
  **We do NOT need the contractor for this** — we already receive the *full* WhatsApp raw message
  (`bot_inbound_messages.raw_text`, also stored as `deliveries.bot_raw_message`) and already run
  our own LLM over it to self-extract products[] and the envelope. So Phase 2 just adds an
  `instructions` field to *our* extraction schema/prompt and reads it off the raw message — same
  pattern we use for products and (post-2026-06-18) the address. **No external dependency.**

## 3. Scope

### Phase 1 — Manual entry + display + carry-forward (self-contained)

Fully within our control. No external dependency. This is the MVP.

- Ops can type instructions on **create** and **edit**.
- Instructions are shown to the **agent** (delivery detail) and to **ops** (delivery detail).
- Instructions **carry forward** on rollover / postpone.

### Phase 2 — Auto-capture from WhatsApp (self-extracted, build with Phase 1)

Also within our control — **no contractor dependency** (corrected 2026-06-18). We get the full
raw message and already LLM-extract from it, so we add instructions to our own extraction.

- Add an `instructions` field to our LLM extraction schema + prompt (`bot-parse-message`, and
  `mybot-parse-message` for the shadow pipeline). Rides the **same** LLM call — no extra cost.
- Thread it through `bot_create_delivery → create_delivery` (the param Phase 1 already adds).
- **Conservative prompt** — only extract a real handling/access/timing note ("use side gate",
  "call on arrival", "ask for the gateman"); return `null` when there's none, so a product note
  or an address fragment is never mistaken for an instruction.
- **Best-effort, additive over the manual path** — if the model misses one, ops still typed it
  (or can edit it in). So Phase 2 carries no downside on top of Phase 1; build the two together.

## 4. Schema changes

### 4.1 Column

```sql
alter table public.deliveries
  add column delivery_instructions text;   -- nullable, no default
```

Rationale: optional free text; `null` = none. No length cap at the DB (UI can soft-limit).

### 4.2 Views (append-only — no DROP)

Append `d.delivery_instructions` as the **last** column in each view's select list:

- `public.deliveries_admin`
- `public.deliveries_safe`

Both currently end in LATERAL `latest_*` columns; appending one more base column is a valid
`CREATE OR REPLACE VIEW` (column order in the output is irrelevant to PostgREST/JSON).

## 5. RPC / function changes

| Function | Change | Notes |
|---|---|---|
| `create_delivery` | add `p_delivery_instructions text DEFAULT NULL`; add to the `INSERT` column + values list | **Single insert point** — covers manual UI **and** bot (bot delegates here). Trim to `nullif(trim(...), '')`. |
| `update_delivery_fields` | add `p_delivery_instructions text DEFAULT NULL`; set with the **same 3-way pattern as `customer_phone_alt`** (`null` = keep, `''` = clear, else set) | Terminal rows stay locked → instructions editable **pre-delivery only** (matches the use case). |
| `rollover_delivery` | add `delivery_instructions` to its copied `INSERT` column + values list (`v_old.delivery_instructions`) | **Carry-forward** across rollover / postpone chains. |
| `bot_create_delivery` | add a pass-through `p_delivery_instructions text DEFAULT NULL`; forward it to `create_delivery` (named-arg call, so this is additive) | Receives the self-extracted value from `bot-parse-message`. |

> **⚠️ DROP + CREATE, not CREATE OR REPLACE, for the three RPCs whose signature changes
> (`create_delivery`, `update_delivery_fields`, `bot_create_delivery`).** Adding a parameter
> changes a function's **arity**, so `CREATE OR REPLACE` does **not** replace it — it creates a
> *second overload* alongside the old one. A subsequent call that matches both (old exact +
> new via the default) then fails with **`function … is not unique`**, breaking *all* delivery
> creation/edits (mobile **and** bot). Verified 2026-06-18 there is exactly **one** overload of
> each today, so the existing add-a-param scripts already drop cleanly — the SQL must
> `DROP FUNCTION public.<name>(<exact old signature>);` first, then `CREATE`. New functions
> default to `PUBLIC EXECUTE` (already how these are granted), so no extra GRANT is needed.
> `rollover_delivery` is a **body-only** change (no new param) → plain `CREATE OR REPLACE` is fine.

All are `SECURITY DEFINER` with `search_path` already pinned — keep that. Hand the SQL to the
user to paste into the Supabase SQL editor (no migrations / Docker).

## 6. Mobile changes

### 6.1 Service layer — `mobile/src/services/deliveries.ts`

- `DeliveryDisplayJoins` type (~L16–41): add `delivery_instructions: string | null;`
  (until `npm run gen:types` regenerates `database.gen.ts`, hand-add like `latest_*`/`items`).
- `CreateDeliveryInput` type: add `deliveryInstructions?: string | null;`
- `UpdateDeliveryFieldsPatch` type: add `deliveryInstructions?: string;` (omit = leave,
  `''` = clear — same semantics as `customerPhoneAlt`).
- `createDelivery()`: pass `p_delivery_instructions` to the `create_delivery` rpc call.
- `updateDeliveryFields()`: pass `p_delivery_instructions` to the `update_delivery_fields` rpc call.
- `attachJoins()`: carry `delivery_instructions` through (it rides the view spread; add the
  explicit read like the other `latest_*` fields if defending against bypass).

### 6.2 Form — `mobile/src/screens/deliveries/DeliveryFieldsForm.tsx`

- `DeliveryFormState` type: add `deliveryInstructions: string;`
- Initial state: `deliveryInstructions: initial?.deliveryInstructions ?? ''`
- Render a multiline `<Input>` after the address field:
  - label: **"Delivery instructions (optional)"**
  - `multiline`, ~3 rows
  - placeholder: e.g. _"Use side gate · call on arrival · ask for the gateman"_
  - helper: _"The agent sees this when delivering."_
- Optional / not in `REQUIRED_FIELDS`.
- **Note — shared by 3 screens.** `DeliveryFieldsForm` is rendered by New, Edit, **and
  `mobile/src/screens/review/InboundDetailScreen.tsx`** (the needs-review fix-and-create form).
  Adding the field surfaces it on the review-fix form too — harmless (that screen builds
  `initial` as a `Partial`, so it defaults to empty) and arguably useful (ops can add
  instructions while fixing a review row; `createDelivery` carries it). No extra wiring needed.

### 6.3 Create — `mobile/src/screens/deliveries/New.tsx`

- Pass `deliveryInstructions: state.deliveryInstructions.trim()` into `createDelivery(...)`.

### 6.4 Edit — `mobile/src/screens/deliveries/Edit.tsx`

- `initial` mapping: `deliveryInstructions: d.delivery_instructions ?? ''`
- `handleSave()` patch builder: if changed vs original, add
  `patch.deliveryInstructions = state.deliveryInstructions.trim()` (so `''` clears).

### 6.5 Display — BOTH detail screens (decision: labeled card, noticeable but calm)

A dedicated **"Delivery instructions" labeled card** — icon + label + a soft accent (tinted
background / accent left-border, info-blue family — **not** the red/amber alarm style reserved
for problems). Noticeable enough not to be scrolled past, without reading as an error. Match the
app's existing card/Banner visual language.

- **Agent:** `mobile/app/(agent)/today/[id].tsx` — the card sits **directly under the address**,
  where the agent is about to navigate. Primary reason the feature exists.
- **Ops:** `mobile/src/screens/deliveries/Detail.tsx` — same card, near the address.
- Render only when `delivery_instructions` is non-empty.
- Long text wraps/scrolls cleanly (multiline, no truncation).

### 6.6 Types regen

- Run `npm run gen:types` after the schema lands, or hand-maintain the field on the display
  type until then (existing convention).

## 7. Edge function changes (Phase 2 — self-extracted, no contractor dependency)

| File | Change |
|---|---|
| `supabase/functions/bot-parse-message/index.ts` | extraction JSON schema + prompt + `Extracted` type gain an `instructions` field (conservative: real handling/access/timing note, else `null`); thread the value into the `bot_create_delivery` rpc call |
| `supabase/functions/mybot-parse-message/index.ts` | same, for the Kimi/shadow pipeline |

We read the instruction **off the raw message ourselves** (same LLM call that extracts
products) — no contractor coordination required. Keep the prompt conservative so a product note
or address fragment is never mis-tagged as an instruction; it's best-effort and additive over
the manual entry (Phase 1), so a miss is harmless. Redeploy with `--no-verify-jwt` (project
convention — or the internal `functions.invoke` calls fail).

## 8. Behaviour / edge cases

- **Carry-forward:** a rolled/postponed child keeps the parent's instructions (via
  `rollover_delivery`). Editing the child later edits only that row.
- **Terminal lock:** instructions can't be changed once a row is delivered/terminal (the
  `update_delivery_fields` guard). Acceptable — instructions are a pre-delivery concern. If
  post-delivery edits are ever needed, that's a separate dedicated RPC (mirrors the existing
  post-delivered corrections pattern).
- **Clearing:** sending `''` clears; omitting leaves unchanged — consistent with
  `customer_phone_alt`.
- **Multi-product (Feature A):** instructions are **delivery-level**, not per line item.
- **Empty handling:** trim on write; store `null` for blank; render nothing when empty.

## 9. Decisions (signed off 2026-06-18)

1. **Scope:** ✅ **Phase 1 + Phase 2 together.** The contractor dependency was a false premise —
   we self-extract from the raw message (§2 / §7), so Phase 2 is just a prompt/schema addition
   plus the param Phase 1 already threads. Build both.
2. **Agent display:** ✅ **Labeled card, noticeable but calm** (icon + label + soft info-accent,
   not an alarm banner), directly under the address. Pick the cleanest treatment in the app's
   existing visual language (§6.5).
3. **Editable post-delivery:** ✅ **No** — pre-delivery only, under the existing
   `update_delivery_fields` terminal lock. No separate post-delivered RPC.
4. **List indicator:** ✅ **Detail screens only** — no list-row marker (easy fast-follow later
   if agents ask for the at-a-glance signal).

## 10. File / function touch-list

**DB (hand SQL to user):**
- `deliveries` table — add `delivery_instructions`
- `deliveries_admin`, `deliveries_safe` views — append column (`CREATE OR REPLACE VIEW`)
- `create_delivery`, `update_delivery_fields`, `bot_create_delivery` RPCs — **DROP + CREATE** (arity change, see §5)
- `rollover_delivery` RPC — body-only `CREATE OR REPLACE`

**Mobile:**
- `mobile/src/services/deliveries.ts`
- `mobile/src/screens/deliveries/DeliveryFieldsForm.tsx` (shared by New, Edit, **and** review-fix `InboundDetailScreen.tsx` — §6.2)
- `mobile/src/screens/deliveries/New.tsx`
- `mobile/src/screens/deliveries/Edit.tsx`
- `mobile/src/screens/deliveries/Detail.tsx`
- `mobile/app/(agent)/today/[id].tsx`
- `mobile/src/types/database.gen.ts` (regen)

**Edge functions (Phase 2 — self-extracted, no contractor):**
- `supabase/functions/bot-parse-message/index.ts`
- `supabase/functions/mybot-parse-message/index.ts`

## 11. Suggested sequencing

1. ✅ Decisions signed off (§9).
2. Draft + hand over schema SQL: column → views (`CREATE OR REPLACE VIEW`) → **DROP+CREATE**
   `create_delivery` / `update_delivery_fields` / `bot_create_delivery` → body-only
   `CREATE OR REPLACE rollover_delivery`. User pastes into the Supabase SQL editor.
3. Mobile: service types/calls → form field → New/Edit wiring → instructions card on both
   detail screens.
4. Edge (Phase 2): add `instructions` to the extraction schema/prompt in `bot-parse-message`
   + `mybot-parse-message`; thread to `bot_create_delivery`. Redeploy with `--no-verify-jwt`.
5. CI trio (`typecheck` + `lint` + `format:check`); smoke test create → edit → rollover →
   agent view → a bot order whose message contains an instruction.
6. Commit; OTA via `eas update --branch preview`.

## 12. Test checklist

- Create a delivery with instructions → visible on ops + agent detail.
- Create with blank instructions → no instructions section shown.
- Edit to change instructions → persists; edit to blank → clears.
- Attempt edit on a delivered row → blocked by the terminal lock (expected).
- Roll a delivery over (or postpone) → child retains instructions.
- Agent (deliveries_safe) can read the field; ops (deliveries_admin) can read the field.
- Long instruction text wraps/scrolls cleanly on both detail screens.
- **Phase 2:** a bot order whose message contains a real instruction ("use the side gate")
  auto-captures it onto the created delivery.
- **Phase 2 (no false positives):** a bot order with no handling note stores `null` — a product
  line or address fragment is NOT mis-tagged as an instruction.
