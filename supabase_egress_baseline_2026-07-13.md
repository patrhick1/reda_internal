# Supabase Egress Baseline — 2026-07-13

Captured with the dev egress logger (`mobile/src/lib/egress-log.ts`) during a
single admin walk-through on Expo web (`npm run start` → web). Numbers are
decoded response-body sizes (a consistent yardstick, not exact wire bytes).
This is the **"before"** we compare Phase 2/3 against.

**Session total: ≈ 6.5 MB** across ~150 requests for ONE user walking the app
once (login → deliveries list → several details → stock → reconcile → review →
back). Multiply by every device × every day for the real bill.

## Top egress sources (ranked)

| Source | Per single load | Notes | Audit finding | Fixed by |
| --- | ---: | --- | --- | --- |
| `GET deliveries_admin` | **454 KB** | The wide admin list view. Refetched on almost every navigation. ~3.9 MB of the 6.5 MB session (≈60%). | #3 (detail-shaped list) + #6 (no cache) | **Phase 2 cache** (stop refetching) + **Phase 3** `list_deliveries_v2` compact projection |
| `GET delivery_items` | **~122 KB** (4 chunks) | The separate line-items fetch that rides every list load. ~1 MB of session. | #3 | **Phase 3** (fold item label/count into the list projection) |
| `GET delivery_messages` | up to **133 KB** | A heavy thread. Also refetched. | #7 (realtime refetch) | Phase 4 (patch cache from events) |
| `GET bot_inbound_messages` | **~42 KB/row** (84.5 KB ×2) | Review list ships raw_text + parse_result debug. | #10 | **Phase 3** user-facing review projection |
| `GET current_stock` | **34 KB** | Full stock matrix, even on scoped screens. | #5 | Phase 3 scoped stock queries |
| `POST rpc/list_stock_movements_global` | 34 KB | Movements page. | #13 | Phase 2 cache + keyset (already paginated) |
| `GET product_catalog` | 18–37 KB | Reference data, refetched per screen. | #14 | **Phase 2 cache** |
| `GET locations` | 18 KB | Reference data. | #14 | **Phase 2 cache** |
| `GET clients` | 13–15 KB | Reference data, seen 6+ times. | #14 | **Phase 2 cache** |
| `GET users` | 11 KB (×many) | Reference data, seen 10+ times. | #14 | **Phase 2 cache** |
| `POST rpc/client_remit_summary` | 5.5–8.6 KB | Reconcile. Keep complete. | #12 | (keep; cache range) |
| `HEAD bot_inbound_messages` | **0.0 KB** | ✅ the needs-review badge — Phase 1 item 2 working. | — | done |

## What the numbers confirm

1. **The delivery list is the whole game.** `deliveries_admin` (454 KB) +
   `delivery_items` (122 KB) = **~577 KB per list open**, and it's re-fetched on
   nearly every navigation because there's no cache. Roughly **75% of the entire
   session** is this one data path.

2. **Two independent levers, both apply to it:**
   - **Phase 2 (cache)** — the same 454 KB `deliveries_admin` was fetched 8+
     times in this single walk. A stale-while-revalidate cache turns most of
     those repeats into 0 (or a cheap revalidation). Estimated cut on this
     session alone: **~2.5–3 MB** (the repeat fetches).
   - **Phase 3 (`list_deliveries_v2`)** — the 454 KB is a detail-shaped payload
     used for cards. A compact card projection + folding items in could take one
     *genuine* list load from ~577 KB → **~80–120 KB**.
   - Together, plausibly **~80% off** the delivery-list egress.

3. **Reference data (users/clients/locations/products/status-defs) is fetched
   over and over** — `users` 10+ times, `clients` 6+ times. Individually small
   (11–37 KB) but they add up and are the easiest Phase 2 cache win (long stale
   times, rarely change).

4. **Phase 1 wins are visible.** `HEAD bot_inbound_messages` shows 0.0 KB — the
   needs-review badge is a true HEAD count now (item 2), not 100 rows. No wide
   `list_location_changes` fetch for the zone badge (item 3).

## Priority (unchanged, now evidenced)

1. **Phase 2 — TanStack Query cache.** Biggest bang: kills the repeat 454 KB
   `deliveries_admin` + all the repeated reference fetches. ~half the session.
2. **Phase 3 — `list_deliveries_v2` compact projection** (and the bot-review
   projection, scoped stock). Cuts the *size* of each genuine load.
3. Phase 4 (realtime/thread), Phase 5 (progressive history) after.

## Raw burst log
Captured bursts are in the chat transcript for 2026-07-13. Re-run any time with
`npm run start` → web → F12 console (or device → Metro terminal); tables
auto-print ~4s after each burst settles. `__egress.report()` for the cumulative
total, `__egress.reset('x')` to segment a specific journey.
