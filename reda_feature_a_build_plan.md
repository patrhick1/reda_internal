# Feature A — Multi-Product Orders · Comprehensive Build Plan

**Scope:** Feature A only (the ₦450k engagement Uzo signed for). Features B and C are out of scope here.
**Status:** **SHIPPED to production 2026-06-16** (Phases 0–3 live; multi-product intake + app surfaces in prod). Go-live verification in progress — see §11b. Phase 4 (contract) deferred ~1–2 weeks. Two production incidents surfaced during go-live verification and were fixed (webhook auth + mobile OTA channel) — both logged in §11b.
**Owner:** Reda dev · **Date:** 2026-06-16
**Source docs:** [reda_scope_of_work.md §2](reda_scope_of_work.md) (client-facing) · [reda_multi_product_migration_plan.md](reda_multi_product_migration_plan.md) (technical origin).

> **Golden invariant (repeat it everywhere):** Reda's charge and agent pay are **per-delivery, by location — never × quantity, never per product.** Multi-product changes *stock truth only*. Any code path where a product or line quantity touches fee/remit/earnings math is a **bug**. Two parity gates (stock + reconciliation) enforce this empirically before we ship.

---

## 0. Ground truth — verified against the live DB and code (2026-06-16)

Everything below was confirmed, not assumed:

