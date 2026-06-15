# Reda — Scope of Work & Use-Case Design

**Three features:** (A) Multi-product orders (one delivery, several products) · (B) Sub-agent earnings privacy + team-lead earnings view · (C) Founding-agents pricing (per-group agent pay by location).

**Prepared for:** Uzo · **Status:** proposal for sign-off · **Date:** 2026-06-13

> This is the client-facing scope. The deep technical migration detail for (A) lives in
> [reda_multi_product_migration_plan.md](reda_multi_product_migration_plan.md); the earnings-privacy
> policy origin is [reda_prd.md §5.13](reda_prd.md). Decisions confirmed on 2026-06-13 are baked in below
> and, where they change an earlier write-up, flagged **[updated]**.
>
> **Pricing note:** the figures below are **non-premium / family rates**, set deliberately under the
> value-based number. They're a starting point — tune any line to whatever feels right.

---

## 1. At a glance

| Feature | What changes for you | Headline |
|---|---|---|
| **A. Multi-product orders** | One delivery can hold several products (real SKUs), instead of being forced into one generic "Perfume" line. Stock finally reflects what each rider actually holds. | Fixes inventory fiction. **Fees, remit and reconciliation are untouched.** |
| **B. Sub-agent earnings** | A rider on a team lead's roster sees **no money** on their app; the value is hidden at the server, not just on screen. The **team lead gets a dashboard** of each of her riders' deliveries + earnings to run her own payouts. | Protects the lead's pay arrangement and closes a quiet data leak. |
| **C. Founding-agents pricing** | A small set of agents (the "Founding agents") can earn a **different per-location rate** than the standard one; everyone else stays on the default. | Expresses a real pay arrangement the rate card can't hold today. |

All three are independently shippable. Recommended order and combined pricing in §5.

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
- **Contractor data + our AI (the merge).** The contractor's bot keeps running unchanged — we **keep the
  fields it's good at** (customer name, phone, address, and the location/agent hints) and run **our own AI on
  the raw message text** to pull out the **full product list + per-line quantities** (the contractor only ever
  sends one product). The two are stitched into one delivery: contractor for the *envelope*, our model for the
  *line items*. *(Today the pipeline skips our AI whenever the contractor's parse looks "complete" — that
  shortcut is removed for the product list, so a multi-line order is always read in full.)*
- **Create / edit (admin + dispatcher).** The product picker becomes an **add/remove list of line-item rows**,
  **each row carrying its own quantity** (product + quantity per line — so `2 Opulent Oud + 4 atomizer` is two
  lines, qty 2 and qty 4). Per-line stock shortfall is shown as you build the order.
- **Mark delivered (agent).** The rider sees each line and confirms **quantity delivered per line** (so the
  existing "delivered fewer than ordered / leftover" behaviour survives per product). The delivery still
  resolves **as a whole** — one status, one fee, one payment.
- **Stock.** Decrements the **real SKU per line**. *My Stock* shows true per-product holdings.
- **Reporting.** Unchanged — see §2.4.

### 2.3 What's included
- New `delivery_items` table (one delivery → many product lines).
- Order creation, editing, mark-delivered, and end-of-day rollover all understand line items
  (rollover always moves the **whole** order together — never splits products).
- **Live bot intake reworked**: extract the product list from the raw message (our AI), merge with the
  contractor's envelope fields, match each line to a real SKU, and store the line items on the new create
  path; any unmatched line, or lines that resolve to different vendors → Needs Review.
