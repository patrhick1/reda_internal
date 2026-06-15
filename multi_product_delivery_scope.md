# Multi-Product Delivery — Feature Scope (MVP)

**Goal:** Let one delivery hold **multiple products** (line items), instead of exactly one as today.
Includes editing the **bot inbound extraction** so multi-product WhatsApp orders parse into one
delivery with several items.

**Status:** scoped 2026-06-10, grounded in the actual codebase. Not yet started.

> **[Updated 2026-06-13]** Consolidated, client-facing scope now lives in
> [reda_scope_multiproduct_and_subagent_earnings.md](reda_scope_multiproduct_and_subagent_earnings.md);
> the rigorous migration detail is in [reda_multi_product_migration_plan.md](reda_multi_product_migration_plan.md).
> **Price model resolved:** the customer-facing total stays a **single order total on `deliveries.customer_price`**;
> `delivery_items.customer_price` is **optional per-line, record-fidelity only, and never feeds fees** — this
> supersedes the earlier "per-line subtotal / move customer_price onto items" wording below.

---

## Decisions locked (MVP)

| Lever | Decision | Effect |
|---|---|---|
| Per-item partial delivery | **No — all-or-nothing** | A delivery resolves as a whole; no per-item status. Simpler delivered flow + UI. |
| Platforms | **Mobile-first** | Build on mobile now; web (Uzo's laptop) is a fast-follow / phase 2. |
| Reporting | **Per-delivery only** | Fees stay per-delivery, so remit/earnings reports are **unchanged**. No new reports. |

---

## Key findings (why this is buildable at MVP cost)

1. **The hard part is already done in the study bot.** `supabase/functions/mybot-parse-message`
   already extracts a **`products: LineItem[]`** array (prompt + strict schema), matches **per line**,
   and runs a **cross-line client-conflict check**. The production contractor pipeline
   (`bot-parse-message`) is still single-product. So multi-product extraction is largely a **port of
   proven logic**, not net-new R&D — the biggest risk item is mostly retired.
2. **Fees do not change.** `charged_snapshot`, `agent_payment_snapshot`, `cash_pos_fee_snapshot` are
   **per-delivery** (keyed on location+client+agent via `effective_rate`), never per-product/per-unit.
   → **Reconciliation, remit, and earnings logic stay untouched.** Major risk + work removed.
3. **Idempotency still holds.** A multi-product order is still **one delivery created in one
   `create_delivery` call** (with an items array). The `client_uuid` idempotency key remains 1:1 with
   a delivery — no redesign needed.
4. **Contractor pre-parse stays single-product.** We can't ask the contractor to change their bot, so
   their `raw_payload.parsed` block keeps sending one product. Multi-product therefore leans on the
   **LLM array extraction from `raw_text`** (the mybot approach). The contractor's parsed block is
   used as a hint/first-line; the LLM supplies the full item list.
5. **Writes are RPC-only.** Base-table writes are revoked; all mutations go through SECURITY DEFINER
   RPCs. So the surface to change is well-defined (the RPCs below), not scattered client inserts.

---

## Architecture

**New child table `delivery_items`** (1 delivery → many items):

```
delivery_items (
  id                 uuid pk default gen_random_uuid(),
  delivery_id        uuid not null references deliveries(id) on delete cascade,
  product_catalog_id uuid not null references product_catalog(id),
  quantity_ordered   integer not null check (quantity_ordered > 0),
  quantity_delivered integer,            -- set at delivered; all-or-nothing at the delivery level
  customer_price     numeric,            -- OPTIONAL per-line price, record-fidelity only; never feeds fees.
                                         -- The order total stays on deliveries.customer_price.
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
)
-- index on (delivery_id); index on (product_catalog_id)
```

**Moves OFF `deliveries` → onto `delivery_items`:** `product_catalog_id`, `quantity_ordered`,
`quantity_delivered`.

**Stays ON `deliveries` (per-delivery):** `customer_price` (the single order total), `paid`,
`payment_method`, `charged_snapshot`, `agent_payment_snapshot`, `cash_pos_fee_snapshot`,
`current_status`, location/agent/client, dates, audit. Customer pays once for the whole delivery;
one fee snapshot per delivery. (`delivery_items.customer_price` is an optional per-line figure for
record fidelity only — it never feeds fees or the order total.)

---

## Work breakdown

### A. Database (RPCs + views + schema)
- [ ] Create `delivery_items` table + indexes + RLS (SELECT for the same roles that can read the
      parent; writes only via RPCs).
- [ ] **`create_delivery`** → accept an **items array** (`[{product_catalog_id, quantity_ordered,
      customer_price?}]`, per-line price optional) alongside the delivery-level `customer_price` order
      total. Validate each item belongs to the client; **stock guard loops every
      (agent, product)**. Insert delivery + N `delivery_items`. Keep `client_uuid` idempotency.
- [ ] **`change_delivery_status`** delivered branch → set `quantity_delivered` **per item** (default
      = ordered; preserve the upsell/leftover mechanic per line), **decrement stock per item**, and
      run the **insufficient-stock guard per item**. `paid`/`payment_method`/fee snapshot stay
      per-delivery (unchanged).
- [ ] **`update_delivery_fields`** → add/remove/edit items on a pre-terminal delivery (the edit-lock
      and pre-terminal gate already exist; extend to item rows).
- [ ] **Views** `deliveries_admin` / `deliveries_safe` → expose items, e.g. an aggregated
      `items` JSON (product_name + qty + price per line) via a LATERAL join to
      `delivery_items` + `product_catalog`, plus a convenience `item_count` / `products_summary`.
- [ ] Confirm `effective_rate` / remit / earnings untouched (they are — per-delivery).

### B. Bot intake (port mybot's multi-product logic into production)
- [ ] `bot-parse-message/index.ts` → swap the single-product extraction **schema + prompt** for the
      **array version already in `mybot-parse-message`**; reuse its **per-line matching loop** and
      **client-conflict check**.
- [ ] `needs_review` logic → route to review if **any** line is low-confidence, ambiguous, or the
      lines resolve to **different clients** (conflict).
- [ ] `parse_result` jsonb → store `products[]` + per-line matches (mybot shape).
- [ ] **`bot_create_delivery`** → accept items array; call the new `create_delivery` once → one
      delivery + N items.
- [ ] Keep contractor `parsed` (single) as a hint; multi comes from LLM on `raw_text`.

### C. Mobile (mobile-first)
- [ ] `DeliveryFieldsForm.tsx` → product picker becomes **repeatable line items** (add/remove rows;
      each row = product + qty + price); form state `items: LineItem[]`.
- [ ] `New.tsx`, `Edit.tsx` → items-array state; pre-flight dup check keyed on the set.
- [ ] `Detail.tsx` → **loop items**, show per-line qty/price + a delivery total.
- [ ] `MarkDeliveredSheet.tsx` → **loop items**, qty-delivered input per line (default = ordered),
      single `paid`/`payment_method`; per-line stock display.
- [ ] `List.tsx` row → summarise ("Product A · +2 more").
- [ ] `NeedsReviewScreen.tsx` / `InboundDetailScreen.tsx` → render the `products[]` array; confirm →
      create delivery with items.
- [ ] `services/deliveries.ts` (`createDelivery`, `updateDeliveryFields`, `changeDeliveryStatus`),
      `queue/executors.ts` + `queue/types.ts` → array payloads.
- [ ] Regenerate `types/database.gen.ts`.

### D. Data migration
- [ ] One-time backfill: every existing delivery → **one** `delivery_items` row
      (`product_catalog_id`, `quantity_ordered`, `quantity_delivered`, `customer_price`).
- [ ] After backfill verified, drop/deprecate the moved columns on `deliveries` (single source of
      truth = items).

### E. Testing
- [ ] Bot parse on real multi-product contractor messages (use mybot's captured study data).
- [ ] Mixed-confidence + client-conflict → needs_review.
- [ ] create → deliver (multi-item) → stock decrements per item; insufficient-stock per item.
- [ ] Fee snapshot still per-delivery (one charge for the whole multi-item delivery).
- [ ] Self-host dry-run (same harness as the migration dry-run).

---

## Out of scope (phase 2, priced separately)
- Per-item partial delivery / per-item status (deliver A, fail B independently).
- Web client UI for multi-product (mobile-first now).
- Product-level reporting / reconciliation (per-delivery reporting stays).
- Asking the contractor to send a multi-product `parsed` block.

---

## Risks
- **LLM extraction quality on real messages** — the one genuinely iterative area; mybot study data
  + one tuning round budgeted. Contractor text drift (typos/format) is a known issue.
- **Backfill correctness** — high-stakes one-time migration; dry-run on the self-host first, keep the
  pre-migration dump.
- **Dual source of truth during transition** — mitigate by repointing all readers to items before
  dropping the old columns.

---

## Effort & price (MVP)
- Hand-coded equivalent ~60–90 hrs; **less with an AI coding assistant**, but priced **fixed on
  value/scope**, not hours.
- **Recommended fixed price: ₦700k–₦1.1M** (target ~₦900k). The mybot head-start + unchanged fee
  model put this at the lower-risk end.
- Phase 2 (partial delivery, web, product-level reporting) quoted separately when wanted.

---

## Open questions — RESOLVED 2026-06-13
1. Per-line qty-delivered on a multi-item **delivered**: **editable per line** (preserve the
   upsell/leftover mechanic). Delivery still resolves all-or-nothing at the status/fee level.
2. Old single-product columns: **dropped after verified backfill** via the migration plan's
   expand→contract Phase 4 (retained + dual-written through the transition, then removed).
3. Lines resolving to **different clients** → **always `needs_review`** (never guessed).
4. **Customer price:** single order total on `deliveries.customer_price`; per-line price optional,
   fidelity-only (see top note).
