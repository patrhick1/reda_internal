# Phase 7 — Cutover & Parallel Run Protocol

**Goal:** Reda's day-to-day starts using the Reda app for the manual flow while
the Google Sheet + Make.com pipeline keeps running in parallel for the first
weeks. Bot/AI ingestion (Phase 8) is **off**. If anything breaks, falling back
to the spreadsheet is a no-cost decision because nothing was turned off.

---

## What's already in place (as of 2026-05-13)

- **Schema** in the Supabase project `wadjlpqfpaxycspofgrc` (no separate prod
  project — current project is treated as prod per the Phase 7 decision).
- **Seeded data:**
  - 38 active clients (from `Know The Clients (REDA).xlsx` → Sheet1)
  - 118 active products (113 from Sheet1 + 5 new from the stock-fix pass)
  - 57 atomic locations with **both** `charged` + `agent_payment` rates;
    8 partial-rated locations listed at the bottom of
    [scripts/phase7-seed-001-locations.sql](scripts/phase7-seed-001-locations.sql)
    for Uzo to fill in over time
  - 16 active agents:
    - 13 from the "Agent Groups" tab
    - 3 added during the stock-fix pass (Anjola, Funke, Mr Austin) because their
      stock showed up in the Agent Inventory tab
    - Plus 1 `agent@reda.dev` test account (leave for now; deactivate after
      week 1 if not used)
  - 2 admins: legacy `admin@reda.dev` + Uzo at `redalogisticss@gmail.com`
  - 156 stock_adjustments across 15 agents (87 from the initial backfill +
    69 from the consolidation pass; see "Known data caveats" below)
- **Edge function** `send-assignment-push` deployed; **Supabase Database
  Webhook** wired to it on INSERT + UPDATE of `deliveries.assigned_agent_id`.
- **Agent stock backfill** — best-effort latest snapshot from the agent
  inventory months. Some product names had to be canonicalised across sheets.
- **Auto-assign trigger** on inserts to `deliveries` (Phase 6.2).
- **Reconciliation RPCs** (`client_remit_summary`, `agent_earnings_summary`)
  callable from the Admin Reconcile tab.

---

## Credentials handoff (BEFORE cutover day)

1. Hand Uzo the password for `redalogisticss@gmail.com` from
   [scripts/phase7-agent-credentials.txt](scripts/phase7-agent-credentials.txt).
   Have Uzo rotate it on first login.
2. For each agent in that file: send the agent **only their own** email +
   temp password via WhatsApp DM (not the group). Tell them to change it on
   first login.
3. After every agent has logged in once, **delete `phase7-agent-credentials.txt`
   from the working tree.** Already in `.gitignore`, but get the local file gone.