- **Duplicate / sibling / rollover detection re-keyed** off the *set of products* (an order's "fingerprint")
  instead of the single product, so multi-item repeats are still caught and EOD rollover doesn't fragment.
- **Stock checks loop per product line** at create, auto-assign, and mark-delivered.
- **Assignment & status push notifications updated** to summarise multiple products and compute stock
  shortfall **per line** (today they show one "Product × Qty" and check one product).
- Real perfume SKUs seeded for *Original Buy* (replacing the generic "Perfume" bucket).
- Mobile screens updated end-to-end: create, edit, detail, list summary, mark-delivered, Needs Review,
  plus the available-orders / warehouse-planning aggregations (now per line).
- One-time data backfill of every existing order into a single line item, with a **stock-parity guarantee**
  (on-hand numbers are byte-identical before and after).

### 2.4 What stays exactly the same — *the reassurance*
**[updated — price model confirmed 2026-06-13]** The customer-facing price stays a **single order total on the
delivery**. Line items may optionally carry a per-line price for record-keeping, but **that never feeds any
fee math**. Therefore:
- Reda's charge per delivery — **unchanged**.
- Agent pay per delivery — **unchanged** (subject only to Feature C, below, which changes *which rate* an
  agent is on — never how many times it's counted).
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

### 2.7 Price
Priced fixed on value/scope, at a non-premium rate. The proven extraction logic (already working in the
study bot) and the untouched fee model keep the risk low.

> **₦450k.**

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
- **Admin / dispatcher.** Unchanged on the *detail* side — the reconciliation screens keep showing **every**
  rider as separate rows for audit. **Payout** rolls up: Reda pays the **lead** the combined total for her +
  her riders (she settles her riders herself) — see §3.4.

### 3.3 What's included
- Server-side enforcement so a sub-agent's earnings are **unreadable**, not merely hidden (the delivery feed
  blanks the pay figure for sub-agents; the earnings summary declines for a sub asking about themselves).
- Mobile: the sub-agent earnings tab becomes the one-line note; the delivered-row "You earned" callout is
  removed; stock and the rest of the app are unchanged (stock isn't money).
- A new **team-lead earnings dashboard** (mobile screen + a gated server function that returns a lead's *own*
  riders' figures — and only hers).
- The lead's existing **Hand off to sub-agent** flow is unchanged.

### 3.4 Payout rollup (how Reda settles a team)
A sub-agent's delivery earnings are **owed by Reda to the lead**, not to the sub directly — Reda pays the lead
for her *and* her team's deliveries, and the lead pays each rider herself. So on the **payout / remit** side,
a sub-agent's earnings **roll up into the lead's total**. Admin can still see per-rider detail for audit; the
money goes to the lead. (This is the same arrangement that drives sub-agent pricing in Feature C.)

### 3.5 Out of scope
- Differential per-agent **bonuses** between a lead and her subs (the per-agent flat bonus is being retired;
  Feature C is the real per-rate mechanism).
- Any change to how admin sees per-rider detail (it already shows everyone correctly).

### 3.6 Price
Smaller in scope than A. **Tightly coupled to Feature C** (both run on the same sub-agent / team-lead
plumbing) — best built together.

> **₦200k.**

---

## 4. Feature C — Founding-agents pricing (per-group agent pay by location)

### 4.1 The need
A handful of agents — the **Founding agents** — are on a different pay arrangement: at some locations they
earn **more per delivery** than the standard rate. Today the rate card holds **one rate per location for
everyone**, so there's no clean way to express this — it would mean hand-editing individual deliveries, which
doesn't scale and isn't auditable. **For now there is exactly one group (Founding agents), a few agents;
everyone else stays on the default per-location rates.** The design supports more groups later at no extra
cost, but we seed one.

### 4.2 How it works
- An agent can be marked a **Founding agent** (a named pay **group**).
- You set the Founding-agent pay **only at the locations where it differs**; everywhere else it **falls back
  to the default location rate** automatically — no need to fill every cell.
- When a Founding agent is assigned a delivery, the pay snapshot uses the **Founding rate**; everyone else
  uses the default. **Reda's charge to the customer never changes** — only *agent pay* varies by group.
- A rare **one-off per-agent override** is available for the odd exception on top of the group.

### 4.3 Sub-agents inherit their lead's rate
Because Reda pays a **team lead** for her *and* her riders' deliveries (Feature B), a **sub-agent is priced as
their lead**: if Iya Ayo is a Founding agent, a delivery done by Mr Austin earns at **Iya Ayo's** Founding
rate, that money is owed by Reda **to Iya Ayo**, Austin sees nothing (Feature B), and Iya Ayo pays Austin
herself. A team lead is otherwise **priced like any other agent** — on whatever group she's on. This is why
B and C ship together.

### 4.4 Use cases
- **Admin** marks an agent as a Founding agent and enters the Founding pay for the locations that differ.
- **Founding agent delivers** → earns the Founding rate for that location (or the default where none is set).
- **Standard agent delivers** → earns the default location rate, exactly as today.
- **Sub-agent of a Founding lead delivers** → earns the lead's Founding rate; it rolls up to the lead.

### 4.5 What's included
- A rate-group concept seeded with **one** group (Founding agents); agent → group membership on the user
  record (admin-set).
- A **sparse per-(group, location) agent-pay override**, with automatic fall-back to the default location
  rate; plus an optional **per-agent override** for exceptions.
- Pricing resolution updated everywhere a delivery's pay is stamped, including the **sub-agent → lead**
  inheritance above.
- The **re-snapshot cleanup** (§4.7).
- Admin UI: mark an agent's group; enter group rates on the rate-card screen.

### 4.6 What stays the same
- **Reda's charge to the customer** — unchanged (charged stays per-location; only agent pay gets the group
  dimension).
- **Reconciliation math** — still sums per-delivery snapshots; no new multiply, no per-product pay.
- **Historical delivered orders** — frozen; never retro-repriced. Only new/in-flight deliveries use the new
  rates.

### 4.7 The cleanup it forces (worth knowing)
Several reassignment paths today **don't re-stamp agent pay** when a delivery moves between agents. That's
harmless *now* because no agent has a special rate — but the moment Founding rates exist, moving a delivery
between a Founding and a standard agent must re-price. This feature closes that gap on **bulk reassign**,
**post-rollover reassignment**, and the **edit-screen agent change**. (A **lead → sub handoff correctly keeps
the lead's rate** — same principal — so that path needs no change.)

### 4.8 Out of scope
- More than one pay group (architecture supports it; we seed Founding agents only).
- Per-group variation of **Reda's customer charge** (only agent pay varies by group).
- Group rates varying by **product** (pay stays per-delivery, per-location).

### 4.9 Price
Most of the work is the pricing-resolution update + the re-snapshot cleanup (needed regardless of group
count); the one-group admin UI is light.

> **₦250k.**

---

## 5. Pricing & recommended sequencing

**Non-premium / family rates** — set under the value figure on purpose. Tune any line freely.

| Item | Price |
|---|---|
| A — Multi-product orders | ₦450k |
| B — Sub-agent earnings + team-lead view | ₦200k |
| C — Founding-agents pricing | ₦250k |
| **All three (bundle)** | **₦800k** |

**Recommended order: B + C together, then A.**
- **B + C** share the same sub-agent / team-lead plumbing (sub-agents priced at and rolled up to their lead),
  carry **no data migration**, and the earnings leak is live today — a contained first ship.
- **A** is the larger migration; best scheduled deliberately around its few-minute intake cutover.

---

## 6. Assumptions baked in (flag any you disagree with)

These are low-stakes calls already assumed in the detailed plans — listed so nothing is a surprise:

1. **Multi-product is all-or-nothing per order** — one status and one fee for the whole order; per-line
   *quantity delivered* can still vary (leftover/upsell), but you don't deliver one product and fail another
   on the same order in v1.
2. **A multi-client bundle goes to Needs Review** — if one message's products resolve to *different* vendors,
   it's flagged for a human rather than guessed.
3. **Rollover moves the whole order** to one next-day child — never split per product.
4. **One pay group for now (Founding agents), a handful of agents; everyone else default** — more groups are
   supported but not seeded.
5. **A sub-agent is priced at their lead's rate**, and a sub-agent's earnings **roll up to the lead** for
   Reda's payout (the lead settles her riders herself).
6. **Reda's customer charge never varies by agent/group** — only agent pay does.
7. **One group per agent**; the team lead is priced like any other agent, on her own group.
8. **The generic "Perfume" SKU stays alive** until its historical orders are migrated, then is retired — no
   history is rewritten.

---

## 7. Net effect on the existing docs (for the build)

- **PRD §5.13** changes from *UI-only, lead-rollup-deferred* to **server-enforced, lead-rollup-included**, and
  gains the **payout-rollup** note. The PRD will be updated to match on build.
- **A new pricing section** (rate groups + sub-agent inheritance + the re-snapshot cleanup) will be added to
  the PRD / system design on build; the `rate_card` table itself is **untouched** (groups are an additive
  override + fall-back).
- The two multi-product docs are reconciled: the **migration plan** is the source of truth for *how*; the old
  `multi_product_delivery_scope.md` price/scope is carried here with the **one-order-total** price model
  confirmed (superseding its "per-line subtotal" line).
