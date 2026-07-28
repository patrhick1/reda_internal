# Paystack Remittance for Reda — Research & Options

**Author:** investigation 2026-06-22 · **Status:** research, no code written
**Question:** How can Paystack power Reda's remittance (paying vendors, and possibly agents)?

---

## TL;DR / Recommendation

Do it in two phases, smallest-risk first:

- **Phase 1 — Automate VENDOR payouts via the Transfers API (recommended now).**
  Keep collection exactly as it is today. When Uzo settles a client-day (the
  existing `settle_period` RPC), fire a Paystack **Transfer** of the frozen
  `settlements.expected_amount` to the vendor's saved bank account. This replaces
  Uzo's manual bank-app transfers with automated, idempotent, audited payouts.
  Small surface, hooks straight into the settlement model we already have.
  Cost: **₦10–₦50 + ₦50 stamp duty per payout** — negligible.

- **Phase 2 — Optional: collect through Paystack (Dedicated Virtual Accounts +
  Split Payments)** to kill the cash/transfer handover and make vendor payout
  automatic at the doorstep. Bigger operational change, real per-order cost
  (**~1.5% + ₦100 per order**, confirmed real — ₦400 on a ₦20k order), compliance
  (BVN validation), and it forces **agent payouts** too. Evaluate later — don't
  build it first.

The reason Phase 1 is easy: Reda already freezes the exact amount owed per vendor
per day in `settlements.expected_amount`, with a per-delivery `snapshot` and
drift detection. A Paystack transfer's `reference` maps 1:1 to a settlement id,
so "pay the vendor what we owe them" is a thin, safe layer on top of work that's
already done.

### Where we landed (decision, 2026-06-23)
- **Priority = vendor payout.** Automate Reda→vendor; leave agent collection alone.
- **Provider = Paystack** for the payout — chosen over Monnify because the one
  make-or-break fact (funding the payout wallet is **free**) is *confirmed* for
  Paystack (the PT-account top-up) and only *unconfirmed* for Monnify.
- **The non-negotiable mechanic:** a payout API pays out of **its own wallet**, so
  Reda's float must sit in the **Paystack balance** — NOT in a bank account. A plain
  bank account can't be auto-paid-from (Moniepoint has no API; only Monnify does,
  and Monnify's wallet ≠ a Moniepoint bank account). The collected money is moved
  into the Paystack balance via the **free PT-account top-up** (this is a top-up,
  not the 1.5% collection fee).
