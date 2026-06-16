# Multi-Product Intake — Live Data Findings

**Date:** 2026-06-16 · **Source:** live DB, `bot_inbound_messages` + `deliveries`, **last 14 days** (3,043 inbound, 2,880 auto-created).
**Purpose:** for the multi-product build (Feature A) — which contractor products are **joined bundles** that must be split into line items, and which real **products we need to create**.

---

## 1. Headline

The contractor's bot collapses multi-item orders into **one "joined" product name**, and — critically — **those joined names already exist as SKUs in our catalog** (`D&N Arabian Tea`, `Perfume`, `Papaya/Garlic Enlargement Oil`, …). So the bot **auto-creates every order against the junk combo SKU** — **0 of 3,043 went to Needs Review in 14 days** — and stock is booked against a fake SKU. This is the same "Perfume" problem you already knew about, now confirmed across teas, enlargement oils, and skincare.

**Consequence for the build:** we **cannot trust the contractor's `product_name`** for these — it matches a real (junk) SKU, so it would never fail. The fix is exactly the merge we scoped: read the **raw message text** with our AI to recover the true line items, and **retire / stop matching** the junk combo SKUs.

---

## 2. Joined products the contractor sends (combo SKU → real components)

Ranked by live 14-day order volume.

| Client | Contractor sends (joined SKU) | 14d orders | Actually is | Components in catalog? |
|---|---|---:|---|---|
| Original Buy | **Perfume** | **621** | `<variant> perfume` + `perfume oil ×N` (± atomizer) | ❌ **create real perfume SKUs** |
| Wendy | **D&N Arabian Tea** | 138 | `Normal Arabian Tea` + `Double Arabian Tea` | ✅ both exist |
| Gizmomart | **D&N Arabian Tea** | 134 | `Normal Arabian Tea` + `Double Arabian Tea` | ✅ both exist |
| Express Global | **Papaya/Garlic Enlargement Oil** | 69 | `Papaya Breast Enl. Oil` + `Garlic Buttock Enl. Oil` (+ free `Flat Tummy Oil`) | ✅ two exist; Flat Tummy ❌ under Express Global |
| NewLyfHerbs | **Butt Acne Cream/Soap** | 34 | `Butt Acne Cream` + `Butt Care Soap` | ❌ **create both** |
| Wendy | **A7 Plus/Factor** | 0 (low) | `A7 Plus` + `A7 Factor` | ✅ both exist |

**Evidence (raw messages):**
- **D&N** = **D**ouble a**N**d Normal — *"Order Details: 1 Pack of Normal Arabian Tea, 1 Pack of Double Arabian Tea — ₦40,000."*
- **Papaya/Garlic** — *"3 PAPAYA BREAST ENLARGEMENT OIL AND 3 GARLIC BUTTOCK ENLARGEMENT OIL + 1 FREE FLAT TUMMY OIL = ₦60,000."*
- **Butt Acne Cream/Soap** — *"BUY 1 BUTT ACNE CREAM + 1 BUTT CARE SOAP + FREE DELIVERY = ₦26,500."*
- **Perfume** — *"OUD AL LAYL BROWN SINGLE WITH OIL … ONE OUD AL LAYL PERFUME + TWO PERFUME OILS + FREE DELIVERY"*; also *"OPULENT × KHAMRAH ORDER"*.

---

## 3. NOT joined — single combo-units (keep as ONE SKU, do **not** split)

These read like combos but are sold and stocked as **one unit at one price** — the message orders "1 unit", not separate lines. Leave them as single SKUs:

| Client | SKU | 14d orders | Why single |
|---|---|---:|---|
| Dentora | Oratox Capsule/Powder | 173 | *"Oratox Capsule and Powder — 1 unit — ₦19,500"* — one pack |
| Dentora | Clovofresh Capsule/Spray | 50 | *"Clovofresh Capsule and Spray — 1 unit"* — one pack |
| Runet | Alpha Combo | 20 | *"ALPHA COMBO — Quantity: 1 Unit"* — not itemized |
| Infinite | Wine Opener/Beer Opener | 0 | one dual-purpose tool |

---

## 4. Products to CREATE in the database

Only the components that **don't already exist** are listed. (D&N teas, Papaya/Garlic oils, and A7 components already exist — those just need **decomposition**, no new SKUs.)

### Original Buy — perfume range (biggest impact: 621 orders/14d)
*Names below are derived from the raw messages — **confirm the exact SKU names + full range with the vendor**, since 14 days won't show every perfume.*
- `Oud Al Layl` (the dominant variant — "Brown", sold Single/Double/Triple "with oil")
- `Opulent Oud`
- `Khamrah Dukhan`
- `Perfume Oil` (the "+ N perfume oils" add-on — appears in ~94% of Original Buy orders)
- `Atomizer` (occasional add-on)
- `Aswad Oud Al Layl` (seen as a free extra — confirm if a distinct SKU)
- `Touch` (seen ~18×; confirm)

### NewLyfHerbs
- `Butt Acne Cream`
- `Butt Care Soap`

### Express Global (optional — confirm)
- `Flat Tummy Oil` (the free add-on in the Papaya/Garlic bundle; exists under Khuga but not Express Global — only needed if we want the free item tracked in stock)

---

## 5. What this means for the build (refines the migration plan)

1. **Don't trust the contractor `product_name` for the joined SKUs.** Our AI must extract line items from `raw_text` (the study-bot approach), because the contractor name matches a junk SKU and would otherwise auto-create silently.
2. **A known-combo expansion map is worth adding** alongside the AI. The contractor will keep sending `D&N Arabian Tea`, `Perfume`, etc. A small map (`joined SKU → [component SKUs + default qty]`, e.g. `D&N Arabian Tea → 1 Normal + 1 Double`) gives a deterministic fallback/validation when the AI is unsure, and is how we backfill/relabel history.
3. **Retire the junk combo SKUs** once decomposition is live (stop them matching), so bundles can never collapse again — mirrors the "Perfume" retirement already in the plan.
4. **Seeding order:** create the real SKUs above **before** the intake cutover so the per-line matcher has something to match.

---

## 6. Method (reproducible)

- Joined detection: `bot_inbound_messages.raw_payload->'parsed'->>'product_name'` vs the real `raw_text`, last 14 days.
- Volume: `deliveries` joined to `product_catalog`/`clients`, `scheduled_date > current_date - 14`.
- Status mix (14d): `created_delivery` 2,880 · `duplicate` 135 · `error` 28 · **`needs_review` 0**.
- Catalog scanned: 43 clients, 133 products.
