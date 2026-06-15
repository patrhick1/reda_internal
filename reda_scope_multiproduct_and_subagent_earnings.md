# Reda — Scope of Work & Use-Case Design

**Two features:** (A) Multi-product orders (one delivery, several products) · (B) Sub-agent earnings privacy + team-lead earnings view.

**Prepared for:** Uzo · **Status:** proposal for sign-off · **Date:** 2026-06-13

> This is the client-facing scope. The deep technical migration detail lives in
> [reda_multi_product_migration_plan.md](reda_multi_product_migration_plan.md); the earnings-privacy
> policy origin is [reda_prd.md §5.13](reda_prd.md). Decisions confirmed on 2026-06-13 are baked in below
> and, where they change an earlier write-up, flagged **[updated]**.

---

## 1. At a glance

| Feature | What changes for you | Headline |
|---|---|---|
| **A. Multi-product orders** | One delivery can hold several products (real SKUs), instead of being forced into one generic "Perfume" line. Stock finally reflects what each rider actually holds. | Fixes inventory fiction. **Fees, remit and reconciliation are untouched.** |
| **B. Sub-agent earnings** | A rider on a team lead's roster sees **no money** on their app; the value is hidden at the server, not just on screen. The **team lead gets a dashboard** of each of her riders' deliveries + earnings to run her own payouts. | Protects the lead's pay arrangement and closes a quiet data leak. |

Both are independently shippable. Recommended order and combined pricing in §4.

---

## 2. Feature A — Multi-product orders

### 2.1 The problem today
A Reda delivery is **strictly one product + one quantity**. Real orders aren't — perfume bundles like
`2 Opulent Oud + 2 Khamrah Dukhan + 4 perfume oil + 4 atomizer` arrive constantly. The system copes by
**collapsing every bundle into one generic "Perfume" product** with a meaningless quantity (507 of 764 such
orders are recorded as qty = 1 despite holding 5–12 physical pieces).

The real damage is **stock**: inventory is booked against the junk "Perfume" SKU, so on-hand counts are
fiction — you can't tell how many Opulent Oud bottles vs atomizers a rider is holding, and every drop
under-counts what left the shelf. **Money is *not* affected** — Reda's charge and the agent's pay are
per-delivery by location, never × quantity, never per product — which is exactly what makes this safe to fix.

### 2.2 Use cases

- **WhatsApp intake (the main win).** A bundle message parses into **one delivery with several line items**,
  each matched to a **real SKU**. The multi-product reading logic already exists in the study bot
  (`mybot-parse-message`) and is ported into the live pipeline. Any line that can't be confidently matched
  routes to **Needs Review** — never silently collapsed into a junk product again.
- **Create / edit (admin + dispatcher).** The product picker becomes an **add/remove list of line-item rows**
  (product + quantity per row). Per-line stock shortfall is shown as you build the order.
- **Mark delivered (agent).** The rider sees each line and confirms **quantity delivered per line** (so the
  existing "delivered fewer than ordered / leftover" behaviour survives per product). The delivery still
  resolves **as a whole** — one status, one fee, one payment.
- **Stock.** Decrements the **real SKU per line**. *My Stock* shows true per-product holdings.
- **Reporting.** Unchanged — see §2.4.

### 2.3 What's included
- New `delivery_items` table (one delivery → many product lines).
- Order creation, editing, mark-delivered, and end-of-day rollover all understand line items
  (rollover always moves the **whole** order together — never splits products).
- Live bot intake extracts the product list itself and matches each line to a real SKU; unmatched → Needs Review.
- Real perfume SKUs seeded for *Original Buy* (replacing the generic "Perfume" bucket).
- Mobile screens updated end-to-end: create, edit, detail, list summary, mark-delivered, Needs Review.
- One-time data backfill of every existing order into a single line item, with a **stock-parity guarantee**
  (on-hand numbers are byte-identical before and after).

### 2.4 What stays exactly the same — *the reassurance*
**[updated — price model confirmed 2026-06-13]** The customer-facing price stays a **single order total on the
delivery**. Line items may optionally carry a per-line price for record-keeping, but **that never feeds any
fee math**. Therefore:
- Reda's charge per delivery — **unchanged**.
- Agent pay per delivery — **unchanged**.
- Remit ("collected − you keep"), client reconciliation, agent earnings — **unchanged numbers**, asserted
  identical pre/post for a fixed date range before we finish.

### 2.5 Out of scope (priced separately if wanted later)
- **Per-item independent outcome** — delivering product A while failing product B on the *same* order. v1 is
  all-or-nothing: the order has one status. (Per-line *quantity* still varies; per-line *status* does not.)
- **Web UI** for multi-product (mobile-first now; the web/laptop screens are a fast-follow).
- **Product-level reporting / reconciliation** (reporting stays per-delivery).
- Asking the contractor to change their bot — we self-extract, so there's **no external dependency**.

### 2.6 How we deliver it safely — *no multi-day downtime*
We use an **expand → contract** rollout: add the new structure alongside the old, run both in parallel, flip
reads over, then remove the old. The app **never goes offline**. The only interruption is **a few
flag-gated minutes** during the intake cutover, when new-order parsing is paused — inbound WhatsApp messages
**queue and replay**, so nothing is lost — while riders keep using the app normally throughout. Full phase
plan: [reda_multi_product_migration_plan.md](reda_multi_product_migration_plan.md).

