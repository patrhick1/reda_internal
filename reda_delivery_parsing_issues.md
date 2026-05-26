# Investigation — Bot intake on 2026-05-16

## Context

Paschal got a push: *"A WhatsApp message couldn't be parsed — open Review."* This investigation started with the 7 needs_review rows showing on screen. **Bigger picture turned up underneath**: those 7 are the tip of the iceberg, and the actual customer-facing problem today is silent stock failures.

## What today's 144 inbound messages did

```
status=created_delivery   30   ✅ orders created
status=needs_review        7   🔔 pushed Paschal
status=error             107   🔇 silent
                         ---
total                    144
```

**Only 30 of 144 orders (21%) successfully created a delivery today.** 7 pinged Paschal. **107 silently failed.**

## Three distinct failure modes

### 1. The 7 needs_review (visible to Paschal)

All from the **contractor pre-parse path** (`parse_result.source = 'contractor'`) — Gemini extraction was skipped entirely. Address/location is what trips needs_review here, except row 7 which is product ambiguity.

| Row | Customer | Contractor `location` hint | Cause |
|---|---|---|---|
| 555d3cd8 | Okechukwu Ezegbo | `Amuwo-Odofin` | Catalog gap |
| 619f3f73 | Deogratias UNISEX | `Ogudu` | Catalog gap |
| 8bd20990 | (Batana Oil — no name in source text) | `Ogudu` (raw_address is Magodo) | Contractor hint disagrees with raw_address; both unknown |
| 00b3406c | Patrick | `Ajah (Under Bridge)` | Catalog has `Orchid - Ajah Under Bridge`; parens kill exact-match. Also raw_address is "Lagos Island" |
| 3320ff3e | DIDI Micah | `Victoria Island (VI)` | Catalog has `VI`; `victoria island (vi)` doesn't exact-match. **Maps+Gemini fallback also failed: Gemini hit HTTP 429** (rate limit) |
| 89ee76ed | Desmond | `Palmgrove` | Catalog gap (and address says `Somolu`; catalog has `Shomolu`) |
| acf3c9ef | Mr. Caleb | `Yaba` ✅ | Address matched. Product `"Normal Arabian Tea"` is sold by **both Gizmomart and Wendy** at score 1.0 → matcher at [bot-parse-message/index.ts:270-284](supabase/functions/bot-parse-message/index.ts#L270-L284) leaves it for review |

### 2. The 107 silent errors (NOT visible to Paschal)

All `error_text` = `insufficient_stock: agent has 0/1 units, delivery needs 2`. The contractor sends `assigned_agent` hints (Clement, Kenneth, Queen Favour, Audrey, Iya Ayo, etc.), bot resolves the hint → agent, then `bot_create_delivery` tries to write the row and `create_delivery` rejects because that agent's `current_stock` is below `quantity_ordered`.

**Per-product breakdown of today's stock errors:**

| Product (client) | Errors | Agent stock | Warehouse stock |
|---|---|---|---|
| Fire Extinguisher (Comfort Global) | 22 | **0** | **0** |
| Filter Mesh (Remxx) | 12 | **0** | **0** |
| Karami Tea (Karami) | 12 | 1 | 0 |
| 99 Bullet (Runet) | 10 | 2 | 0 |
| Perfume (Original Buy) | 9 | 4 | 0 |
| Batana Oil (Agomi Store) | 8 | **0** | **0** |
| D&N Arabian Tea (Gizmomart + Wendy) | 7 | **0** | 0 |
| Total Beets (Gizmomart) | 5 | **0** | 0 |
| Pureflow Water Filter (Elite Store) | 4 | **0** | 0 |
| + 10 other products | ~20 | mostly 0 | 0 |

This is a **stocking** problem, not a parsing problem — many products are entirely depleted at every agent **and** the warehouse.

### 3. Why "error" rows don't notify

[reda_prd.md:595](reda_prd.md#L595): the `notify_bot_review` trigger fires **only** on `status='needs_review'`. `status='error'` is silent. Paschal sees error rows only if he opens the **Errors** tab on the Review screen. From [reda_admin_runbook.md:97](reda_admin_runbook.md#L97): *"Errors — Gemini failed or the network died. Usually transient; tap to see the error."* — that description assumes errors are rare/transient, which today they aren't.

## Why the bot is stricter than the manual UI

`create_delivery` has parameter `p_allow_insufficient_stock` (default `false`). The mobile UI passes **`true`** every time — manual dispatch can create a stockless delivery, and `notify_pickup_needed` then pings admins+dispatchers to issue a warehouse → agent transfer. The bot pipeline calls `bot_create_delivery`, which **doesn't expose this parameter**, so it inherits the default `false` and hard-rejects. Result: the bot has a different (stricter) policy than human dispatchers, and that policy is invisible.

Code paths:
- Mobile manual: [supabase/functions/.../create_delivery](.) called with `p_allow_insufficient_stock=true`.
- Bot: [supabase/functions/bot-parse-message/index.ts:401-414](supabase/functions/bot-parse-message/index.ts#L401-L414) → `bot_create_delivery` → `create_delivery` with default `false`.

## Implications — fix vs. don't fix

### Issue A: 4 catalog gaps (Amuwo-Odofin, Ogudu, Magodo, Palmgrove)
- **Don't fix**: Every contractor message naming these neighborhoods will keep landing in needs_review forever. Each one requires manual delivery creation. Low volume today (≤2 per neighborhood per day so far) but compounding.
- **Fix** (after Uzo pricing): one SQL `INSERT` per location, then they auto-match. Side-effect: deliveries to these locations would auto-create even if pricing isn't set up — the `effective_rate` call at [create_delivery](.) returns null if no rate exists, so `charged_snapshot` / `agent_payment_snapshot` would be NULL on those deliveries. Not catastrophic but needs Uzo's rate before going live.

### Issue B: 2 format mismatches (VI / Ajah Under Bridge)
- **Don't fix**: Customer orders in VI and Lekki corridor that the contractor formats with parens will keep failing. Higher volume risk than A — VI is a core service area.
- **Fix**: Add aliases — one-line `UPDATE locations SET aliases = aliases || ARRAY['Victoria Island','Victoria Island (VI)']`. Side-effect: none, aliases are additive.

### Issue C: Product ambiguity across clients (Normal Arabian Tea)
- **Don't fix**: Anytime two clients share a product name, every order needs manual disambiguation. Will recur whenever Gizmomart/Wendy both stock the same SKU.
- **Fix path 1 (process)**: Ask contractor to start sending `client_hint` in `raw_payload` — [bot-parse-message/index.ts:230-232](supabase/functions/bot-parse-message/index.ts#L230-L232) already consumes it.
- **Fix path 2 (code)**: Add tie-breaker rule when top candidates differ only by client. Risk: silently picking the wrong client = wrong invoice + wrong stock decrement. Don't do this without the contractor providing the signal explicitly.

### Issue D: Gemini API rate-limiting (HTTP 429)
- **Observed**: 2 of 30 fallback calls today hit 429. Low rate so far, but the address-matcher's accuracy degrades to "exact-match only" when this happens.
- **Don't fix**: Occasional address misses on busy days. Probably acceptable while volume is low.
- **Fix**: Bump Gemini quota OR add exponential-backoff retry inside normalize-address. Cost vs benefit tiny right now.

### Issue E: 107 silent stock failures **← this is the big one**
- **Don't fix**: Customers wait. Reda silently drops 70%+ of orders. No one knows except the contractor and the customer (and they assume Reda is fulfilling). Reputation risk + revenue loss.
- **Fix path 1 (stocking)**: Reda physically restocks the warehouse and pushes inventory to agents. This is the *root cause* — Fire Extinguisher, Filter Mesh, Batana Oil, D&N Arabian Tea, Total Beets, Pureflow Water Filter all show 0 across every agent AND 0 warehouse. The bot pipeline is correctly refusing to create deliveries Reda can't fulfill.
- **Fix path 2 (code, align bot with manual)**: Have `bot_create_delivery` pass `p_allow_insufficient_stock=true` to match mobile UI behavior. Side-effect: bot-created deliveries would land in `pending` status with no stock, fire `notify_pickup_needed` to admins+dispatchers, and require a warehouse transfer before the agent can deliver. Customers technically get accepted. But if warehouse is also empty (which it is for several SKUs today), the pickup-needed push goes nowhere actionable.
- **Fix path 3 (notify)**: Add `notify_bot_error` trigger so stock failures stop being silent. One-line PRD addition, mirrors `notify_bot_review`. Useful regardless of which of the above you pick.

## Open questions for Paschal (raised earlier)

- Service-area decision on Amuwo-Odofin / Ogudu / Magodo / Palmgrove — awaiting Uzo pricing conversation.
- Direction on Issue E — stock side (restock) or pipeline side (relax bot guard) or both.

## Files referenced (read-only, no edits)

- [supabase/functions/bot-parse-message/index.ts](supabase/functions/bot-parse-message/index.ts) — bot pipeline driver
- [supabase/functions/normalize-address/index.ts](supabase/functions/normalize-address/index.ts) — Maps+Gemini fallback
- `create_delivery` / `bot_create_delivery` (Postgres functions, queried via psql)
- [reda_admin_runbook.md:92-97](reda_admin_runbook.md#L92-L97) — current admin Review workflow
- [reda_prd.md:590-610](reda_prd.md#L590-L610) — notification matrix
- [mobile/src/screens/review/NeedsReviewScreen.tsx](mobile/src/screens/review/NeedsReviewScreen.tsx) — the screen Paschal saw

## What this plan does NOT do

Per Paschal's direction: **no code changes, no SQL writes, no catalog edits**. This plan is investigation only. Next step is Paschal's choice on each of Issues A–E once Uzo pricing is in hand and the implications above are understood.