- **Funding is the one manual step:** Uzo either **tops up nightly** (the app shows
  the exact ₦ to cover that night's vendor payouts) or keeps a **running float**.
  Everything else — amounts, sending, confirmation, recording — is automated.
- **Agent→Reda collection stays free and unchanged** (transfer into Reda's normal
  bank account); it just feeds the float. See §3b — and note its earlier
  "Moniepoint/Monnify for inbound" idea was corrected: gateway collection VAs all
  cost ~1.5%; receiving into a plain bank account is free.

---

## 1. Reda's money model today (verified against the live DB)

**Per delivery** (`deliveries` columns, all `numeric` unless noted):
- `customer_price` — what the customer should pay.
- `paid` — what the customer actually paid (set at "delivered").
- `payment_method` (`text`) — `cash` | `transfer` | `vendor_direct` (~98% transfer).
- `charged_snapshot` — Reda's per-delivery fee (frozen from the location rate card).
- `agent_payment_snapshot` — the agent's per-delivery fee (frozen likewise).
- `cash_pos_fee_snapshot` — ₦500 when the customer paid cash (else 0).

> Fees are **per-delivery by location rate** — never × quantity, never per product.

**The flow:**
- Customer pays the **agent** (cash, or transfer the agent verifies).
- Agent **keeps** `agent_payment_snapshot` and physically hands Reda the rest.
  → Agents are **not** paid out by Reda today; they self-deduct from collections.
- **Reda owes each vendor:** `paid − charged_snapshot − cash_pos_fee_snapshot`.
- **Reda's margin:** `charged_snapshot − agent_payment_snapshot`.

**Settlement (already built):** `settle_period(subject_type, subject_id, period_date, note)`
freezes a row in `settlements` (`expected_amount`, `deliveries_count`, `snapshot`
jsonb of the per-delivery breakdown), one active row per subject-day
(`void_settlement` re-opens it). `client_remit_summary/detail` (+ `_rep` variants
that hide Reda's fee) drive the reconcile screens. **Today the actual money move
to the vendor is a manual bank transfer in Uzo's banking app** — that is the gap
Paystack closes.

**What's missing for payouts (confirmed):** `clients` has only `contact_email` /
`contact_phone`; neither `clients` nor `users` has any bank-account / Paystack
recipient field. Those have to be added.

---

## 2. What Paystack offers (the relevant pieces)

### a) Transfers API — pay money OUT to a bank account (the core of remittance)
- Create a **Transfer Recipient** from `bank_code` + `account_number` → get a
  `recipient_code` (store it). Use **Resolve Account Number** first to confirm the
  account name before saving.
- **Initiate Transfer** with a unique `reference` + `recipient_code`. The reference
  prevents double-crediting — you retry the *same* reference rather than sending a
  new one. (Perfect fit for our idempotency model.)
- **Bulk Transfer**: up to 100 per batch, one batch / 5s — for paying many vendors
  (or agents) in one settlement run.
- Paystack checks **balance ≥ amount + fee** before sending, so Reda must keep a
  **float in its Paystack balance**.
- **Fees (NGN):** ₦10 (≤₦5,000), ₦25 (₦5,001–50,000), ₦50 (>₦50,000), **plus a
  ₦50 stamp duty on any payout ≥ ₦10,000** (since Feb 2026).
- Available to businesses in NG/GH/ZA/KE. By default transfers need an OTP; for
  automated server-side payouts you disable OTP and gate it in your own backend.

### b) Dedicated Virtual Accounts (DVA) — receive customer transfers INTO Paystack
- A unique Paystack account number tied to a customer; their bank transfer lands
  in **Reda's Paystack balance**, with a webhook you can match to an order.
- Nigeria-registered businesses only; **limit ~1,000 active accounts**. Requires
  customer name/email/phone; "general services" category requires
  **BVN/identity validation** per customer via the API.
- **Collection fee (money IN) is NOT cheap.** Paystack states "Pay with Transfer
  has exactly the same pricing as the other [local] channels" — i.e. the standard
  local rate **1.5% + ₦100, capped ₦2,000** (₦100 waived under ₦2,500). DVA
  specifically is documented at **1% capped ₦300** in one support article, but
  the published figures conflict (DVA vs. Pay-with-Transfer), so **confirm the
  exact rate with Paystack for the chosen product before relying on it.** Either
  way, on a ₦20,000 order this is ~₦300–₦400, materially more than ₦0 for a direct
  bank transfer today. This is the fee that decides Phase 2's viability.

### c) Split Payments / Subaccounts — auto-divide an inflow
- Create a **subaccount** per vendor; a payment (incl. a DVA inflow assigned a
  `split_code`) is automatically split: vendor's cut → vendor subaccount, Reda's
  fee → Reda. Split by percentage or flat; `bearer_type` decides who pays the fee.
- This is what makes Phase 2 "vendor gets paid automatically" rather than "Reda
  collects then pays out."

---

## 3. Phase 1 design — automated vendor payouts (recommended)

Collection unchanged. Add a payout layer keyed off settlements.

**Schema additions**
- `clients`: `bank_code text`, `bank_account_number text`,
  `bank_account_name text`, `paystack_recipient_code text`,
  `payout_verified_at timestamptz`. (Account number is low-sensitivity but treat
  the recipient code as the source of truth once created.)
- New `payouts` table (immutable, mirrors the settlements/audit culture):
  `id`, `settlement_id` (FK → settlements), `subject_type`, `subject_id`,
  `amount`, `paystack_reference` (unique = settlement id), `recipient_code`,
  `status` (`pending|sent|success|failed|reversed`), `transfer_code`,
  `failure_reason`, `created_by`, timestamps.

**RPC / backend**
- `initiate_client_payout(settlement_id)` (admin-only): reads the frozen
  `expected_amount`, refuses if the settlement is voided or already has a
  non-failed payout, inserts a `payouts` row, and calls an edge function.
- Edge function `paystack-payout` (service-role, secret key server-side only):
  ensures/creates the recipient, calls **Initiate Transfer** with
  `reference = settlement_id`, records `transfer_code` + status.
- Edge function `paystack-webhook`: verify the `x-paystack-signature` HMAC,
  handle `transfer.success` / `transfer.failed` / `transfer.reversed`, update the
  `payouts` row, write audit, push a notification to Uzo. (Deploy webhooks with
  `--no-verify-jwt` so Paystack can reach them — same gotcha as our other functions.)

**Idempotency & safety**
- `reference = settlement_id` → retries never double-pay.
- A payout can only be initiated against a **non-voided, fully-settled** day; if a
  day is re-opened (`void_settlement`) after payout, flag for manual review rather
  than auto-reversing.
- Keep OTP off but restrict the initiate RPC to admin and log every call.

**Funding the payout wallet (the key mechanic):** Paystack Transfers pay out of the
**Paystack balance**, so the float must live there — a bank account cannot be
auto-paid-from. Reda moves collected money into the balance via the **PT account**
(a NUBAN that auto-credits the balance), which is a **FREE top-up in Nigeria** — not
the 1.5% collection fee (that only applies to *receiving from customers* via a
gateway VA, which Phase 1 never does). Two funding models:
- **Nightly top-up (recommended start):** Uzo transfers the day's vendor total into
  the PT account, then payouts fire. The app shows the exact ₦ to send. Minimal
  money parked at Paystack.
- **Running float:** keep a standing balance; payouts fire with no nightly step; top
  up when low. Fully hands-off, but ties up working capital at Paystack.

Phase 1 does **not** change how customers pay — only how vendors get paid.

**What Phase 1 does NOT do:** it doesn't touch agent settlement (agents still
self-deduct from cash). Agent payouts only become necessary under Phase 2.

---

## 3b. Cutting the agent→Reda remittance cost — use a bank rail, NOT a gateway

**Context (Uzo, 2026-06-22):** customers pay the agent (so the agent can confirm
the delivery); the agent should then remit to Reda *through the app*, like today —
but automated + confirmed. Doing that "through Paystack" costs ~₦2,000/agent/night
(capped collection fee); at ~20 agents that's **~₦40,000/night (~₦1.2M/month)** just
to move money Reda already holds. Unacceptable.

**Root cause:** gateways price for *accepting payments from strangers* (cards,
chargeback/fraud risk). An agent paying HQ is an **internal bank transfer** — it
shouldn't be on a gateway rail.

**The critical distinction (corrected 2026-06-23):** "virtual account" comes in two
forms that are easy to confuse —
- **Gateway *collection* virtual account** (Paystack DVA, **Monnify reserved
  account**, Flutterwave VA): auto-attributes the payer + fires a webhook, but
  charges the **collection fee ~1.5% capped ₦2,000 — the WHOLE category, Monnify
  included.** Monnify is a gateway just like Paystack here; do NOT use it for inbound.
  (Squad's VA is cited cheaper — capped ₦1,000, low % — but it's still a gateway VA;
  verify directly.)
- **Direct *bank account*** (Moniepoint Business, Kuda, any bank): **free to
  receive**, no collection fee — but it's ONE account, so it does NOT auto-attribute
  per agent or fire a per-payment webhook for free.

You cannot get *free* **and** *auto-webhook attribution* from one provider —
attribution-by-virtual-account is exactly what the 1.5% buys.

**Cost ladder for the agent→Reda leg** (assume ~₦185k/agent/night):

| Rail | Fee /agent/night | 20 agents | Auto-attributed |
|---|---|---|---|
| Paystack / **Monnify** / Flutterwave gateway VA | ~₦2,000 (1.5% cap) | ~₦40,000 | yes (webhook) |
| Squad (GTCO) gateway VA | ≤₦1,000 (verify) | ≤₦20,000 | yes (webhook) |
| **Moniepoint Business *bank account*** | **₦0 inbound** (reliable alerts) | **₦0** | no — match by amount/alert |
| Plain transfer to Reda bank + Mono/Okra confirm | **₦0** (agent pays ₦10–50 CBN) | ₦0 + flat API fee | yes (open banking) |
| Plain transfer + Uzo marks "received" in app | ₦0 | ₦0 | no (manual) |

**Recommended:** receive agent remittances into Reda's **Moniepoint Business *bank
account*** (NOT a Monnify/Squad gateway VA):
- **₦0 inbound**, and Moniepoint's reliable instant credit alerts fix the exact
  problem that killed Kuda for Uzo (missing/late receipts).
- **Attribution** = the app already computes each agent's exact owed amount; match
  the incoming credit to it via Uzo's eyeball on the alert (manual, free) now, and
  **open banking (Mono/Okra)** auto-matching the statement later (flat fee, no %).
- **Outbound vendor payouts** from the same Moniepoint account at **flat ₦20** each,
  and the vendor gets a proper Moniepoint receipt. One account, no gateway, no 1.5%.

**"If agents pay into Reda's bank account, how does Reda pay vendors via Paystack?"**
Paystack pays out of a **Paystack balance**, not a bank account — so you sweep the
pooled remittances from the business account into Paystack. In Nigeria this
**balance top-up is FREE** via the **Paystack "PT account"** (a NUBAN that auto-
credits your Paystack balance), so the bridge costs nothing — no 1.5% reappears.
Flow: customer→agent (free) → agent→Reda business account (cheap/free in) →
free top-up to Paystack PT account → Paystack Transfers to vendors (₦10–50 + stamp).

**But Paystack may be unnecessary for payouts.** Whatever business account holds
the remittances (Moniepoint/Monnify, Kuda, Squad) can pay vendors **directly** via
its own bulk-payout API at **₦10–₦20 flat, no %** — same price, one fewer hop, one
balance instead of two. Prefer **one provider end-to-end** unless there's a
specific reason to keep Paystack on the payout leg.

**Truly ₦0 marginal option:** agents transfer to Reda's normal account; the app
reads the inflow via **open banking (Mono/Okra)** and auto-matches by amount +
per-agent reference. Pay a flat API fee instead of a % of every naira — lowest
marginal cost, most integration work.

**Caveats:** exact Squad % and Moniepoint/Kuda inbound fee + API quality need a
**direct quote/call** (published figures are thin), and **every provider
negotiates custom rates at volume** — at ~₦1.2M/month of fees at stake, negotiate.

## 4. Phase 2 — collect through Paystack (optional, bigger)

Replace the doorstep cash/transfer-to-agent with a **DVA** the customer transfers
into; use **Split Payments** so the vendor's cut and Reda's fee separate
automatically; then the only thing left to pay out is the **agent's fee** (bulk
Transfer). Upsides: no cash in agents' hands, no "agent owes Reda" credit risk,
near-instant vendor settlement, full digital trail. Costs/risks:
- **~1.5% + ₦100 per inflow (capped ₦2,000)** — confirmed against a real Paystack
  business: a **₦20,000 order was charged ₦400** (1.5%×20,000 + ₦100). On Reda's
  volume this is the dominant cost, and Reda's `charged_snapshot` fee must absorb
  it. This is the main economic question — and the reason Phase 2 may not be worth
  it vs. today's ₦0 direct bank transfer.
