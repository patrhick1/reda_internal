# Reda Multi-Product Orders (Delivery Line-Items) — Migration Plan

_Goal: one order can hold multiple products, modeled properly with no shortcuts and no tech debt, migrated with no multi-day downtime._

---

## Context — why we're doing this

Today a Reda delivery is **strictly one product + one quantity**: `deliveries.product_catalog_id NOT NULL` and `deliveries.quantity_ordered NOT NULL`, with **no line-items table anywhere** in the schema. Real orders aren't shaped that way — perfume bundles like `2 OPULENT OUD + 2 KHAMRAH DUKHAN + 4 PERFUME OIL + 4 ATOMIZER` arrive constantly.

The pipeline copes by **collapsing every bundle into one generic catalog product "Perfume"** (client *Original Buy*, id `741939f8…`, carrying **764 deliveries**) with a single, essentially meaningless quantity — **507 of 764** are recorded as qty=1 despite the bundle containing 5–12 physical pieces.

The real damage is concentrated in **stock-keeping**: *Original Buy* actually books stock against the generic "Perfume" SKU (**75 adjustments, +173 net units**), so on-hand inventory is fiction — you cannot tell how many Opulent Oud bottles vs atomizers an agent is holding, and decrements under-count nearly every drop. **Fees are NOT affected**, because Reda's charge + agent pay are **per-delivery by location, never × quantity, never per product** — which is exactly what makes this migration financially safe.

**Outcome we want:** model an order as an **envelope** (customer, address, agent, status, one per-delivery fee) containing **N line-items** (product + quantity each), via a normalized `delivery_items` table, migrated with an **expand → contract (parallel-change)** strategy so the app is never down for days — at most a few flag-gated minutes during the intake cutover.