4. Make sure no operational xlsx is committed (they're in `.gitignore` now too).

---

## Cutover day (call it D-day)

Pick a calm morning (Tuesday or Wednesday, not Monday/Friday). On D-day:

1. **Morning briefing (15 min) with Uzo:**
   - Show the Admin Reconcile tab + per-client / per-agent summaries.
   - Walk through creating a manual delivery (`/deliveries/new`).
   - Walk through status transitions (pending → available → delivered, with
     `paid` + `payment_method`).
   - Show the agent app on a real phone (one of the agents' phones is best —
     practise on a real Android, not an emulator).

2. **App-first for ALL new deliveries from this point.**
   The Google Sheet stays open for reconciliation, **not** for new entries.
   If an agent or Uzo enters the same delivery in both, the sheet copy gets
   IGNORED — the app is the source of truth from D-day forward.

3. **Bot pipeline stays OFF** for now (no schema or feature flags to flip —
   Phase 8 doesn't exist yet). Make.com keeps writing to the sheet so the
   parallel-run baseline is unbroken.

4. **Week-1 stock reconciliation (per agent, day 1):**
   Each agent logs in, opens **Stock → My Stock**, physically counts what they
   have, and creates **correction** adjustments for any drift. This catches the
   known issues with the imported numbers (see "Known data caveats").

---

## Daily reconciliation loop (Uzo, end of each workday)

Open the **Admin → Reconcile** tab, set the date range to "today only":

1. **Per-client** view:
   - For each client whose `Outstanding` is non-zero, eyeball whether it
     matches the sheet for that client. Note any discrepancy in a
     scratch log.
2. **Per-agent** view:
   - For each agent who delivered today, confirm `Total earnings` matches
     what you'd pay them. If an agent expects a payout that doesn't show up
     here, it means the delivery wasn't completed in the app — fix the
     status / quantity / payment in the app, not the sheet.
3. **EOD rollover:** click "Run EOD rollover for `<today>`" to roll any
   pending deliveries forward to tomorrow.

Track all discrepancies in a simple Google Doc — date, client/agent, what the
app said, what reality was, what was done. After ~5 clean days, the sheet
becomes read-only.

---

## Rollback playbook

If the app breaks operations on any day:

1. **Stop**. Don't try to fix in the moment.
2. Tell Uzo + agents: "back to the sheet today, app paused".
3. The Make.com → sheet pipeline is still running, so the sheet has a
   complete record. No data is lost.
4. File the issue, fix in dev, then re-enter that day's operations into the
   app (creating each delivery with its real `scheduled_date`) once stable.
5. Resume cutover the next morning.

There's no irreversible state in the app yet (no bot, no auto-billing). The
only thing that needs care is **avoiding double-recording** during the
rollback window — make sure each agent knows which system they're using
for the day.

---

## Known data caveats from the cutover seed

Sourced from Uzo's spreadsheets, which had real-world drift:

1. **8 locations have only one rate side.** Customer-side or agent-side
   missing. See the comment block at the bottom of
   [scripts/phase7-seed-001-locations.sql](scripts/phase7-seed-001-locations.sql).
   Admin → Catalog → Rates can patch them as deliveries to those areas show up.

2. **Agent stock numbers are best-effort.** The "Left With Agent" column in
   `REDA Agent Inventory 2026.xlsx` was the source. Several sources of drift:
   - Same product appears under multiple labels in Uzo's sheets
     (e.g. `Collagen (Altior)` and `Collagen Mask` are the same physical product
     from Altior Essentials; some agents recorded both).
   - "Queen" and "Queen Favour" are the same person; their stock got unioned
     onto `queen.favour@reda.dev` (with overlap → product totals may be
     inflated for ~6 products).
   - "M. Jerry (Iya Ayo)" is a sub-helper under Iya Ayo; M. Jerry's stock got
     folded onto `iya.ayo@reda.dev`.
   - 3 agents (Anjola, Funke, Mr Austin) weren't in the Agent Groups tab but
     held stock in the Inventory tab — they were onboarded during the fix
     pass.
   **Mitigation:** week-1 per-agent stock reconciliation (see "Cutover day"
   step 4).

3. **Customer-product price tiers** (`Price List` tab of
   `Know The Clients (REDA).xlsx`) are **not** seeded. The schema doesn't
   model per-(client, product, quantity) pricing — that goes in
   `deliveries.customer_price` per-delivery. Uzo / dispatcher enters the
   correct price each time. If this becomes painful, Phase 8+ could add a
   `product_price_tier` table.

4. **5 "extra" clients** appear in the Agent Inventory product list
   (`Bleezmart, Crystal Aijay, Greenvive, KvStore, Universal, Zens Essential`)
   that aren't in Sheet1's active set. They were NOT seeded. If any are real,
   add via Admin → Catalog → Clients.

5. **Tavora** is the reverse: in Sheet1 but missing from the master product
   list. Got created without any products. Add products via
   Admin → Catalog → Products when ready.

6. **`Scenthut`** was a leftover dev test client. Deactivated during the
   stock-fix pass.

---

## After the first clean week

When you've had ~5 consecutive days where end-of-day reconciliation matched
the sheet (or where any drift had a clear cause and was fixed):

1. Tell Uzo the sheet is now read-only — only the app creates new rows.
2. Keep Make.com → sheet running for **one more month** as an audit trail.
3. Mark Phase 7 complete in [reda_phased_plan.md](reda_phased_plan.md).
4. Open Phase 8 (bot ingestion + AI normalisation behind a feature flag).

---

## File index for Phase 7

- [scripts/build-phase7-seed.py](scripts/build-phase7-seed.py) — generator for the seed SQL
- [scripts/build-phase7-stock-fix.py](scripts/build-phase7-stock-fix.py) — generator for the consolidation pass
- [scripts/phase7-seed-000-cleanup.sql](scripts/phase7-seed-000-cleanup.sql) — retire dev seed rows
- [scripts/phase7-seed-001-locations.sql](scripts/phase7-seed-001-locations.sql) — 57 locations + rate cards
- [scripts/phase7-seed-002-catalog.sql](scripts/phase7-seed-002-catalog.sql) — 38 clients + 113 products
- [scripts/phase7-seed-003-agents.sql](scripts/phase7-seed-003-agents.sql) — 13 agents + Uzo
- [scripts/phase7-seed-004-stock.sql](scripts/phase7-seed-004-stock.sql) — initial stock backfill (87 pairs)
- [scripts/phase7-seed-005-stock-fix.sql](scripts/phase7-seed-005-stock-fix.sql) — 3 more agents + 69 fixed pairs + Scenthut cleanup
- [scripts/phase7-agent-credentials.txt](scripts/phase7-agent-credentials.txt) — temp passwords (gitignored)