### 2.7 Effort & price
Hand-coded equivalent ≈ **60–90 hrs**; priced fixed on value/scope, not hours. The proven extraction logic
and the untouched fee model keep this at the lower-risk end.

> **Fixed price: ₦700k–₦1.1M (target ~₦900k).**

---

## 3. Feature B — Sub-agent earnings privacy + team-lead view

### 3.1 The problem today
Some riders work **under a team lead** (the canonical case is **Iya Ayo** with three riders — Mr Austin,
Funke, Jerry). You pay **the lead** a single agreed amount for the team's combined output, and she distributes
to each rider on her own terms. Today the app would show each of those riders exactly what every delivery
earned — which creates a leakage incentive ("the app says ₦4,000 but Iya Ayo paid me ₦3,000") and undermines
the lead's arrangement. The policy to hide this was written down but **not built**, and the only spec was a
screen-level hide that a technically-minded rider could see straight through.

### 3.2 Use cases

- **Sub-agent (a rider on a lead's roster).** Every monetary surface on their app is **blank**: no
  this-week / today / month totals, no remit card, no per-delivery `+₦`, no "You earned ₦X" on a delivered
  row. In their place, a single line: *"Your lead handles your payment. Speak to them about your earnings."*
  They still do everything else — see the order, deliver it, and enter what the customer actually paid
  (because the customer really does hand money to them). They just never see the slice attributed to **their
  own pay**.
- **[updated — server-enforced, confirmed 2026-06-13].** The hide is enforced **at the server**, not just on
  screen: a sub-agent's pay figure **never leaves the database** to their device, and the earnings summary
  refuses to return their own numbers to them. This closes the leak properly — inspecting the app traffic
  reveals nothing.
- **[updated — team-lead rollup included, confirmed 2026-06-13].** The lead gets a new **Team earnings**
  view: for each of her active riders, their deliveries and earnings for the period, so she can drive her own
  payouts **inside the app** instead of reconstructing it on WhatsApp. She continues to see **her own**
  earnings normally (she is not a sub-agent herself).
- **Admin / dispatcher.** Unchanged — the reconciliation screens keep showing **every** rider (lead and subs)
  as separate rows for audit and remit collection. The privacy change is strictly about a sub-agent's view of
  *their own* app.

### 3.3 What's included
- Server-side enforcement so a sub-agent's earnings are **unreadable**, not merely hidden (the delivery feed
  blanks the pay figure for sub-agents; the earnings summary declines for a sub asking about themselves).
- Mobile: the sub-agent earnings tab becomes the one-line note; the delivered-row "You earned" callout is
  removed; stock and the rest of the app are unchanged (stock isn't money).
- A new **team-lead earnings dashboard** (mobile screen + a gated server function that returns a lead's *own*
  riders' figures — and only hers).
- The lead's existing **Hand off to sub-agent** flow is unchanged.

### 3.4 Out of scope
- Differential per-agent **bonuses** between a lead and her subs. (There's a known edge — moving a row
  between a lead and a sub does not re-snapshot pay — but it is harmless while bonuses are zero, which they are
  today. Called out so it's on record; fixing it is only needed if you introduce differential bonuses.)
- Any change to admin/dispatcher reconciliation (it already shows everyone correctly).

### 3.5 Effort & price
Smaller than Feature A. The server-side privacy gate is modest; the team-lead dashboard (new screen + gated
data function + tests) is the bulk. Estimate provided fresh for this scope (not from a prior doc).

> **Estimated fixed price: ₦300k–₦500k (target ~₦400k).** Refine on sign-off.

---

## 4. Combined pricing & recommended sequencing

| Item | Price band | Target |
|---|---|---|
| A — Multi-product orders | ₦700k – ₦1.1M | ~₦900k |
| B — Sub-agent earnings + lead view | ₦300k – ₦500k | ~₦400k |
| **Both** | **₦1.0M – ₦1.6M** | **~₦1.3M** |

**Recommended order: ship B first, then A.** B is smaller, lower-risk, needs no data migration, and the
earnings leak is live today — it's a quick, self-contained win. A is the larger migration and benefits from
being scheduled deliberately around the few-minute intake cutover.

---

## 5. Assumptions baked in (flag any you disagree with)

These are low-stakes calls already assumed in the detailed plans — listed so nothing is a surprise:

1. **Multi-product is all-or-nothing per order** — one status and one fee for the whole order; per-line
   *quantity delivered* can still vary (leftover/upsell), but you don't deliver one product and fail another
   on the same order in v1.
2. **A multi-client bundle goes to Needs Review** — if one message's products resolve to *different* vendors,
   it's flagged for a human rather than guessed.
3. **Rollover moves the whole order** to one next-day child — never split per product.
4. **The lead's Team-earnings view covers her direct active riders only**, for the same Lagos work-week the
   rest of earnings already uses.
5. **The generic "Perfume" SKU stays alive** until its historical orders are migrated, then is retired — no
   history is rewritten.

---

## 6. Net effect on the existing docs (for the build)

- **PRD §5.13** changes from *UI-only, lead-rollup-deferred* to **server-enforced, lead-rollup-included**.
  The PRD will be updated to match on build.
- The two multi-product docs are reconciled: the **migration plan** is the source of truth for *how*; the old
  `multi_product_delivery_scope.md` price/scope is carried here with the **one-order-total** price model
  confirmed (superseding its "per-line subtotal" line).