**Key enabling discovery:** `supabase/functions/mybot-parse-message/index.ts` **already** extracts a `products[]` array (schema lines 71–98, types 129–141) and per-line matches them via `match_products_by_text` (lines 495–514) — it simply never creates deliveries (it's observe-only today). The multi-product extraction logic already exists; we wire a hardened version into the real intake instead of building it from scratch.

---

## Target data model

**New table `delivery_items`** (the only new table):

```
id                  uuid pk
delivery_id         uuid not null  → deliveries(id) on delete cascade
product_catalog_id  uuid not null  → product_catalog(id) on delete restrict
quantity_ordered    int  not null  check (> 0)
quantity_delivered  int  null      check (>= 0)
customer_price      numeric(10,2) null  -- per-line price when the message itemizes it;
                                        -- the order total stays on deliveries.customer_price
created_at, updated_at
unique (delivery_id, product_catalog_id)   -- one line per product per order
index  (product_catalog_id)                -- stock aggregation
index  (delivery_id)
```

**`deliveries` (the envelope) — unchanged financially.** Keeps `client_id` (one order = one client's products), `customer_*`, `raw_address`, `location_id`, `assigned_agent_id`, status, **all fee snapshots (`charged_snapshot`, `agent_payment_snapshot`, `cash_pos_fee_snapshot`) exactly as-is — one fee per delivery**, `parent_delivery_id`, `text_fingerprint`. The legacy `product_catalog_id` / `quantity_ordered` / `quantity_delivered` columns are **retained through expand, dual-written, then dropped in contract**.

**New `deliveries.items_fingerprint`** (nullable text): a stable hash of the sorted `(product_catalog_id, quantity_ordered)` set. Replaces the single `product_catalog_id` in structural duplicate / sibling detection.

**Stock** becomes:
`current_stock = Σ stock_adjustments.quantity_delta − Σ delivery_items.quantity_delivered`,
grouped by `(deliveries.assigned_agent_id, delivery_items.product_catalog_id)` for rows where `current_status='delivered'`. Post-backfill this returns **identical numbers** to today, so the view swap is a no-op in values (and we assert that).

---

## Decisions baked in (no shortcuts) — confirm before build

1. **Self-parse line-items; don't wait on the contractor.** `bot-parse-message` will extract its own `products[]` array (reusing mybot's proven schema), and *also* honor `raw_payload.parsed.products[]` if/when the contractor emits it. A legacy single-product `parsed.product_name` is wrapped into a 1-item array as fallback. This removes the external dependency entirely. _(Recommended. The alternative — blocking on the contractor changing their bot — is not recommended.)_
2. **Fee stays strictly per-delivery.** Line-items carry an optional per-line `customer_price` for data fidelity only; they never feed fee math. No reconciliation total changes.
3. **Real SKUs replace the generic "Perfume" bucket**, seeded per client (starting with *Original Buy*). Unmatched lines route to `needs_review` — never silently collapse to a junk SKU again. The generic "Perfume" product stays alive until its historical rows are migrated, then is retired.
4. **Rollover moves the whole order** (all items together to one child) — never split per product. Matches today's one-drop-one-fee semantics.

---

## Phase 0 — Catalog prep (online, no app change)

- Seed real perfume SKUs for *Original Buy* (OPULENT OUD, KHAMRAH DUKHAN, OUD AL LAYL, perfume oil, atomizer, …) in `product_catalog` via the existing admin Catalog screens. Generic "Perfume" stays active for now.
- `scripts/multi-product-00-catalog-seed.sql` (idempotent inserts).

## Phase 1 — Schema expand (additive, **zero downtime**)

`scripts/multi-product-01-schema.sql`:

- `create table delivery_items …` + indexes + checks (instant in Postgres, no table rewrite).
- `alter table deliveries add column items_fingerprint text;` (nullable add = instant).
- Add helpers `_items_fingerprint(delivery_id)` and `_delivery_items_sig(jsonb)` (for intake).
- **Backfill** every existing delivery into a 1-row `delivery_items` (copy `product_catalog_id`, `quantity_ordered`, `quantity_delivered`); set `items_fingerprint`. Runs live; the dataset is small.
- Legacy columns remain the source of truth — nothing reads `delivery_items` yet.

## Phase 2 — Dual-write RPCs (**zero downtime**, old app keeps working)

`scripts/multi-product-02-dualwrite.sql` — every writer maintains **both** shapes (live bodies in `scripts/archive/duplicate-handling-text-fingerprint.sql`, `scripts/fix-delivered-requires-location.sql`, `scripts/fix-update-delivery-fields-customer-price.sql`, `scripts/fix-eod-sibkey.sql`):

- `create_delivery` / `bot_create_delivery`: add a **new `p_items jsonb` array** param (additive, default null). When null, derive a 1-item array from the legacy `p_product_catalog_id` / `p_quantity_ordered` (old callers unaffected). Insert the delivery, then the `delivery_items` rows; keep writing the legacy columns and set `items_fingerprint`.
- `change_delivery_status` (delivered path): add optional `p_item_quantities jsonb` (`[{product_catalog_id, quantity_delivered}]`). When absent, fan the single `p_quantity_delivered` onto the lone item (back-compat). Write `delivery_items.quantity_delivered` **and** the legacy column. Stock guard loops **per item** against `current_stock(agent, item.product)`.
- `update_delivery_fields`: accept `p_items jsonb`; replace the item set transactionally; recompute `items_fingerprint`. Rate recalc unchanged (location/client/agent only).
- `rollover_delivery` + `run_eod_rollover`: copy child items from the parent; **swap the sibling/dedup key from `product_catalog_id` + `quantity_ordered` to `items_fingerprint`** in `_find_sibling_deliveries`, in `bot_create_delivery`'s dupe pre-empt, and in the EOD `sib_key`.
- `write_audit` payloads gain an `items` array alongside the legacy keys.
- `current_stock` **still reads legacy columns** this phase (no value change, lowest risk).

## Phase 3 — Flip reads to items + ship multi-item (**few-minutes flag-gated cutover**)

`scripts/multi-product-03-cutover.sql` + edge deploys + `eas update`:

- **Stock:** `create or replace view current_stock` to aggregate from `delivery_items` (atomic; identical post-backfill numbers — assert parity immediately before/after).
- **Intake cutover (the only interruption):** flip `enable_bot_pipeline` **off** (inbound rows queue in `bot_inbound_messages`, nothing lost) → deploy the updated `bot-parse-message` (extracts `products[]`, per-line `match_products_by_text`, calls `bot_create_delivery` with `p_items`; any unmatched line → `needs_review`) and the dual-write RPCs → flip `enable_bot_pipeline` **on** → queued messages drain through the multi-item path. **Agents keep using the app throughout; only new-order intake pauses for minutes.** Flags are read at `bot-parse-message/index.ts:256-261`.
  - **The contractor merge (don't lose the envelope):** today `extractContractorParse()` sets `needsLlm=false` and **skips our LLM entirely** when the contractor's `parsed` block has `product_name + raw_address + customer_phone` (`bot-parse-message/index.ts:99-113, 279-282`), then merges contractor-wins-LLM-fills at `:310-317`. The contractor only ever sends **one** product, so for multi-product we **decouple the product dimension from that gate**: always run our own extraction on `raw_text` for `products[]` (port mybot's array schema/prompt + the duplicated `pickMatch` disambiguation), while **keeping the contractor's per-delivery envelope** — `customer_name`, `customer_phone`, `raw_address`, plus the `location` and `assigned_agent` / `client_hint` hints — merged exactly as today. The contractor's single `product_name` is kept only as a first-line sanity hint. Store the new `parse_result` in mybot's shape (`extracted.products[]`, `product_matches[]`, `client_id_conflict`).
- `npm run gen:types` to surface `delivery_items` + new RPC params.
- **Mobile (`eas update --branch preview`, OTA, instant):** old JS bundles still work because dual-write maintains the legacy columns and the RPCs accept both shapes; the new bundle adds multi-item. Surfaces to change:
  - `services/deliveries.ts`: add `DeliveryItem[]` to the row type + joins; `siblingGroupKey` (lines 284–301) keys on `items_fingerprint`; create/update/changeStatus inputs carry `items` / per-item delivered.
  - **Create / Edit forms** — `screens/deliveries/DeliveryFieldsForm.tsx` (lines 16–27, 434–463), `New.tsx`, `Edit.tsx`: product picker becomes an add/remove **line-items list** (product + qty per row); per-line stock shortfall via the existing `getAgentProductStock()`.
  - **Mark-delivered (most complex UI)** — `components/sheets/MarkDeliveredSheet.tsx`, `BulkMarkDeliveredSheet.tsx`, `screens/deliveries/StatusUpdatePanel.tsx`: capture `quantity_delivered` **per item**; per-item on-hand validation.
  - **Read / list surfaces** — `Detail.tsx` (502–525), `List.tsx` (667), `components/delivery/RecentActivityCard.tsx` (91), `services/available-orders.ts` aggregation (now sums from items), `screens/stock/Movements.tsx`, `screens/ops/OpsDashboard.tsx`: render N products ("3 items" / itemized).
  - **Reconciliation** — `services/reconciliation.ts`: **verify the comment at lines 32–33 ("× quantity_delivered") does not actually multiply** — the backend `agent-remit-summary.sql` sums snapshots directly. Align mobile to per-delivery and confirm totals are unchanged.

## Phase 4 — Contract (after all clients are on the new bundle, ~1–2 weeks)

`scripts/multi-product-04-contract.sql`:

- Drop dual-write; remove the single-product fallback in `bot-parse-message`.
- Drop `deliveries.product_catalog_id` / `quantity_ordered` / `quantity_delivered` (or convert to read-only generated convenience columns). Drop `deliveries_sibling_lookup_idx` (replaced by an `items_fingerprint` / `delivery_items` index). Retire the generic "Perfume" SKU.
- Final `gen:types` + `eas update`.

---

## Critical coupling points the plan must honor (from codebase exploration)

- **Sibling / dedup** — `bot_create_delivery` dupe pre-empt; `_find_sibling_deliveries` Tier-2 (`scripts/archive/sibling-coordination.sql`); `run_eod_rollover` `sib_key`: all currently embed `product_catalog_id` (+ `quantity_ordered`). → re-key on `items_fingerprint`.
- **Stock guards** at create (`create_delivery`) and mark-delivered (`change_delivery_status`): per-`(agent, product)`. → loop per item.
- **`current_stock`** decrement uses `deliveries.quantity_delivered`. → `Σ delivery_items.quantity_delivered`.
- **Rollover** copies parent product/qty to one child. → copy the whole item set.
- **`available_orders_safe`** view + mobile `available-orders.ts` aggregate by product/qty per delivery. → aggregate from items.
- **Indexes:** `deliveries_sibling_lookup_idx (phone, product_catalog_id, date)` → re-base on `items_fingerprint`.
- **Soft-delete / terminal locks** (`delete_delivery`, post-delivered locks): `on delete cascade` from `delivery_items` keeps them coherent; delivered rows stay locked.
- **Push / notification copy + per-product shortfall** (previously un-listed): `send-assignment-push/index.ts:66,90` builds `"${productName} × ${quantity_ordered}"` from a single join; `send-notification/index.ts:196-223` (assignment) and `:358-406` (warehouse-pickup) do the same **and compute stock shortfall against one product** (`quantity_ordered − onHand`); `:233-296` (status-change) reads a single `quantity_delivered`. → all must take a **products summary** (e.g. `"Opulent Oud ×2, Atomizer ×4"` or `"3 items"`) and loop shortfall **per item**.

## Verification (end-to-end, no shortcuts)

- **Stock parity (gate):** snapshot `current_stock` for all holders *before* the Phase-3 view swap; assert byte-identical *after* (proves backfill + view correctness).
- **SQL smoke (rollback-wrapped):** create a 3-item order → 1 delivery + 3 `delivery_items`, one fee snapshot; mark-delivered with one item short → per-item `quantity_delivered` correct, `current_stock` decrements the right SKUs; a true duplicate (same items) is caught, a different item-mix is **not**.
- **Reconciliation parity (gate):** `agent_earnings_summary` / client remit totals identical pre/post for a fixed date range (fees per-delivery, unaffected).
- **Dedup / rollover:** EOD rollover on a multi-item order produces one child with the same item set; the sibling cancel-on-delivered still fires.
- **Intake replay:** queue a perfume-bundle message in shadow, confirm `products[]` extraction + per-line matches; an unmatched line → `needs_review` (never a silent collapse).
- **Preview build manual E2E:** old bundle (pre-update) and new bundle both create/mark orders successfully during dual-write; admin creates a multi-item order; agent marks partial per item; stock dashboard shows real SKUs.

## Files touched

- **New SQL:** `scripts/multi-product-0{0..4}-*.sql` (catalog seed, schema+backfill, dual-write, cutover, contract).
- **Edge:** `supabase/functions/bot-parse-message/index.ts` (extract `products[]`, per-line match, `p_items`, decouple the LLM-skip gate from the product dimension while keeping the contractor envelope merge); reuse logic from `supabase/functions/mybot-parse-message/index.ts`. **Notifications:** `supabase/functions/send-assignment-push/index.ts` + `supabase/functions/send-notification/index.ts` (multi-product summary string + per-item stock shortfall).
- **Mobile:** `services/{deliveries,available-orders,reconciliation}.ts`, `types/database.gen.ts`; `screens/deliveries/{DeliveryFieldsForm,New,Edit,Detail,List,StatusUpdatePanel}.tsx`; `components/sheets/{MarkDeliveredSheet,BulkMarkDeliveredSheet}.tsx`; `components/delivery/RecentActivityCard.tsx`; `screens/available/*`, `screens/stock/Movements.tsx`, `screens/ops/OpsDashboard.tsx`.

## Downtime summary

Phases 0–2 and 4: **zero downtime** (additive schema, dual-write, OTA updates). Phase 3: **a few flag-gated minutes** of paused *new-order intake* only (queued and replayed) — the app itself never goes offline. **No multi-day pause anywhere.**