- **DVA quota (~1,000 active)** → use **per-agent** DVAs (customer pays into the
  agent's account with the order as narration) rather than per-order, or recycle.
- **Compliance:** BVN/identity validation for the "general services" category;
  full business activation on Paystack.
- Forces building **agent payouts** (Transfers/bulk) since agents no longer hold cash.

---

## 5. Cost sketch

- **Phase 1, one vendor, ₦200,000 daily remit:** ₦50 transfer + ₦50 stamp = **₦100**.
  Even 20 vendors/day ≈ ₦2,000/day. Trivial vs. the manual-error and time savings.
- **Phase 2, collection:** **1.5% + ₦100 per order inflow** (capped ₦2,000) —
  confirmed real: **₦400 on a ₦20,000 order**. This is the big one. On, say, 100
  orders/day averaging ₦20k that's **~₦40,000/day** in collection fees that didn't
  exist before. Only worth it if removing cash handling + instant vendor payout
  justify it, and if `charged_snapshot` is raised to cover ~2% per order.

---

## 6. Prerequisites & open questions

1. **Does Reda already have an activated Paystack business account?** Transfers and
   DVA both need completed compliance (CAC docs etc.).
2. **Where will the payout float live** and who tops it up? (Phase 1 needs a funded
   Paystack balance.)
3. **Vendor bank details** — collected how, by whom, verified via Resolve Account
   Number, and re-confirmed on change.
4. **Voided-settlement-after-payout policy** — manual review (recommended) vs. auto.
5. **Agents:** stay self-deduct (Phase 1) or move to payouts (only under Phase 2)?
6. **Reconciliation source of truth** stays `settlements`; Paystack is the
   execution layer, not the ledger.

## 7. Recommendation

Build **Phase 1** (vendor payouts off `settle_period`) — it's a thin, idempotent,
high-value layer on the settlement model that already exists, and it directly
removes Uzo's daily manual-transfer chore with a full audit trail. Treat **Phase 2**
(DVA + split collection, agent payouts) as a separate evaluation once Phase 1 is
live and the 1% inflow economics are modelled against `charged_snapshot`.

---

### Sources
- [Paystack Transfers](https://paystack.com/docs/transfers/) ·
  [Single](https://paystack.com/docs/transfers/single-transfers/) ·
  [Bulk](https://paystack.com/docs/transfers/bulk-transfers/) ·
  [Recipients](https://paystack.com/docs/transfers/creating-transfer-recipients/) ·
  [How transfers work](https://paystack.com/docs/transfers/how-transfers-work/)
- [Transfers pricing](https://support.paystack.com/en/articles/2130370) ·
  [Transactions pricing](https://support.paystack.com/en/articles/2130306) ·
  [Stamp duty on NGN transfers](https://support.paystack.com/en/articles/7573314)
- [Dedicated Virtual Accounts](https://paystack.com/docs/payments/dedicated-virtual-accounts/) ·
  [DVA support](https://support.paystack.com/en/articles/2124866) ·
  [NG compliance](https://support.paystack.com/en/articles/2123970)
- [Split Payments](https://paystack.com/docs/payments/split-payments/) ·
  [Transaction Split API](https://paystack.com/docs/api/split/)