| Item | Verified state | Implication |
|---|---|---|
| `delivery_items` table | **Does not exist** | Built in Phase 1 |
| `deliveries` columns | `product_catalog_id`, `quantity_ordered`, `quantity_delivered`, `customer_price` present; **no `items_fingerprint`** | Legacy single-product shape intact; fingerprint added in Phase 1 |
| Generic "Perfume" bucket | **1,188 deliveries**, **843 at qty=1**, client *Original Buy* | The damage surface; backfilled but not re-itemized historically |
| Total deliveries | **15,988** | Backfill dataset size — small, runs live |
| Real perfume SKUs seeded | **No.** *Original Buy* has only 3 active products: `Perfume`, `perfume brigand body spray`, `Sealant Clay` | Phase 0 (catalog seed) is real, required work |
| Extraction logic | **Exists & proven** in [mybot-parse-message/index.ts:72-204](supabase/functions/mybot-parse-message/index.ts#L72-L204): `products[]` strict schema, `coerceLineItem`, per-line `pickMatch` | Port it; don't rebuild |
| Coupling RPCs/views | `match_products_by_text`, `bot_create_delivery`, `create_delivery`, `run_eod_rollover`, `_find_sibling_deliveries` all live; `current_stock` is a **view** | All enumerated in §6 |
| Contractor merge gate | [bot-parse-message/index.ts:99-113](supabase/functions/bot-parse-message/index.ts#L99-L113) `extractContractorParse` sets `needsLlm` from `{product_name, raw_address, customer_phone}` | Decouple **product dimension** from this gate; keep envelope merge |

**Bottom line:** the design in the migration plan is accurate. This document turns it into an ordered, testable build with explicit gates, regressions, and done-criteria.

---

## 1. The problem & the goal

### 1.1 Problem
A Reda delivery is structurally **one product + one quantity** (`deliveries.product_catalog_id NOT NULL`, `deliveries.quantity_ordered NOT NULL`), with no line-items table. Real orders are bundles —
`2 Opulent Oud + 2 Khamrah Dukhan + 4 perfume oil + 4 atomizer`. The pipeline collapses every bundle into one generic **"Perfume"** SKU with a meaningless quantity (843 of 1,188 recorded as qty=1 despite holding 5–12 pieces).

The damage is **stock fiction**: on-hand is booked against the junk SKU, so you can't tell what a rider actually holds, and every drop under-counts. **Money is not affected** (golden invariant).

### 1.2 Goal
Model an order as an **envelope** (`deliveries`: customer, address, agent, status, **one fee**) containing **N line items** (`delivery_items`: product + quantity each), migrated **expand → contract** so the app is never down — at most a few flag-gated minutes of paused *intake* (inbound WhatsApp queues in `bot_inbound_messages` and replays; nothing lost).

### 1.3 Explicit non-goals (v1)
- **Per-item independent outcome** — delivering product A while failing product B on one order. v1 is all-or-nothing: one status, one fee per order. Per-line *quantity delivered* still varies (leftover/upsell).
- **Web UI** for multi-product (mobile-first; web is a fast-follow).
- **Product-level reporting / reconciliation** — reporting stays per-delivery.
- **Asking the contractor to change their bot** — we self-extract; no external dependency.
- **Retro-repricing history** — historical delivered orders are frozen.

---

## 2. Target data model

### 2.1 New table — `delivery_items` (the only new table)

```
id                  uuid pk default gen_random_uuid()
delivery_id         uuid not null  → deliveries(id) on delete cascade
product_catalog_id  uuid not null  → product_catalog(id) on delete restrict
quantity_ordered    int  not null  check (quantity_ordered > 0)
quantity_delivered  int  null      check (quantity_delivered >= 0)
customer_price      numeric(10,2) null   -- per-line price for record-keeping ONLY; never feeds fee math
created_at          timestamptz not null default now()
updated_at          timestamptz not null default now()
unique (delivery_id, product_catalog_id)   -- one line per product per order
index  (product_catalog_id)                -- stock aggregation
index  (delivery_id)
```

- `on delete cascade` from `deliveries` keeps soft-delete / terminal-lock semantics coherent.
- `on delete restrict` on `product_catalog` prevents deleting a SKU still referenced by live items.

### 2.2 `deliveries` (the envelope) — financially unchanged
Keeps `client_id`, `customer_*`, `raw_address`, `location_id`, `assigned_agent_id`, status, **all fee snapshots** (`charged_snapshot`, `agent_payment_snapshot`, `cash_pos_fee_snapshot`) exactly as-is — **one fee per delivery**, `parent_delivery_id`, `text_fingerprint`.

The legacy `product_catalog_id` / `quantity_ordered` / `quantity_delivered` columns are **retained through expand, dual-written through Phase 2–3, dropped in Phase 4**.

**New column:** `deliveries.items_fingerprint text NULL` — a stable hash of the sorted `(product_catalog_id, quantity_ordered)` set. Replaces the single `product_catalog_id` in structural duplicate / sibling / rollover detection.

### 2.3 Stock definition (post-cutover)
```
current_stock(agent, product) =
    Σ stock_adjustments.quantity_delta
  − Σ delivery_items.quantity_delivered   -- over deliveries where current_status = 'delivered'
grouped by (deliveries.assigned_agent_id, delivery_items.product_catalog_id)
```
Post-backfill this returns **identical numbers** to today (1 item per legacy order) — the view swap is a no-op in values, **asserted** by the parity gate.

### 2.4 `items_fingerprint` — exact definition (must be deterministic)
- Take the set of `(product_catalog_id, quantity_ordered)` for the delivery.
- **Sort** by `product_catalog_id` (stable, canonical order).
- Serialize as `product_catalog_id:quantity_ordered` joined by `|`.
- Hash with the **same digest already used by `text_fingerprint`** (reuse, don't invent — see `scripts/archive/duplicate-handling-digest-fix.sql`).
- A single-product order's fingerprint must be reproducible identically in SQL (`_items_fingerprint(delivery_id)`) and in the bot (`_delivery_items_sig(jsonb)`) — **one canonical algorithm, two call sites.** A divergence here silently breaks dedup.

---

## 3. Decisions baked in (confirm before build)

1. **Self-parse line items; don't wait on the contractor.** `bot-parse-message` extracts its own `products[]` (porting mybot's schema), and also honors `raw_payload.parsed.products[]` if the contractor ever emits it. A legacy single `parsed.product_name` is wrapped into a 1-item array as fallback. **No external dependency.**
2. **Fee stays strictly per-delivery.** `delivery_items.customer_price` is data fidelity only; never feeds fee math. The order total stays on `deliveries.customer_price`.
3. **Real SKUs replace the generic bucket**, seeded per client (starting *Original Buy*). Unmatched lines → `needs_review`, never silently collapsed. Generic "Perfume" stays alive until its historical rows are migrated, then retired.
4. **Rollover moves the whole order** (all items to one child) — never split per product.
5. **Multi-vendor bundle → `needs_review`.** If one message's products resolve to *different* clients/vendors, flag for a human.
6. **Backfill is 1 item per legacy order**, copying `(product_catalog_id, quantity_ordered, quantity_delivered)` verbatim — guarantees stock parity.

---

## 4. Phased rollout (expand → contract)

Downtime summary: **Phases 0–2 and 4 are zero-downtime.** Phase 3 is a **few flag-gated minutes** of paused *new-order intake only* (queued + replayed). The app never goes offline; riders keep working throughout.

Per the team's schema workflow, **every `.sql` below is handed to Uzo/operator to paste into the Supabase SQL editor** — no migrations, no Docker. Each script is idempotent and rollback-aware.

### Phase 0 — Catalog prep (online, no app change)
**File:** `scripts/multi-product-00-catalog-seed.sql` (idempotent inserts)
- Seed real perfume SKUs for *Original Buy* (`OPULENT OUD`, `KHAMRAH DUKHAN`, `OUD AL LAYL`, `perfume oil`, `atomizer`, …) into `product_catalog`. Generic "Perfume" stays active.
- **Blocker:** need the canonical SKU list. Two options: (a) derive a candidate list from raw message history + confirm with Uzo, or (b) Uzo hands the canonical names. **Resolve before writing this file.**
- **Exit:** new SKUs visible in admin Catalog screen; `match_products_by_text` returns them.

### Phase 1 — Schema expand (additive, zero downtime)
**File:** `scripts/multi-product-01-schema.sql`
- `create table delivery_items …` + indexes + checks (instant — no table rewrite).
- `alter table deliveries add column items_fingerprint text;` (nullable add = instant).
- Helper functions: `_items_fingerprint(delivery_id uuid)` and `_delivery_items_sig(jsonb)` — the **one** canonical fingerprint algorithm (§2.4).
- **Backfill** every existing delivery → one `delivery_items` row (copy the three legacy columns); set `items_fingerprint`. Runs live; 15,988 rows is small. **Idempotent** (`on conflict (delivery_id, product_catalog_id) do nothing`).
- **Parity baseline:** materialize a `current_stock` snapshot into a temp/audit table for the gate in Phase 3.
- Legacy columns remain source of truth — **nothing reads `delivery_items` yet.**
- **Exit:** `select count(*) from delivery_items` == count of deliveries with a non-null `product_catalog_id`; re-running the script is a no-op.

### Phase 2 — Dual-write RPCs (zero downtime, old app keeps working)
**File:** `scripts/multi-product-02-dualwrite.sql` (reuse live bodies from `scripts/archive/duplicate-handling-text-fingerprint.sql`, `scripts/fix-delivered-requires-location.sql`, `scripts/fix-update-delivery-fields-customer-price.sql`, `scripts/fix-eod-sibkey.sql`)

Every writer maintains **both** shapes:
- **`create_delivery` / `bot_create_delivery`** — add new `p_items jsonb` param (additive, default null). When null, derive a 1-item array from legacy `p_product_catalog_id` / `p_quantity_ordered` (old callers unaffected). Insert delivery → insert `delivery_items` rows → keep writing legacy columns → set `items_fingerprint`. **Stock guard loops per item** against `current_stock(agent, item.product)`.
- **`change_delivery_status`** (delivered path) — add optional `p_item_quantities jsonb` (`[{product_catalog_id, quantity_delivered}]`). When absent, fan the single `p_quantity_delivered` onto the lone item (back-compat). Write `delivery_items.quantity_delivered` **and** the legacy column. Stock guard loops per item.
- **`update_delivery_fields`** — accept `p_items jsonb`; replace the item set transactionally; recompute `items_fingerprint`. Rate recalc unchanged (location/client/agent only — **never product**).
- **`rollover_delivery` + `run_eod_rollover`** — copy child items from parent; **swap the sibling/dedup key from `product_catalog_id` + `quantity_ordered` to `items_fingerprint`** in `_find_sibling_deliveries`, in `bot_create_delivery`'s dupe pre-empt, and in the EOD `sib_key`.
- **`write_audit`** payloads gain an `items` array alongside legacy keys.
- **`current_stock` still reads legacy columns this phase** (no value change, lowest risk).

**Exit:** old mobile bundle creates/marks orders unchanged; new RPC params accepted; SQL smokes (§5) green.

### Phase 3 — Flip reads to items + ship multi-item (few-minutes flag-gated cutover)
**File:** `scripts/multi-product-03-cutover.sql` + edge deploys + `eas update`

**A. Stock view swap (atomic):**
- `create or replace view current_stock` to aggregate from `delivery_items`.
- **PARITY GATE:** assert the new snapshot is byte-identical to the Phase-1 baseline **immediately before and after** the swap. Abort cutover if not.

**B. Intake cutover (the only interruption):**
1. Flip `enable_bot_pipeline` **off** (inbound rows queue in `bot_inbound_messages`, nothing lost). Flags read at [bot-parse-message/index.ts:256-261](supabase/functions/bot-parse-message/index.ts#L256-L261).
2. Deploy updated `bot-parse-message` — extracts `products[]`, per-line `match_products_by_text`, calls `bot_create_delivery` with `p_items`; any unmatched line → `needs_review`. **Deploy with `--no-verify-jwt`** (standing requirement — internal `functions.invoke` calls fail silently otherwise).
3. Deploy notification functions (multi-product summary + per-item shortfall).
4. Flip `enable_bot_pipeline` **on** → queued messages drain through the multi-item path.
- **Agents keep using the app throughout; only new-order intake pauses for minutes.**

**C. The contractor merge (don't lose the envelope):**
Today `extractContractorParse()` sets `needsLlm=false` and skips our LLM when the contractor's `parsed` block has `product_name + raw_address + customer_phone` ([:99-113](supabase/functions/bot-parse-message/index.ts#L99-L113), merge at [:310-317](supabase/functions/bot-parse-message/index.ts#L310-L317)). The contractor only ever sends **one** product. For multi-product we **decouple the product dimension from that gate**:
- **Always** run our extraction on `raw_text` for `products[]` (port mybot's array schema/prompt + `pickMatch`).
- **Keep the contractor's per-delivery envelope** — `customer_name`, `customer_phone`, `raw_address`, plus `location` / `assigned_agent` / `client_hint` hints — merged exactly as today.
- The contractor's single `product_name` is kept only as a first-line sanity hint.
- Store `parse_result` in mybot's shape (`extracted.products[]`, `product_matches[]`, `client_id_conflict`).

**D. Shared extraction module (avoid the divergence debt):**
Factor mybot's `EXTRACTION_SCHEMA` / `coerceLineItem` / `coerceExtracted` / `pickMatch` into `supabase/functions/_shared/product-extract.ts` and import from **both** bots. The mybot code itself warns that a silent divergence between single- and multi-product matching corrupts data — one source prevents it.

**E. Types + mobile (OTA):**
- `npm run gen:types` → surface `delivery_items` + new RPC params.
- `eas update --branch preview` (OTA, instant). Old bundles still work (dual-write maintains legacy columns; RPCs accept both shapes). **Preview branch first — never straight to production.**

**Mobile surfaces to change (see §6 for the full list).**

**Exit:** parity gates green; bundle flows end-to-end on preview; `needs_review` catches unmatched + multi-vendor.

### Phase 4 — Contract (after all clients on the new bundle, ~1–2 weeks)
**File:** `scripts/multi-product-04-contract.sql`
- Drop dual-write; remove the single-product fallback in `bot-parse-message`.
- Drop `deliveries.product_catalog_id` / `quantity_ordered` / `quantity_delivered` (or convert to read-only generated convenience columns). Drop `deliveries_sibling_lookup_idx` (replaced by `items_fingerprint` / `delivery_items` index). **Retire the generic "Perfume" SKU.**
- Final `gen:types` + `eas update`.
- **Exit:** no `product_catalog_id`-keyed dedup remains; types clean; generic SKU inactive.

---

## 5. Test plan — written before shipping

Follows the existing `scripts/smoke-*.sql` convention (rollback-wrapped `begin … rollback`). Two gates **block the cutover**.

### 5.1 Hard gates (block Phase 3)
- **G1 · Stock parity** — `scripts/smoke-multi-product-stock-parity.sql`: snapshot `current_stock` for every `(agent, product)` holder before the view swap; assert **byte-identical** after. *Proves backfill + view correctness. The single most important test.*
- **G2 · Reconciliation parity** — `scripts/smoke-multi-product-recon-parity.sql`: `agent_earnings_summary` + client remit totals identical pre/post for a fixed date range. *Proves "fees untouched" empirically.*

### 5.2 Behavioral SQL smokes (`scripts/smoke-multi-product-*.sql`)
- **Create:** 3-item order → 1 `deliveries` row + 3 `delivery_items` + **exactly 1 fee snapshot**.
- **Mark-delivered partial:** one line short → per-item `quantity_delivered` correct; `current_stock` decrements only the right SKUs.
- **Dedup:** same item-set + same agent = duplicate (rejected); different item-mix = **not** a duplicate; cross-agent same items = race (allowed, per existing duplicate-vs-race rule).
- **Rollover:** EOD on a multi-item order → one child with identical item set; never split per product; sibling cancel-on-delivered still fires.
- **Fingerprint determinism:** `_items_fingerprint(delivery_id)` == `_delivery_items_sig(jsonb)` for the same set; order-independent.
- **Backfill idempotency:** re-run = no-op.
- **Stock guard per item:** creating/delivering a line exceeding on-hand for that SKU is blocked (other lines unaffected).

### 5.3 Intake / extraction tests (shadow mode)
- Real perfume bundle → `products[]` extracted, each line matched; unmatched line → `needs_review` (never silent collapse).
- Multi-vendor bundle → `needs_review`.
- Legacy single-product `parsed.product_name` only → wrapped into 1-item array; identical outcome to today.
- Contractor envelope preserved (customer/phone/address/location/agent) while our AI supplies the product list.

### 5.4 Mobile / E2E (preview build, manual)
- Old bundle (pre-OTA) and new bundle both create/mark during dual-write.
- Admin creates a multi-item order via the line-items picker; per-line shortfall shown.
- Agent marks partial per item; one status / one fee on resolution.
- *My Stock* / stock dashboard shows **real SKUs** with true counts.
- List / Detail / Recent activity render N products ("3 items" / itemized) without crash.

---

## 6. Coupling points & files touched (the full surface)

### 6.1 Backend coupling (must honor — from code exploration)
- **Sibling / dedup** — `bot_create_delivery` dupe pre-empt; `_find_sibling_deliveries` Tier-2 (`scripts/archive/sibling-coordination.sql`); `run_eod_rollover` `sib_key` — all embed `product_catalog_id` (+ `quantity_ordered`) → **re-key on `items_fingerprint`.**
- **Stock guards** at create + mark-delivered — per-`(agent, product)` → **loop per item.**
- **`current_stock`** decrement uses `deliveries.quantity_delivered` → `Σ delivery_items.quantity_delivered`.
- **Rollover** copies parent product/qty to one child → **copy the whole item set.**
- **`available_orders_safe`** view + mobile aggregate by product/qty → **aggregate from items.**
- **Indexes** — `deliveries_sibling_lookup_idx (phone, product_catalog_id, date)` → re-base on `items_fingerprint`.
- **Soft-delete / terminal locks** — `on delete cascade` from `delivery_items`; delivered rows stay locked.

### 6.2 Edge functions
- `supabase/functions/bot-parse-message/index.ts` — extract `products[]`, per-line match, `p_items`, decouple LLM-skip gate from product dimension, keep envelope merge.
- `supabase/functions/_shared/product-extract.ts` — **new** shared module (schema + coerce + pickMatch).
- `supabase/functions/mybot-parse-message/index.ts` — refactor to import the shared module (source of the ported logic).
- **Notifications (per-product summary + per-item shortfall):**
  - `send-assignment-push/index.ts` (`:66,90` build `"${productName} × ${quantity_ordered}"` from a single join).
  - `send-notification/index.ts` — assignment (`:196-223`), warehouse-pickup (`:358-406`) compute shortfall against one product; status-change (`:233-296`) reads a single `quantity_delivered`. → all take a **products summary** + loop shortfall per item.

### 6.3 Mobile (`mobile/`)
- `services/deliveries.ts` — add `DeliveryItem[]` to row type + joins; `siblingGroupKey` (`:284-301`) keys on `items_fingerprint`; create/update/changeStatus inputs carry `items` / per-item delivered.
- `services/available-orders.ts` — aggregation sums from items.
- `services/reconciliation.ts` — **verify `:32-33` `× quantity_delivered` comment does not actually multiply**; align to per-delivery; confirm totals unchanged.
- `types/database.gen.ts` — regenerated.
- `screens/deliveries/DeliveryFieldsForm.tsx` (`:16-27, 434-463`), `New.tsx`, `Edit.tsx` — product picker → add/remove line-items list (product + qty per row); per-line stock via `getAgentProductStock()`.
- `components/sheets/MarkDeliveredSheet.tsx`, `BulkMarkDeliveredSheet.tsx`, `screens/deliveries/StatusUpdatePanel.tsx` — capture `quantity_delivered` per item; per-item on-hand validation. **(Most complex UI.)**
- Read/list surfaces: `Detail.tsx` (`:502-525`), `List.tsx` (`:667`), `components/delivery/RecentActivityCard.tsx` (`:91`), `screens/stock/Movements.tsx`, `screens/ops/OpsDashboard.tsx` — render N products.

> **Before every mobile commit:** run `npm run format:check` (CI's 4th step fails the build on unformatted files even when tsc+lint pass).

---

## 7. Regressions — what can break & the mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Fee / remit / earnings drift | **Critical** | G2 reconciliation parity gate; golden invariant enforced; `customer_price` per-line never in fee math |
| Stock double/under-count | **Critical** | G1 stock parity gate (byte-identical pre/post) |
| `reconciliation.ts:32-33` actually multiplies by qty | High | Explicit read + assert it doesn't; align to per-delivery |
| Dedup over-fires (legit orders rejected) | High | Deterministic sorted-set fingerprint; dedup smokes |
| Dedup under-fires (duplicates leak) | High | Same; cross-agent race rule preserved |
| EOD rollover fragments an order per product | High | Rollover copies whole item set; rollover smoke |
| Contractor envelope regressed by gate decoupling | High | Keep customer/phone/address/location/agent merge exactly; intake tests |
| Notification crash/empty on multi-item | Medium | Products-summary helper + per-item shortfall; notification smoke |
| Old JS bundle vs new RPCs during dual-write | Medium | Additive params (default null → derive 1-item); old-bundle E2E |
| Extraction divergence single vs multi | Medium | One shared `_shared/product-extract.ts` module |
| Terminal/locked rows mutated | Medium | `on delete cascade`; delivered rows stay locked (existing RPC guards) |
| Edge deploy drops internal calls | Medium | Deploy with `--no-verify-jwt` (standing rule) |
| Intake messages lost during cutover | Medium | `enable_bot_pipeline=off` queues in `bot_inbound_messages`; replay on |

---

## 8. Definition of done

Feature A is complete when **all** hold:
- [ ] G1 stock parity + G2 reconciliation parity green across a real date range.
- [ ] All §5.2 SQL smokes pass (rollback-wrapped).
- [ ] §5.3 intake tests pass in shadow: bundle itemized; unmatched + multi-vendor → `needs_review`.
- [ ] End-to-end on a **preview build**: WhatsApp bundle → itemized delivery → assign → mark partial-per-line → stock dashboard shows real SKUs with true counts.
- [ ] Old + new mobile bundles both work during dual-write.
- [ ] Phase 4 contract done: legacy columns dropped, generic "Perfume" retired, `gen:types` clean, no `product_catalog_id`-keyed dedup remaining.
- [ ] PRD / system design updated to the multi-product data model.

---

## 9. Rollback strategy (per phase)

- **Phase 0–1:** purely additive. Rollback = `drop table delivery_items` + `alter table deliveries drop column items_fingerprint`. No data loss (legacy columns untouched).
- **Phase 2:** dual-write. Rollback = restore prior RPC bodies from `scripts/archive/`. Legacy columns still source of truth, so reverting RPCs is safe; `delivery_items` rows become inert.
- **Phase 3:** the only risky flip. If a parity gate fails, **abort before the view swap** — flags revert, old bot redeploys, queued messages drain through the single-product path. If discovered after: `create or replace view current_stock` back to the legacy aggregation (legacy columns still dual-written), revert edge functions, `eas update` the prior bundle.
- **Phase 4:** point of no return for legacy columns. Do **not** start until Phase 3 has run stable ~1–2 weeks and both gates have held across multiple EOD cycles.

---

## 10. Open items to resolve before Phase 0

1. **Canonical SKU list for *Original Buy*** — derive-and-confirm from message history, or Uzo provides. (Blocks the catalog seed.)
2. **Confirm the fingerprint digest** to reuse (`text_fingerprint`'s) so SQL and bot agree.
3. **Pick the fixed date range** for the parity gates (a stable, fully-reconciled past window).

---

## 11a. Implementation progress log

| Item | Status | Evidence |
|---|---|---|
| **Phase 1 schema script** — `scripts/multi-product-01-schema.sql` | ✅ **Drafted + verified** (not yet applied to prod) | Ran in a rollback txn on the live DB: 15,989 deliveries → 15,989 `delivery_items`, 0 missing fingerprints; **stock parity byte-identical** to baseline; fingerprint helpers agree on 500/500 rows. Nothing persisted. |
| **Phase 1 smoke** — `scripts/smoke-multi-product-01-schema.sql` | ✅ **Drafted + passing** | 3 subtests PASS (backfill completeness, stock parity, fingerprint determinism/order-independence/qty+set sensitivity), rollback-wrapped. |
| **Shared extraction module** — `supabase/functions/_shared/product-extract.ts` | ✅ **Drafted** (additive; nothing imports it yet → zero behavior change) | `deno check` clean. Ports mybot's array schema/prompt/coercion/`pickMatch`; adds `buildItemsPayload`. |
| Bug found + fixed during verification | ✅ | `digest()` needed schema-qualifying as `extensions.digest` (matches `_text_fingerprint`). |
| **Phase 0 catalog seed** — `scripts/multi-product-00-catalog-seed.sql` | ✅ **Drafted + verified** | SKU list **derived from message history** (Perfume Oil 1152, Oud Al Layl 907, Atomizer 282, Opulent Oud 282, Khamrah Dukhan 276, Pacific Blue 119 hits). Marked **CONFIRM WITH UZO**. Rollback-verified: 3→9 active SKUs, generic "Perfume" preserved, `match_products_by_text` resolves new SKUs. |
| **Phase 2 dual-write** — `scripts/multi-product-02-dualwrite.sql` + smoke | ✅ **Drafted + verified** | `_apply_delivery_items` / `_apply_item_deliveries` helpers; `create_delivery`/`bot_create_delivery`/`update_delivery_fields`/`change_delivery_status` extended with additive `p_items`/`p_item_quantities`; rollover item-copy trigger. Captured live bodies + grants first (`tools/live-defs/`). 4 smoke subtests PASS incl. **multi-item fee byte-identical to single (golden invariant)**. Dedup-key swap deferred to Phase 3 (documented). |
| Apply to prod / edge deploys / EAS | ⛔ **User action** | Per standing rules: SQL handed over for the Supabase editor; deploys/EAS operator-driven, preview-first. |

| **Phase 3a stock view swap** — `scripts/multi-product-03a-stock-view.sql` | ✅ **Drafted + verified** | `current_stock` `delivered_decrements` now sums `delivery_items.quantity_delivered`. In-transaction **PARITY GATE** aborts on any drift. Rollback-verified: **gate PASSED, 0 diff cells across all 488 holders**. Self-contained rollback block included. |

| **Applied to prod + re-verified** | ✅ | User applied **Phase 1, 2, 3a** in Supabase. Re-verified live: structure intact, **legacy-logic-now vs items-logic-now = 0 diff cells**, `current_stock` now reads `delivery_items`, both smokes green. Fixed a stale-baseline flaw in the Phase-1 smoke + Phase-3a gate (compare legacy-vs-items on current data, never frozen-vs-current). |
| **Phase 3b dedup re-key** — `scripts/multi-product-03b-dedup-rekey.sql` + `smoke-…-03b-dedup.sql` | ✅ **Drafted + verified** (not yet applied) | `_find_sibling_deliveries`, `create_delivery` guard, `bot_create_delivery` pre-empt/orphan, `run_eod_rollover` partitions/`sib_key` re-keyed to `items_fingerprint`. 3 smoke subtests PASS incl. **different bundles sharing one product are NOT over-deduped**. Behaviour-preserving while single-item; `rollover_delivery` left to the Phase-2 trigger. Safe to apply now. |

| **Dry-run validation** — `tools/multiproduct-dryrun.ts` | ✅ **5/5 real bundles itemize correctly** | Ran new extraction + per-line matching on 5 real Original Buy bundles, zero prod impact. Caught + fixed a prompt gap (it was extracting SKU-header lines + "FREE DELIVERY" as products). After fix: 5/5 would create, all matched to Original Buy. Catalog-match check also clean (every real phrase → correct seeded SKU). |

| **Phase 3d-1 mobile data layer** — `mobile/src/services/deliveries.ts` | ✅ **Done, `tsc` clean + Prettier clean** | `DeliveryItem` type; batched `fetchDeliveryItemsFor`/`attachItemsToRows` (separate query, not view-embed — robust); `DeliveryRow.items`; `siblingGroupKey` now keyed on the item set (mirrors `_delivery_items_sig`); `createDelivery`/`updateDeliveryFields`/`changeDeliveryStatus` carry `items`/`itemQuantities` → `p_items`/`p_item_quantities`; batched `getAgentProductsStock`. Whole mobile project still `tsc` 0 errors. |

| **Phase 3d-2 forms** — `DeliveryFieldsForm.tsx` + `New.tsx` + `Edit.tsx` | ✅ **Done, tsc+eslint+prettier clean** | Product picker → add/remove **line-items editor** (product Select + qty per row, +Add line, ×Remove); validates ≥1 complete line, no partial/dup lines; per-line stock shortfall for the assigned agent; legacy primary derived from line[0]; New passes `items`, Edit seeds from `d.items` + diffs the set. |
| **Phase 3d-3 mark-delivered** — `MarkDeliveredSheet.tsx` + `BulkMarkDeliveredSheet.tsx` + `StatusUpdatePanel.tsx` + queue (`types.ts`/`executors.ts`) | ✅ **Done, tsc+eslint+prettier clean** | Per-line qty inputs (single-line = unchanged UX), per-line stock guard, sum→`quantityDelivered`, `itemQuantities`→`p_item_quantities` threaded through the offline queue. Bulk delivers every line in full. StatusUpdatePanel: single-line editable, multi-line delivers-in-full with a note. Money stays per-delivery. |
| **Phase 3d-4 read surfaces** — `services` helpers + `Detail.tsx` + `List.tsx` + `RecentActivityCard.tsx` | ✅ **Done, tsc+eslint+prettier clean** | `deliveryProductsSummary` / `deliveryProductsLabel` helpers; Detail itemizes per-line (qty + delivered); List + Recent show "N items"/product label. |

| **Phase 3d-5 warehouse planning** — `scripts/multi-product-03d-available-orders-view.sql` + `scripts/multi-product-03d-stock-movements.sql` + `available-orders.ts` | ✅ **Done + SQL verified, mobile tsc/eslint/prettier clean** | Itemized `available_orders_safe` (one row per line item, RLS preserved — verified a 2-item available delivery → 2 rows) and `list_stock_movements` delivered branch (one movement per delivered line — verified → 2 rows). Aggregators now count **distinct deliveries** for order totals while summing per-line units. OpsDashboard/Movements need no mobile change (render what the view/RPC return). |

**Phase 3d (mobile) is COMPLETE.** Remaining for full Feature A:
- **Phase 4 (contract)** — after the new bundle has soaked ~1–2 weeks post-cutover: drop the legacy `deliveries.product_catalog_id`/`quantity_ordered`/`quantity_delivered` columns, remove the dead single-product code in `bot-parse-message`, retire the generic "Perfume" SKU, final `gen:types` + `eas update`.
- ✅ **Phase 3b** — done + verified + **applied to prod** (see row above).
- ✅ **Phase 3c** — done + deno-check clean (see row above). Cutover runbook: `scripts/multi-product-03-cutover-runbook.md`.
- **Phase 3d** — mobile surfaces (services + create/edit/mark-delivered/list/detail). Type-checkable, not DB-verifiable. **← next**
- **Phase 4** — contract: drop legacy columns, retire generic "Perfume", final `gen:types`.

## 11b. Production cutover + go-live verification (2026-06-16)

The full cutover was executed: Phase 3b/3d SQL applied in Supabase, the three edge
functions deployed (`bot-parse-message`, `send-assignment-push`, `send-notification`),
mobile bundle pushed to the `preview` channel, `enable_bot_pipeline=true` /
`bot_shadow_mode=false`. Multi-product intake + app surfaces are live in prod.

Go-live verification (driving simulated contractor payloads through the **real**
pipeline, assigned to the **Test Agent** `a181dfa2-…`) surfaced **two production
incidents** that the initial "cutover healthy" check missed. Both fixed.

### Incident 1 — bot intake was DOWN since the cutover deploy (webhook 401)
- **Symptom:** every inbound message after the deploy stuck in `bot_inbound_messages.status='queued'`; last successful parse was 19:39, deploy ~19:40. No order *lost* only because the evening was quiet.
- **Root cause:** the cutover added the `denyIfNotInternal` gate (from `_shared/internal-auth.ts`) to `bot-parse-message`, but the `bot_parse_on_insert` DB webhook still authenticated with a **stale service-role JWT** that matched neither branch of the gate (`INTERNAL_FUNCTION_SECRET` was **never set** in this project, and the embedded JWT ≠ the function's `SUPABASE_SERVICE_ROLE_KEY`). So the webhook 401'd on every call. Function-to-function calls kept working only because the supabase-js client auto-attaches the *current* service-role bearer; the hard-coded trigger was the one caller that didn't.
- **Fix:** `scripts/fix-bot-webhook-internal-secret.sql` — recreate the trigger to send an `x-internal-secret` header; user **created `INTERNAL_FUNCTION_SECRET`** in Edge Function secrets (it didn't exist before). Verified: re-fired test rows → `created_delivery` in ~4s.
- **Blast radius:** only `bot_parse_on_insert → bot-parse-message`. `scheduled-eod-check` is ungated (fine); notifications authenticate via the service-role bearer (fine). The **`mybot-*` study trigger + cron still carry the stale bearer** — non-prod (0 rows), fix later if those comparisons are rerun. **Contractor unaffected** — they POST to `inbound-message` with `BOT_INBOUND_SECRET` (a different door), still 200/stored.

### End-to-end intake proof (`scripts/test-multiproduct-intake.sql`)
Simulated the contractor by inserting the same `raw_payload` envelope `inbound-message`
stores, letting the real webhook fire. Results:
- **3-item bundle** → ONE delivery, 3 `delivery_items` (**Khamrah Dukhan ×2, Opulent Oud ×1, Perfume Oil ×1**), client Original Buy, agent **Test Agent** (agent-hint resolved), location **Agege** (location-hint high-confidence, skipped Maps).
- **Single-product** (Oud Al Layl ×1) → one line item (back-compat intact).
- **Golden invariant CONFIRMED live:** both deliveries show identical **₦6,000 charge / ₦4,000 agent pay** (Agege per-delivery rate) despite 3 products/4 units vs 1 product/1 unit. Fee is per-delivery, never ×qty, never ×product.

### Incident 2 — Feature A mobile bundle wasn't reaching the phone (OTA)
- **Symptom:** preview build (v1.1.1 · `019ed1e1`) reported "up to date" but kept running the pre-Feature-A bundle.
- **Root cause (two layers):** (a) the `preview` **channel was not linked** to the `preview` **branch**; (b) a **"rollback preview to pre-WIP state"** update was suppressing Feature A even after linking — the EAS manifest endpoint (channel=preview, runtime=1.1.1, android) was serving update `019ed1e1` (the rolled-back pre-WIP state), exactly the phone's hash. Build/runtime/channel were otherwise all correct (all preview, runtime 1.1.1).
- **Fix:** `eas channel:edit preview --branch preview`, then **republished Feature A over the rollback** (`eas update --branch preview --message "Feature A: multi-product (republish over rollback)"` — HEAD `33f13d0`, the real Feature A bundle). Phone pulls it on the next 2 full relaunches.
- **Note on blast radius:** the `preview` channel is what **real agents** run on, so the republish reaches them — which is correct, since the DB is already multi-product and stale-bundle agents are otherwise blocked by the `multi_item_needs_app_update` safety guard on multi-item orders.

### Stock seed for the mark-delivered test (`scripts/test-seed-test-agent-stock.sql`)
Test Agent granted **5 each** of Khamrah Dukhan / Opulent Oud / Perfume Oil / Oud Al Layl
via positive `stock_adjustments` (reason `bulk_intake`), so the bundle can be marked
delivered per-item (needs 2/1/1) and the single (needs 1).

### Still open (loop NOT complete)
- [ ] **Confirm on the phone** the multi-product UI renders (Detail itemizes 3 lines) after the republish.
- [ ] **Per-item mark-delivered E2E** as Test Agent → verify stock decrements per-SKU (expect Khamrah 3 / Opulent 4 / Perfume Oil 4 / Oud Al Layl 5).
- [ ] **Make the webhook fix permanent** — commit `scripts/fix-bot-webhook-internal-secret.sql` + the test scripts; ensure any future redeploy that touches auth also updates the trigger (the gate and the webhook credential must stay in sync).
- [ ] **Update the PRD** (`reda_prd.md` §5.5 + data-model) for Feature A + the webhook→`x-internal-secret` requirement.
- [ ] **Clean up** the 2 test deliveries + test seed when verification is done.
- [ ] **Phase 4 (contract)** — after ~1–2 week soak.

## 11. Recommended first move

Phases 0–1 are pure-additive and **cannot break production** (nothing reads the new table). They also stand up the parity baseline early, so the gate is provable before any risky flip.

**Next step:** once the SKU list (open item #1) is settled, draft `scripts/multi-product-00-catalog-seed.sql` and `scripts/multi-product-01-schema.sql` (table + `items_fingerprint` + backfill + parity baseline), to be pasted into the Supabase SQL editor.
