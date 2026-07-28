# Supabase Egress Audit and UX-Preserving Optimization Plan

**Project:** Reda mobile application and Supabase backend  
**Audit date:** 2026-07-13  
**Primary constraint:** Reduce Supabase egress without removing information, making data harder to find, weakening live updates, or regressing perceived performance.

## Executive summary

The application can reduce egress substantially without hiding any information from users. The strongest opportunities are caused by _when and how often_ the same information is downloaded, not by the fact that the information exists.

The recommended strategy is:

1. Keep every currently visible field and action.
2. Stop duplicate and superseded requests.
3. Show cached data immediately, then refresh it in the background.
4. Return list-shaped data to lists and full-shaped data to details.
5. Aggregate counts and dashboard totals in Postgres instead of downloading rows only to count them on the phone.
6. Use Realtime events to update or invalidate the smallest relevant cache entry instead of refetching whole datasets.
7. Keep full raw/debug data available on demand, but do not ship it to screens that never render it.

The best first changes are low-risk and should improve the user experience: screens open with fewer duplicate loading states, back-navigation can show data immediately, searches can cancel obsolete requests, and live changes can update smaller areas of the interface.

The largest likely contributors, in priority order, are:

| Priority | Source                           | Current behavior                                                                                    | UX-preserving direction                                                                                     |
| -------- | -------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1        | Duplicate first-focus requests   | 29 screens/components run `useAsync` on mount and immediately call `reload()` on first focus        | Use the existing first-focus-skipping helper; no UI change                                                  |
| 2        | Delivery list pipeline           | Wide delivery rows plus one or more `delivery_items` requests per list load                         | Return a compact list projection containing every value the cards render; fetch full detail on tap          |
| 3        | Full stock matrix                | Several scoped screens download company-wide stock, users, and products, then filter locally        | Add holder-, client-, and summary-scoped reads; cache the global matrix only where it is genuinely required |
| 4        | Realtime-triggered refetches     | A Realtime row arrives, then the app downloads a whole thread/map/list again                        | Patch cached data from a shaped event or invalidate only one keyed query                                    |
| 5        | Bot/review payloads              | Lists include raw WhatsApp text, broad `parse_result`, and full provider debug envelopes            | Return a user-facing projection for lists and details; keep debug payloads available separately             |
| 6        | Polling                          | Some 30-second polls return more data than the badge needs                                          | Keep the same freshness with scalar count RPCs and Realtime invalidation                                    |
| 7        | Dashboard overlap                | Dashboards download operational rows to derive counts and summaries                                 | Add role-safe dashboard snapshot RPCs with the exact aggregates/cards shown today                           |
| 8        | Edge Function internal responses | `normalize-address` returns complete Maps and OpenRouter responses to callers that use three fields | Store debug data, return only match ID/confidence by default                                                |

---

## Implementation status — updated 2026-07-15

Tracks what has actually shipped against the plan below. Every mobile change
passes the CI gates (`tsc --noEmit`, `eslint --max-warnings 0`,
`prettier --check`). **Verified** flags checks beyond the gates (live-DB probes,
the egress logger, a production deploy). **Phases 0–4 are done; Phase 5 is next**
— and Phase 5 is now the *only* remaining work that moves the needle (see below).

All commits through `c514387` are **pushed to `origin/main`**. The live-DB RPCs
(`count_pending_location_changes`, `ops_unread_agent_counts`), the edge-function
redeploy, and the Phase 3 view change are applied to prod.

**Measured trajectory** (admin walk, egress logger): baseline **≈6.5 MB** →
delivery-list burst **527.9 KB / 11 req → 373.7 KB / 7 req** after Phase 3 →
`opsUnreadAgentCounts` **155 kB → 0.0 KB** after Phase 4.1.

**The picture has fully inverted — validated admin walk, 2026-07-15
(733.4 KB session):**

| Line | Session | Share |
| --- | ---: | ---: |
| **`deliveries_admin` (the list)** | **663.2 kB** | **~90%** |
| `preview_eod_rollover` (EOD — newly working, see the Phase 4 bug) | 36.5 kB | 5% |
| `clients` + `users` (cached reference) | 23.8 kB | 3% |
| Everything else — all RPCs, polls, badges, threads | ~10 kB | ~1% |

Every target of Phases 1–4 is now rounding error. **The delivery list is ~90% of
egress**; one load is **279.5 kB**, and a single burst shows `deliveries_admin ×3`
(the main list + the cross-date Postponed and Unassigned queries, each pulling its
own rows). Phase 3 already made the rows as narrow as they can safely go, so what
remains is **row count, not row width** → Phase 5.

⚠️ Note the EOD line is a *new* cost: that screen was "free" only because it was
broken (see Phase 4's `supabase.rpc` bug). Fixing it correctly **added** 36.5 kB.

Realtime websocket egress — previously unmeasured — is now instrumented and
**measured at ~1% of a session** (Broadcast declined on that evidence; see the
Phase 4 measurement note). HTTP remains the whole game.

### Phase 0 — Baseline ✅ done

- Dev-only egress logger `mobile/src/lib/egress-log.ts` — wraps the Supabase
  client fetch, auto-prints per-burst byte tables to the Metro/browser console,
  no-op in production. Commits `e653cf7`, `b70aa92`, `306bc3e`.
- **Baseline captured** → `supabase_egress_baseline_2026-07-13.md`. One admin
  walk ≈ **6.5 MB**. **Verified headline:** the delivery-list path
  (`deliveries_admin` ≈454 KB/load + `delivery_items` ≈122 KB) is **≈75% of
  egress** and refetches on nearly every screen with no cache; reference data
  (users/clients/locations/products) refetched 6–10× each.

### Phase 1 — Zero/very-low UX-risk reductions ✅ done

| Item | Status | Notes |
| --- | --- | --- |
| 1 · First-focus dedupe → `useReloadOnFocus` | ✅ `7269efe` | 26 screens. **Not** migrated (verified unsafe): `MessageThread` (focus effect also fires `markRead()` — skipping first focus stops unread clearing on first open), `FollowupClaimBanner` (focus effect IS its only initial loader), `GlobalMovements`/`Movements` (keyset-pagination loaders — see finding 13). |
| 2 · Dispatcher review rows → `countNeedsReview()` | ✅ `7269efe` | **Verified** in the baseline log: `HEAD bot_inbound_messages` = 0 KB. |
| 3 · `count_pending_location_changes()` scalar RPC | ✅ `dabb33b` + **applied live & verified** | `tools/live-defs/count_pending_location_changes.sql`. **Verified:** grants mirror the list RPC, manager parity holds, non-manager → 0. Mobile keeps a fallback to the old list-count until the RPC is live. |
| 4 · Compact `normalize-address` response | ✅ `4c81094` + **deployed to prod** | Returns `{match_log_id, matched_location_id, confidence}` by default; `include_debug:true` for the full envelopes (already stored in `address_match_log`). **Verified** both callers read only the three fields. |
| 5 · Abort superseded reads | ✅ `dabb33b` | `useAsync` now hands its fn an `AbortSignal` and cancels the prior run on dep-change/unmount/reload; `listDeliveries` (+ its items fetch) forwards it to `.abortSignal()`. |
| 6 · `select('*')` → explicit columns | 🟡 **partly done via Phase 3 item 1; blanket tightening declined** | Where the contract was unambiguous it shipped: `LIST_COLUMNS` is now an explicit 28-column projection (Phase 3 item 1). **Blanket** tightening stays declined — it is only tsc-safe (misses `as any` / out-of-interface reads → silent `undefined`) for ~5–10 kB/session (Phase 3 item 4). `getDelivery` / negative-margin keep `select('*')` **on purpose** (full-detail contract + `margin`). |
| 7 · Duplicate assignment push | ✅ **verified — no change needed** | Live DB: one `notify_assignment_push` trigger → `send_edge_notification` → single `send-notification` call. No legacy `send-assignment-push` path. |

### Phase 2 — Shared stale-while-revalidate cache ✅ done

Infrastructure + reference + delivery-list migrations all landed; `useAsync`
remains (deliberately) for everything scoped to a single screen.

| Increment | Status | Notes |
| --- | --- | --- |
| 2.1 · Infra + `useStatusDefs` | ✅ `6e4f1dc` | `@tanstack/react-query` v5, one app-wide `QueryClient` at the root, `onlineManager`↔NetInfo, `focusManager`↔AppState (native), **cache cleared on sign-out**. `src/hooks/queries.ts` adapts `useQuery` to the `useAsync` `{data,loading,error,reload}` shape (one-line migration). `useStatusDefs()` — staleTime Infinity, global/not-RLS — 5 consumers. |
| 2.2 · `useUsers` | ✅ `03e3c3a` | Keyed `['users', uid, includeInactive]`, 5-min staleTime. Every users mutation invalidates `['users']` centrally in `services/users.ts`. 11 read-only consumers migrated (admin home, RepDashboard, 9 stock screens). Adapter `loading`→`isLoading`. |
| 2.3 · clients / locations / products | ✅ `faf023b` | `useClients` / `useLocations` / `useProducts` / `useActiveProductsByClient` (uid-keyed, 5-min staleTime). Service-level invalidation in `clients`/`locations`/`products.ts`; client (de/re)activation **cascades to products** (invalidates `['products']` + `['products-by-client']`), mirroring the DB. 14 read consumers migrated. |
| 2.4 · delivery list (`deliveries`) | ✅ `0d0f95c` | The 454 KB win. `useDeliveriesList` (role + normalized-filter keyed) + `useUnassignedDeliveries` / `usePostponedDeliveries` / `useAgentPostponed`, all under the shared `['deliveries', uid, …]` PREFIX, 20-s staleTime. `invalidateDeliveries()` (one prefix match) fires from all **18** direct mutation RPCs (`services/deliveries.ts`) **and** the queue drain loop for the 4 delivery-affecting job kinds (`QueueProvider.tsx`), so a queued mark-delivered flips the row the instant the queue drains. Focus is **stale-aware** (`refetchIfStale`) so detail→back within staleTime is a cache hit; pull-to-refresh (`fetching`) still forces a fetch. Filterless default + explicit `{date: today}` normalize to the **same** key so a dashboard and the list share one fetch. Two big list screens migrated (ops `List`, agent `Today`). |
| 2.4b · dashboards + list pickers share the cache | ✅ `265cde3` | The three home dashboards (admin/dispatcher/rep) each fetched today's full `deliveries_admin` list (~418 KB) via their own `useAsync`, so bouncing Home ↔ Deliveries paid the big load **twice**. All three now use `useDeliveriesList(role)` (+ `usePostponedDeliveries` for the rep) → Home and the list collapse to **one** cached today-list fetch per role. The ops list's agent/client filter pickers also moved off raw `useAsync(listUsers/listClients)` onto the cached hooks. No behavior change: same rows, counts, focus-refresh semantics. |

Still on `useAsync` within Phase 2, deliberately (single-screen scope, no sharing
to win): negative-margin (`listNegativeMarginDeliveries`, keeps `select('*')` for
`margin`) and the `DeliveryFieldsForm` agent-filter (`.then`-filter → `useMemo`).

### Phase 3 — Purpose-built query projections ✅ done

Shipped 3 of 7 items; **4 declined on measurement** — each was re-measured
against the post-Phase-2 baseline rather than assumed, and the numbers didn't
justify the work. **Phase 3 is closed.** The declines are a result, not a
backlog: don't reopen them without a new measurement showing the payload grew.

| Item | Status | Notes |
| --- | --- | --- |
| 1 · Compact delivery-list projection | ✅ `5934cdc` + **applied live** | Implemented as a **view extension**, not a new `list_deliveries_v2` RPC — `CREATE OR REPLACE VIEW` appends `activity_at`, `item_count`, `product_label`, `sibling_group_key` to **both** `deliveries_admin` and `deliveries_safe` (additive, backward-compatible; existing role gate unchanged). Lists dropped the per-load `delivery_items` fetch **entirely** and 8 detail-only columns. **Verified** by the logger: 527.9 KB/11 req → **373.7 KB/7 req**. `sibling_group_key` deliberately reproduces the **client's** key (per-row `pid:qty`, string-sorted) not `_delivery_items_sig`, so dashboard unique counts stay identical. `getDelivery` keeps `select('*')` + full items. |
| 2 · Stock scoped queries | ✅ `876c7a3` | `current_stock` is an **unrestricted** view (no row filter), so `listCurrentStock()` shipped every holder's stock to six screens — three of which render one holder/agent/client. Drill-downs now scope: `listHolderStock(agentId)` (available agent detail), `listHolderStock(holderId)` + new ids-only `listStockHolderIds()` (holder detail prev/next), new `listClientStock(clientId)` (client detail). The three genuinely-global screens (Overview, By-client, Agent-stock) share **one** cached `useStockMatrix()` under `['stock']`, invalidated from the queue drain on the 4 stock-affecting job kinds. **No new SQL** — scoped reads filter server-side. Summary RPCs (`stock_by_agent_summary` etc.) proved unnecessary once the matrix was cached + shared. |
| 3 · User-facing bot review projection | ✅ `81ca757` | PostgREST **JSON sub-path projection** (`alias:parse_result->key`, validated over HTTP 200) — the list ships only the 6 keys the card + `reviewReason()` read (`extracted`, `product`, `product_candidates`, `product_matches`, `address`, `location_hint`) and rebuilds a compact `parse_result`, dropping ~1 KB/row × 100 rows of provider envelope. Also dropped `wasender_message_id` / `remote_jid` / `processed_at` (selected, never rendered) and `raw_payload` (fetched by detail, read **nowhere**). `getBotInbound` keeps the FULL `parse_result`. |
| 4 · Compact picker/reference projections | ⏭ **declined — measured** | Phase 2.2/2.3 already cache every picker to one fetch/session. Narrowing their `select('*')` is only **tsc-safe** (misses `as any` / out-of-interface reads → silent `undefined`) and buys ~5–10 KB/session. Risk exceeds reward. |
| 5 · Dashboard snapshot RPC | ⏭ **declined — superseded by 2.4b** | The premise (dashboards download full lists to derive counts) was true at audit time. Since 2.4b they **share** the list cache, so a snapshot RPC would remove no fetch — only re-derive counts already computed from cached rows. |
| 6 · Client-bank reconciliation projection | ⏭ **declined — measured** | `lib/reconcile.ts` does **zero** fetches (pure formatting) and the reconciliation RPCs are already explicit projections. The audit's real target was `clients.select('*')` for bank details, which since 2.3 is fetched **once per session and shared**. Measured: 44 rows × 12 cols ≈ **16 kB**; a compact `client_bank_directory` would save ~8 kB/session. Declined on the same grounds as items 4/5. |
| 7 · Lazy raw message/debug endpoints | ⏭ **declined — measured** | `bot_raw_message` on a **single-row** `getDelivery` measures **avg 224 B / max 766 B** — versus the ~142 KB `delivery_messages` traffic on the same screen (**600×** bigger). The list's raw-message cost (the audit's "13%") was already removed in Phase 1. Would cost a view column + hand-synced 38–41-column role-specific lists replacing `select('*')`. |

**Follow-up fix — `3b25bc4`.** Dropping line items from list rows meant
`BulkMarkDeliveredSheet` had to hydrate them on open. Its `catch` swallowed a
failed fetch and left an empty map, which `submit()` could not distinguish from
"legacy rows that genuinely have no items" — so a failed hydrate fell through to
the legacy `quantity_ordered ?? 1` path and would mark a **multi-line order
delivered as a single unit**, deducting the wrong stock with no error surfaced.
Now the failure is tracked separately: bannered, submit disabled and guarded. A
*successful* fetch returning no items still takes the legacy path.

**Post-cutover verification (Phase 3 item 1).** The dropped-column set was
re-derived mechanically — live view columns diffed against `LIST_COLUMNS` at
`265cde3` vs `HEAD` — rather than recalled: exactly **8** columns dropped
(`customer_phone_alt`, `raw_address`, `quantity_delivered`, `paid`,
`payment_method`, `delivery_instructions`, `latest_message_at`, `assigned_at`).
All 8 confirmed unread on every list path; every read traces to a detail screen
(`getDelivery` → `select('*')`) or a service with its own query
(`listClientRemitDetail`, `available-orders`, `SimilarOpenDelivery`). No
destructuring reads anywhere. No column is selected that the view lacks.

Two known residuals, neither a live bug:

- **Type lie.** 5 of the 8 (`paid`, `payment_method`, `raw_address`,
  `customer_phone_alt`, `quantity_delivered`) are not defensively nulled in
  `attachJoins`, so on a list row they are **`undefined` at runtime while typed
  `T | null`**. Nothing reads them today, but `formatNaira(row.paid)` on a card
  would silently render `₦NaN`. Fix: a `DeliveryListRow = Omit<DeliveryRow, …>`
  return type (~6 files) turns this into a compile error.
- **Dead SQL.** `item_count` was added to both views and never selected —
  `product_label` already produces the "N items" text. Harmless (an unselected
  view column costs nothing), but it is clutter now in prod.

### Phase 4 — Realtime event shaping ✅ done — closed

Full detail (measurements, parity evidence, the `supabase.rpc` bug, the declines,
and the Realtime measurement gap) lives under **Phase 4** in the implementation
plan below. Summary:

| Item | Status | Notes |
| --- | --- | --- |
| 4.1 · grouped + coalesced ops unread map | ✅ `011e03b` + **applied live & validated in-app** | `ops_unread_agent_counts` RPC (SECURITY INVOKER; terminal set derived from `delivery_status_defs`), 250 ms debounce, cached under `['unread']`. **155 kB → 0.0 KB in-app.** ~94% of the old payload was `cant_reach_client` notes the app fetched then discarded — 155 kB to render **1** badge. Parity **0 lost / 0 gained** (incl. a strong pass: 3,044 messages, 18 statuses). Deliberately **not** date-scoped — the list matches this map against cross-date rows. |
| — · `supabase.rpc` unbound | ✅ `7fd74f1` + `c514387` | **4 RPCs never issued a request** — 3 pre-existing and silently dead despite being marked "verified" here (`count_pending_location_changes`, `preview_eod_rollover`, `requeue_failed_inbound`). All confirmed working in-app. One shared `rpcUntyped()` + eslint guard so it cannot recur. |
| 4.x · patch cache from mutations / Broadcast / threads / claims / calls | ⏭ declined or deferred | Every remaining realtime-adjacent line is ≤2.7 KB/burst (<1% of egress). Broadcast (Stage B) targets **websocket** traffic this audit has never measured — see the gap note. |

**Process lesson (now the bar for Phase 5):** "the SQL works" was treated as
"validated". Three already-broken RPCs had cleared exactly that bar. Nothing
counts until it appears in an **in-app egress capture**.

---

## Client-specific delivery-message formats and customer phone

Creating multiple delivery or reconciliation message templates does **not** inherently increase Supabase egress when the app selects a template and formats the message locally. Template branching and `Share.share()` happen on the device.

Adding the customer's phone number has one of two outcomes:

- If the phone number is already present in the delivery/reconciliation response, the new format adds **no Supabase egress**.
- If it is not present, returning that one field adds only the bytes for the phone value and JSON key. The larger mistake would be making a separate query for every row or every share action.

### Efficient solution

Keep the client-specific formats because they improve the recipient's experience. Add the customer phone to the existing role-safe reconciliation/detail projection only for the workflow that needs it, then format all message variants locally.

### Implementation

1. Extend the existing reconciliation/detail RPC projection with `customer_phone` rather than calling a second endpoint.
2. Preserve current RLS and role rules so only authorized users receive the number.
3. Keep phone out of unrelated summary/list responses that neither display nor search it.
4. Select the client format locally using client ID or an explicit format setting.
5. Add a regression test confirming the old formats are unchanged and the approved client's format contains the correct phone.
6. Measure the response before and after; the expected difference should be approximately one short string per included delivery, not another request bundle.

## What Supabase counts as egress

Supabase defines egress as data leaving the platform through the Data API/PostgREST, Realtime, Auth, Edge Functions, Database/Supavisor, and Storage. Supabase explicitly recommends reducing returned fields and entries and reducing unnecessary query frequency.

Official references:

- [All about Supabase Egress](https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e)
- [Selecting specific columns](https://supabase.com/docs/reference/javascript/select)
- [Limiting a query to a range](https://supabase.com/docs/reference/javascript/range)
- [Realtime Postgres Changes and server-side filters](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Realtime Broadcast is recommended for scalability](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [Supabase query optimization](https://supabase.com/docs/guides/database/query-optimization)

Requests sent _to_ Supabase are ingress. A mutation becomes an egress concern through its response and its side effects: Realtime messages, push functions, and follow-up refetches.

## Non-negotiable user-experience contract

Every optimization should satisfy these rules:

- Do not remove a field that is currently displayed.
- Do not replace exact values with estimates.
- Do not make pull-to-refresh less reliable.
- Do not make messages, claims, calls, approvals, or status changes feel less live.
- Do not persist sensitive cross-user data across sign-out.
- Do not weaken RLS or role-specific data boundaries.
- Lists may use compact projections, but tapping a row must still expose the complete detail.
- Raw WhatsApp/provider/debug data may be lazy-loaded only if the user can still access it from the same affordance with a clear loading state.
- Cached data should render immediately while a quiet background refresh verifies freshness.
- Mutation responses should update the interface immediately; reconciliation refetches are a safety mechanism, not the primary UI response.

## Scope and measurement limitation

This is a static code-path audit. It identifies every discovered source of Supabase egress in the repository and ranks it by payload width, number of rows, frequency, and fan-out. It cannot determine actual monthly gigabytes because request counts, connected devices, and production response sizes are not stored in Git.

Before and after each implementation phase, capture:

- Supabase Billing usage for uncached egress.
- Logs Explorer / API “Top Paths.”
- Requests per screen opening.
- Approximate JSON response bytes per named service call.
- Time to first useful content.
- Time until background refresh completes.
- Realtime event-to-visible-update latency.

A development-only wrapper can record `JSON.stringify(data).length` for each service result. It is not exact wire size, but it provides a consistent before/after comparison without cloning response bodies in production.

---

## Detailed findings and efficient solutions

## 1. Duplicate initial loading on 29 screens/components

### What is happening

`mobile/src/hooks/useAsync.ts` automatically executes its function in `useEffect`. Twenty-nine screens/components also use a direct `useFocusEffect(...reload...)`. Navigation focus fires on initial mount, so the same request bundle runs twice.

The repository already contains `mobile/src/hooks/useReloadOnFocus.ts`, whose documented purpose is to skip the first focus while retaining refresh-on-return.

Affected surfaces found in the audit:

- Agent: earnings, Today, delivery detail.
- Rep: reconciliation summary and client detail.
- Admin: home, EOD, flags, negative margin, rep performance, reconciliation summary/detail, and five catalog lists.
- Operations: dispatcher dashboard, rep dashboard, delivery list/detail, review, available-orders overview/detail, and location approvals.
- Stock: By Client, Agent Stock, Global Movements.
- Shared delivery message thread.

### Why the data matters

All data remains important. The problem is not the payload; it is downloading the identical payload twice before the user can interact with it.

### Efficient solution

Replace only the direct first-focus reload pattern with the existing `useReloadOnFocus` helper. Keep:

- Initial `useAsync` fetch.
- Refresh when returning from another screen.
- Pull-to-refresh.
- Explicit reloads after mutations.
- Realtime-driven updates.

### Implementation

For one query:

```tsx
const query = useAsync(loadData, deps);
useReloadOnFocus(query.reload);
```

For a query bundle:

```tsx
useReloadOnFocus(() => {
  deliveriesQ.reload();
  issuesQ.reload();
  unreadQ.reload();
});
```

Migrate in small groups and verify the network log shows one initial bundle, not two.

### Expected impact

Up to approximately 50% less first-open egress for the affected screen bundles. It should also remove competing requests and reduce loading flicker.

### UX verification

- First open still loads once automatically.
- Navigating away and back refreshes.
- Pull-to-refresh still refreshes.
- A post-mutation screen still reflects the mutation immediately.

## 2. `useAsync` ignores obsolete responses but does not cancel requests

### What is happening

`useAsync` uses a sequence counter to ignore an old result after a newer request starts. The old network request continues and its response bytes still leave Supabase.

This is especially relevant to the delivery search, which starts a query after a 300 ms debounce. Typing several terms can produce several full delivery-plus-items responses even though only the final term is rendered.

### Why the behavior matters

The 300 ms responsive search experience is valuable and should remain.

### Efficient solution

Cancel superseded queries rather than increasing the debounce enough for the interface to feel sluggish.

### Implementation

- Accept an `AbortSignal` in read services such as `listDeliveries`.
- Apply Supabase's query abort signal to the builder.
- Abort the previous controller when dependencies change or the component unmounts.
- If TanStack Query is adopted, use the `signal` passed to each query function.
- Keep the current 300 ms debounce unless production measurement shows it is too aggressive.

### Expected impact

Eliminates most response transfer from obsolete searches and rapid filter/date changes while preserving input responsiveness.

### UX verification

- Results never flash an older term.
- Typing responsiveness stays the same.
- Canceled requests do not produce visible error banners.

## 3. The delivery list returns detail-shaped data

### What is happening

`mobile/src/services/deliveries.ts` uses a relatively wide `LIST_COLUMNS` projection and then calls `fetchDeliveryItemsFor`. Large result sets are split into 100-ID item-query chunks. The code comments record that an uncapped historical load once reached roughly 4 MB plus line items and that raw bot text previously accounted for about 13% of list payload.

The current list cards mainly need:

- IDs used for navigation/filtering.
- Customer name.
- Client/product/location/agent display names.
- Status and scheduled date.
- Customer price or agent earning where role-appropriate.
- Latest activity/notified/message indicators.
- Rollover display fields.
- A compact product label (`one product name` or `N items`).
- A sibling-group identity for unique-order counts.

Several list columns are detail-oriented or invisible on the cards, including full address, alternate phone, instructions, payment fields on many roles, and full line-item objects.

### Why the data matters

Users need fast status scanning, customer identification, product context, prices, filters, search, notification state, and accurate unique-order counts. Those must remain.

### Efficient solution

Create a dedicated role-safe list RPC or view that returns exactly the card contract. Keep `getDelivery()` as the full-detail contract.

Recommended list fields:

```text
id
client_id, client_name
assigned_agent_id, assigned_agent_name
location_id, location_name
customer_name
customer_phone only where current role/search behavior requires it
current_status, scheduled_date, created_at
activity_at
customer_price or agent_payment_snapshot according to current visibility
latest_history_id, latest_notified, has_unread_message
rolled_from_status, rolled_from_date, rollover_count
order_type
product_label
item_count
sibling_group_key
```

Compute server-side:

- `activity_at = greatest(created_at, latest_changed_at, latest_message_at, assigned_at)`.
- `product_label` and `item_count` from `delivery_items`.
- A non-sensitive `sibling_group_key` so dashboards do not need full phone/address merely to collapse siblings.

### Implementation

1. Define a `DeliveryListRow` type separate from `DeliveryRow`.
2. Add `list_deliveries_v2(...)` with date/search/cursor parameters and the same role/RLS behavior as the current views.
3. Aggregate line-item display metadata inside the RPC.
4. Change list cards and dashboards to consume `DeliveryListRow`.
5. Leave detail screens on `getDelivery()`.
6. Compare old and new card rendering side by side in QA before cutover.

Do not remove customer phone from an authorized search path until the replacement RPC proves phone search returns the same results. A small phone value is less important than preserving search behavior and role boundaries.

### Expected impact

- Fewer fields per delivery.
- No separate item request/chunks for lists.
- Less sensitive data on devices that do not render it.
- Faster list first content.

### UX verification

- Same cards in the same order.
- Same status/filter counts.
- Same name and phone search results.
- Same sibling-collapsed unique counts.
- Tapping a card still shows complete address, phones, instructions, raw message, payments, and item detail.

## 4. Dashboards download operational rows to calculate summaries

### What is happening

Admin, dispatcher, and rep dashboards load full delivery lists and derive counts/workloads locally. The dispatcher dashboard also calls `listBotInbound('needs_review', 100)` only to use `.length`, while the layout already has a lightweight needs-review count poll.

### Why the information matters

Dashboard totals, workloads, recent activity, issues, available-order summaries, and approval badges are high-value operational information.

### Efficient solution

Return a dashboard-shaped snapshot instead of reconstructing the dashboard from full operational rows.

Suggested `ops_dashboard_snapshot(p_date date)` result:

- Exact status counts and unique-order total.
- Per-agent workload aggregates used by `AgentWorkloadCard`.
- The same recent-activity card projection and current limit.
- Needs-review count.
- Unassigned count.
- Negative-margin count for admin.
- Pending location-change count for managers.
- Available-order agent/unit totals for dispatcher.

Keep actionable issue rows as rows because the dashboard displays their content.

### Implementation

- First, replace dispatcher `listBotInbound(...100).length` with `countNeedsReview()`.
- Then introduce a snapshot RPC per role or one role-aware RPC.
- Preserve RLS/role gating in the function; never accept an arbitrary role from the client as authority.
- Cache by `userId + role + Lagos date` and invalidate on relevant mutations/Realtime events.

### Expected impact

The count-only change reduces the review portion from as many as 100 wide rows to one scalar. A full snapshot avoids downloading every delivery solely to show aggregates and a short recent list.

### UX verification

- All dashboard numbers exactly match the current implementation on the same database snapshot.
- Recent activity contains the same rows and ordering.
- Tapping every dashboard card lands on the same filtered destination.

## 5. Full stock matrix is used by scoped screens

### What is happening

`listCurrentStock()` performs up to three reads:

1. Every row from `current_stock`.
2. Matching users.
3. Matching products and clients.

The global matrix is appropriate for the main stock overview, but it is also used by screens that ultimately show one agent, holder, or client:

- Available-order agent detail.
- Holder detail.
- Client detail.
- Agent stock list.
- By-client list.

### Why the information matters

Users need exact quantities, low/negative warnings, product/vendor search, previous/next holder navigation, allocation gaps, and shareable client summaries.

### Efficient solution

Create queries shaped to each user task:

| Surface                | Efficient contract                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Global stock overview  | Keep one global matrix, but return joined display fields in one RPC/view and cache it |
| Available agent detail | `listAvailableOrders(agentId)` plus `listHolderStock(agentId)`                        |
| Holder detail          | `listHolderStock(holderId)` plus cached compact holder roster                         |
| Agent stock list       | Server-side per-agent totals/warning counts plus optional compact search text         |
| By-client list         | Server-side per-client/product totals                                                 |
| Client detail          | `listClientStock(clientId)` across holders plus active zero-stock products            |
| Agent “My stock”       | Keep existing holder-scoped path                                                      |

For previous/next holder navigation, download a compact roster of holder IDs and names, not every holder's stock.

### Implementation

Add functions such as:

```text
list_stock_matrix()
list_holder_stock_v2(holder_id)
list_client_stock(client_id)
stock_by_agent_summary()
stock_by_client_summary()
list_stock_holders()
```

Return the same names/quantities currently assembled in JavaScript. Apply current anti-poaching and warehouse/agent visibility rules server-side.

### Expected impact

Scoped screens change from `O(all holders × all products)` transfer to `O(relevant holder/client)`. The global overview still receives all required information.

### UX verification

- Same totals and warning counts.
- Same zero-stock active products on client detail.
- Same search behavior.
- Previous/next holder navigation remains instant; optionally prefetch adjacent holder stock.
- Share messages remain byte-identical.

## 6. No shared query cache or in-flight request deduplication

### What is happening

`useAsync` stores data only inside one mounted component. Two screens asking for the same users, locations, status definitions, deliveries, or stock create independent requests. Returning to a recently visited screen often discards immediately useful data and shows another loading state.

The project currently has no TanStack Query/SWR dependency. It already has `@react-native-community/netinfo`, which can support network-aware query behavior.

### Why the information matters

Freshness matters, especially for deliveries, messages, stock, and claims. A cache must improve responsiveness without silently serving stale operational data.

### Efficient solution

Adopt stale-while-revalidate with in-memory, role/user-partitioned query keys. TanStack Query is the recommended long-term implementation because it provides:

- Shared query cache.
- In-flight promise deduplication.
- Stale times.
- Background refetch.
- Explicit invalidation after mutations.
- Query cancellation.
- Infinite-query support.
- React Native focus and NetInfo integration.

Official references:

- [TanStack Query important defaults and stale time](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- [TanStack Query React Native integration](https://tanstack.com/query/latest/docs/framework/react/react-native)
- [Invalidation after mutations](https://tanstack.com/query/v5/docs/react/guides/invalidations-from-mutations)

### Implementation

Recommended query-key policy:

```text
['profile', userId]
['users', userId, role, includeInactive]
['clients', userId, role, includeInactive]
['locations', includeInactive]
['products', clientId, includeInactive]
['status-defs']
['deliveries', userId, role, filters]
['delivery', userId, role, deliveryId]
['delivery-messages', userId, deliveryId]
['stock-global', userId, role]
['stock-holder', userId, role, holderId]
['reconcile-client', userId, role, clientId, from, to]
```

Suggested freshness policy:

| Data                             | Suggested `staleTime` | Invalidation                                                       |
| -------------------------------- | --------------------: | ------------------------------------------------------------------ |
| Status definitions/transitions   |              Infinity | App release/schema change                                          |
| Locations/products/clients/users |          5–15 minutes | Explicit catalog mutation; background refresh on focus when stale  |
| Delivery lists/dashboard         |         15–30 seconds | Delivery/message/assignment mutations and targeted Realtime events |
| Delivery detail/thread/claims    |          0–15 seconds | Targeted Realtime event or mutation response                       |
| Reconciliation historical ranges |           1–5 minutes | Settlement/payment/status mutation affecting range                 |
| Live stock                       |         15–30 seconds | Stock/delivery mutation and targeted event                         |

Use memory-only caching initially. Clear the complete query cache on sign-out so sensitive data cannot cross accounts. Do not persist delivery/customer data to AsyncStorage unless there is a separate security review.

Keep pull-to-refresh by calling `refetch()`. Render cached data while `isFetching` refreshes quietly; reserve the blocking spinner for a genuine no-data first load.

### Expected impact

Reduces repeated reference-data loads, duplicate dashboard/list loads, and back-navigation reloads while improving perceived speed.

### UX verification

- Returning to a screen displays its last data immediately.
- A background refresh updates changed values.
- Pull-to-refresh always performs a network request.
- Signing out clears all cached business data.
- Another user's data never appears during account switching.

## 7. Realtime events commonly trigger whole-query refetches

### What is happening

Current subscriptions include:

- Global delivery-message changes for agent unread state.
- Global delivery-message changes for the operations delivery list.
- Per-delivery message-thread changes.
- Global follow-up changes for the operations list.
- Per-delivery follow-up changes.
- Per-delivery client-notification changes.
- Incoming/outgoing call changes.

For messages/follow-ups/notifications, callbacks usually ignore the changed row and refetch a complete map or thread. One database change can therefore produce the Realtime payload plus multiple PostgREST responses on the same device, multiplied by every connected device.

### Why live behavior matters

Message badges, threads, follow-up ownership, notification ticks, and calls must remain immediate.

### Efficient solution

Patch or invalidate only the smallest affected dataset, then move high-fan-out subscriptions to shaped private Broadcast events once their authorization and reconnect behavior are proven.

### Implementation

Use a two-stage approach.

#### Stage A: targeted invalidation and cache patching

- Give every dataset a stable query key.
- A per-delivery event invalidates only that delivery/thread/claim.
- Use mutation return rows (`reply_to_delivery`, `claim_followup`, `mark_client_notified`) to patch the cache immediately.
- Debounce/coalesce repeated invalidations for the same key over 100–300 ms.
- If five messages arrive together, perform at most one safety refetch.

#### Stage B: shaped private Broadcast events

Supabase recommends Broadcast for scalable database changes. Add triggers that publish the exact UI event to private topics:

```text
delivery:{delivery_id}:messages
delivery:{delivery_id}:followup
delivery:{delivery_id}:notifications
user:{user_id}:unread
ops:unread
call:{call_id}
```

The event should contain only what the app needs to patch its cache, such as a shaped message row with author display name or `{delivery_id, unread_count}`. Authorization policies on `realtime.messages` must mirror current RLS visibility.

The installed Realtime client currently exposes table/event/filter but not a high-level column-selection option, so Broadcast is safer than assuming protocol-level projection is available through the current client API.

### Expected impact

Changes the common path from “event + full refetch” to “small event + local patch,” while keeping or improving latency.

### UX verification

- A remote message appears immediately in an open thread.
- Unread badges increment/clear correctly.
- Two operators claiming the same follow-up still see first-writer/takeover behavior.
- Reconnect/foreground performs a safety reconciliation so missed events cannot leave stale state.

## 8. Unread maps return rows instead of grouped counts

### What is happening

`agentUnreadCounts()` and `opsUnreadAgentCounts()` download qualifying message rows and group them into `delivery_id -> count` maps in JavaScript. Operations unread is not date-scoped because it is matched against visible list rows later.

### Why the information matters

Per-delivery badge counts and the total agent badge are valuable and should remain exact.

### Efficient solution

Create role-safe RPCs that perform `GROUP BY delivery_id` in Postgres and return one row per delivery:

```text
delivery_id, unread_count
```

Keep the same filters for author role, terminal deliveries, auto-seeded issue types, and `not_my_route` handling. The app should not reimplement those rules differently.

### Implementation

- Add `agent_unread_message_counts()` and `ops_unread_agent_counts(p_exclude_not_my_route boolean)`.
- Return only grouped rows.
- Later, patch these cached counts from shaped Broadcast events.
- Retain a foreground safety fetch.

### Expected impact

Transfer becomes proportional to the number of deliveries with unread messages, not the number of unread messages.

### UX verification

Compare old and new maps for the same user/database snapshot, including terminal rows and every issue type.

## 9. Thirty-second polling can be made smaller without becoming less fresh

### What is happening

Three notable polls exist:

- Needs-review count: efficient HEAD count every 30 seconds.
- Pending location-change count: calls `listLocationChanges(['pending'])`, returning up to 200 wide joined rows only to use `.length`.
- Agent unread counts: full qualifying message rows every 30 seconds, plus Realtime and foreground refresh.

### Efficient solution

Retain the current refresh cadence where it protects freshness, but make each poll return only the scalar or grouped result the badge needs. Lengthen safety polling only after Realtime recovery is proven.

### Implementation

#### Needs review

Keep the count request until a reliable Broadcast replacement is proven. It is already small. Remove duplicate count/list calls on dashboards.

#### Pending location changes

Add a scalar RPC:

```sql
create or replace function public.count_pending_location_changes()
returns bigint
language sql
stable
security definer
set search_path to 'public', 'auth'
as $fn$
  select count(*)
  from public.delivery_location_changes
  where public.is_manager()
    and state = 'pending';
$fn$;
```

Grant only to the same authenticated roles/callers as the existing list RPC. Keep the 30-second interval initially, so freshness is identical while payload falls to one integer.

#### Agent unread

After grouped RPC and reliable Realtime/Broadcast are in place, use Realtime for immediacy and extend the safety poll to 2–5 minutes plus foreground. Do not lengthen the poll before missed-event recovery is tested.

### Expected impact

The pending-approval badge changes from as many as 200 joined records every 30 seconds to one scalar. Freshness remains identical.

## 10. Review lists ship raw/debug-heavy data

### What is happening

The bot review list returns up to 100 rows including:

- Full `raw_text`.
- Broad `parse_result` JSON.
- Error and processing metadata.

`parse_result` can contain product candidate arrays, vendor classifications, dropped gifts, and the full `extraction_raw` provider response. The list UI renders a much smaller human-facing subset. Full raw text appears only after expanding non-actionable cards; actionable needs-review rows navigate to detail instead.

The detail query additionally retrieves the original webhook `raw_payload`, although the correction form primarily uses original text plus extracted fields.

### Why the information matters

Reviewers need the exact original order, extracted customer/phone/address/products, match reason, error, and ability to inspect unusual cases. Debug records are also useful for engineering investigations.

### Efficient solution

Create two explicit contracts:

1. **User-facing review projection** for lists and correction UI.
2. **Engineering debug payload** fetched only from a diagnostic affordance.

### Implementation

Recommended review-list fields:

```text
id, status, received_at, delivery_id, error_text
customer_name, customer_phone, raw_address
primary_product_name, client_name, quantity, customer_price
location_confidence, review_reason
has_raw_text
raw_text_preview (optional)
```

Extract these fields in SQL from `parse_result`, or persist a compact user-facing parse block separately. Keep the original `raw_text`, `raw_payload`, provider response, and full candidate arrays stored and retrievable.

For non-actionable list expansion, fetch full raw text on tap. To avoid perceived delay:

- Start the request on `onPressIn`.
- Cache it by inbound ID.
- Open the existing expansion immediately with a small inline skeleton.
- Detail navigation can prefetch before the transition completes.

### Expected impact

Review-list egress becomes based on the data actually rendered rather than complete provider/debug envelopes. Users retain access to all information.

### UX verification

- Same review reason and card values.
- Original full message remains accessible from the same card/detail flow.
- Correction form is prefilled identically.
- Engineering debug payload remains available to authorized users.

## 11. Full raw messages are downloaded with delivery detail before expansion

### What is happening

`getDelivery()` uses `select('*')`. For admin detail this includes `bot_raw_message`, even though the raw-message card is collapsed initially. Available orders already use the better pattern: a `has_raw_message` flag in the list and a one-row raw-text fetch when the user opens it.

### Why the information matters

The original order is important for dispute resolution and operational context.

### Efficient solution

Apply the existing available-order pattern to delivery detail:

### Implementation

- Detail RPC returns `has_raw_message` but not full text.
- `getDeliveryRawMessage(deliveryId)` fetches the text when expanded.
- Cache it for the rest of the session.
- Optionally prefetch on press-in.

Do not apply this to fields that are immediately visible on detail. The objective is to make the detail screen faster, not to fragment ordinary content.

### UX verification

- The collapsed card renders immediately.
- First expansion shows a clear inline loading state and then complete verbatim text.
- Subsequent expansion is instant.
- Manual orders still show the existing “no original message” state without a request.

## 12. Reconciliation payloads are important and should remain complete

### What is happening

Reconciliation summary/detail RPCs return every delivered row in the selected range. Client and rep detail screens use the result both for display and for complete WhatsApp share messages. Pagination could accidentally produce incomplete reports if only loaded pages were shared.

The screens also have duplicate first-focus requests. Admin reconciliation additionally loads full client rows for bank details.

### Why the information matters

Financial correctness and complete client reports are more important than small egress savings.

### Efficient solution

Keep reconciliation complete and exact while removing duplicate reads and over-wide supporting catalog queries.

### Implementation

- Do **not** paginate the share source unless the server builds the complete share/report independently.
- Eliminate duplicate first-focus requests.
- Cache results by client/date range/role and show cached data while refreshing.
- Keep the current explicit RPC projections; add customer phone only to the approved client format if required.
- Add a compact `client_bank_directory` RPC returning only fields used by reconciliation rather than `clients.select('*')`.
- If very large ranges become common, let the server build the full export/share dataset while the UI pages only rendering; the share action must still use all rows.

Client-specific message formatting and `Share.share()` are local and do not create Supabase egress. Only fields fetched to build the message do.

### UX verification

- Totals match exactly.
- Every delivery remains in the shared report.
- Existing share messages are byte-identical except intentional new client formats.
- Settlement state and bank details remain current after mutation invalidation.

## 13. Stock-movement pagination is already directionally correct

### What is happening

Holder and global movement feeds use keyset pagination with 50-row pages. This prevents complete-history downloads and is a good existing pattern. Remaining waste comes from duplicate first focus, refetching the first page after navigation, and reloading reference filters.

### Efficient solution

Keep the existing keyset-pagination experience and add shared page caching, request cancellation, and precise mutation invalidation.

### Implementation

- Preserve keyset pagination.
- Move feeds to an infinite-query cache keyed by all filters.
- Keep loaded pages and scroll position when opening a delivery and returning.
- Cancel an in-flight page when filters change.
- Cache actor/counterparty/product/client/holder filter lists.
- Invalidate only affected holder/client feeds after stock mutations.

### UX verification

- No duplicated or skipped movement rows at page boundaries.
- Back navigation restores the exact scroll position immediately.
- Pull-to-refresh replaces the first page and safely resets the cursor.

## 14. Catalog and reference tables are repeatedly downloaded

### What is happening

Users, clients, products, locations, status definitions, transitions, and rate data are requested independently by many forms and screens. Several use `select('*')` even where a picker needs only ID/name/active status.

### Why the information matters

Pickers must be complete and changes made by administrators must propagate reliably.

### Efficient solution

Separate compact picker/list projections from full detail queries and reuse them through a shared in-memory cache.

### Implementation

- Use compact picker projections (`id`, display label, required relationship IDs).
- Keep full detail queries for catalog detail screens.
- Share an in-memory cache across screens.
- Assign long stale times to status definitions and moderate stale times to catalogs.
- Explicitly invalidate the appropriate cache after create/update/deactivate/reactivate.
- Background-refresh stale catalogs on focus; never replace visible cached picker options with a blocking spinner.

### UX verification

- Every option currently available remains available.
- Newly created/deactivated records update immediately after mutation.
- Cross-device changes appear on a later focus/background refresh within the documented freshness window.

## 15. Calls are low-volume but one subscription is broader than necessary

### What is happening

Incoming/outgoing calls use filtered Realtime subscriptions and full call rows, which are appropriate for call coordination. The ops-team UPDATE subscription is intentionally unfiltered so it can observe a row leaving `callee_audience = ops_team`; every ops device can therefore receive unrelated call updates and discard them locally. Incoming call presentation also performs a separate caller-name query.

### Efficient solution

Preserve the current call path until higher-value work is complete; later, replace the broad invitation subscription with authorized shaped events.

### Implementation

- Keep current behavior until higher-impact work is complete.
- Later, broadcast call state to `call:{id}` and the active ops invitation topic.
- Include `caller_name` in the shaped invite event to remove the extra user lookup.
- Keep the complete call row in the active call cache because Agora coordination needs it.

### UX verification

Ringing, first-accept-wins, peer dismissal, decline, cancel, expiry, and reconnection must be tested on multiple devices before replacing the current subscription.

## 16. Mutation responses and offline queue traffic

### What is happening

Most write requests return small IDs/counts or no row. Some return complete useful rows: messages, claims, client-notification tags, settlements, and calls. The offline queue may retry requests after reconnection. Mutations often trigger an explicit reload even when the returned record already contains the new UI state.

### Efficient solution

Keep durable/idempotent writes, but use successful mutation results as the immediate UI update and coalesce redundant safety reloads.

### Implementation

- Keep idempotency keys and offline retries; they protect user experience and data integrity.
- Use returned rows to update cache immediately.
- Invalidate/refetch only related keys as a background reconciliation.
- Do not call both an explicit reload and a Realtime-triggered reload for the same mutation; coalesce them.
- Record retry attempt counts so a failing job cannot generate an unbounded response loop.

### UX verification

- Optimistic UI rolls back correctly on permanent failure.
- Successful queued actions appear once, never duplicated.
- Reconnection reconciles with server truth.

## 17. Edge Function bot and address pipeline

### What is happening

The backend can generate egress without an open app:

- Main order extraction sends prompts/order text to OpenRouter.
- Vendor classification can send a second prompt on cross-vendor ties.
- Address normalization sends requests to Google Maps and OpenRouter.
- The in-house study bot sends a separate extraction and address normalization for its stream.
- Push notifications send payloads to Expo.
- Auth emails send content to Resend.
- Scheduled jobs and database triggers invoke functions.

The main parser stores complete `extraction_raw` provider responses inside `parse_result`. `normalize-address` stores full Maps/OpenRouter responses in `address_match_log`, which is good for diagnostics, but also returns those full responses to bot callers that only use:

```text
match_log_id
matched_location_id
confidence
```

### Why the processing matters

Extraction and location accuracy directly affect delivery quality. Prompts and candidate context should not be shortened blindly to save bandwidth.

### Efficient solution

Reduce invisible internal response payloads and duplicated processing while preserving extraction, address-matching, diagnostics, and notifications.

### Implementation

#### Safe immediate change: compact normalization response

Keep complete debug data in `address_match_log`. Return only the three fields by default. Add an internal/admin-only `include_debug` option if a diagnostic caller genuinely needs the raw provider envelopes.

#### Safe cache opportunities

- Cache successful extraction by sanitized message fingerprint, but rerun agent resolution, product availability, and duplicate/delivery creation logic.
- Reuse high-confidence location matches for the same normalized address, with a location-catalog version or invalidation when aliases change.
- Keep current deterministic location short-circuit and vendor-classifier-on-tie behavior.

#### Study bot

Do not disable it merely for egress. Establish whether its comparison objective is still active. If the study is complete, decide explicitly whether to cut over, reduce sampling, or retire it. Sampling a percentage of messages can preserve quality monitoring with less duplicated AI traffic.

#### Push functions

The generic `send-notification` already batches up to 100 tokens and prunes dead tokens. Verify in the live database that the legacy `send-assignment-push` trigger is not also firing alongside the generic assignment notification. Preserve all user-visible notifications; remove only proven duplicate delivery paths.

### Expected impact

- Compact normalization response can reduce each internal function response from several KB to a few hundred bytes.
- Fingerprint caching avoids repeated AI request payloads for duplicate forwards and improves processing time.
- Retiring a duplicate legacy push or completed study path eliminates whole duplicate operations without changing app screens.

### UX verification

- Backtest extraction and location results against the existing corpus.
- Compare delivery creation/needs-review outcomes before and after caching.
- Ensure every assignment/status/message/call notification still arrives exactly once.

## 18. Auth, profile, push-token, and email processes

### What is happening

Auth session refresh, profile resolution, sign-in, password/email changes, push-token registration, and auth email responses all create small amounts of egress. The profile resolver retries with exponential backoff during outages.

### Efficient solution

These are low-priority and largely correct:

### Implementation

- Keep automatic token refresh.
- Keep profile retry/backoff; it protects users during outages.
- Keep push-token “write only when changed.”
- Select only profile columns used by `AuthProvider` instead of `users.select('*')` once `warehouse_id` is represented in generated types.
- Preserve blocked placeholder-domain email behavior.

Do not trade authentication reliability for minor egress savings.

## 19. Supabase Storage is not currently a contributor

No Supabase Storage upload/download calls were found in the mobile application. Expo application updates and local AsyncStorage are not Supabase Storage egress.

### Efficient solution

No change is recommended. Avoid adding Storage-specific caching or compression work unless future usage measurements show that the app begins transferring files through Supabase Storage.

### Implementation

- Keep Storage out of the optimization backlog for now.
- If file features are introduced later, measure download frequency and asset sizes before choosing CDN cache-control, image transformation, or client caching policies.

---

## Recommended implementation plan

## Phase 0 — Baseline and UX contracts ✅ done (see Implementation status)

1. Capture seven days of Supabase API egress and Top Paths if time permits; otherwise capture at least one normal operating day.
2. Add development/staging response-size logging by service name.
3. Record request counts for these journeys:
   - App login → dashboard.
   - Dashboard → delivery list → detail → back.
   - Search by customer name and phone.
   - Agent Today → delivery → message thread.
   - Stock overview → holder → back → client.
   - Review list → correction detail.
   - Reconciliation → client detail → share.
4. Save golden JSON/card/share outputs for representative roles and multi-product deliveries.

## Phase 1 — Zero/very-low UX-risk reductions ✅ done (item 6 resolved in Phase 3: explicit list columns shipped, blanket `select('*')` tightening declined; see Implementation status)

1. Replace the 29 direct first-focus reloads with `useReloadOnFocus`.
2. Replace dispatcher dashboard review rows with `countNeedsReview()`.
3. Add `count_pending_location_changes()` and keep the same 30-second cadence.
4. Return compact `normalize-address` responses by default.
5. Add abort/cancellation to debounced delivery searches and filter-driven queries.
6. Replace `select('*')` with explicit fields where the screen contract is already unambiguous.
7. Verify legacy assignment push is not duplicated in the live trigger configuration.

These changes should be shipped first because they remove waste without altering data availability.

## Phase 2 — Shared stale-while-revalidate cache ✅ done (2.1–2.4b — reference data, delivery lists, and dashboards all share one cache; see Implementation status)

1. Add TanStack Query and a root `QueryClientProvider`.
2. Connect `onlineManager` to the already-installed NetInfo package.
3. Connect `focusManager` to React Native AppState.
4. Migrate static/reference queries first.
5. Migrate deliveries, detail, stock, review, and reconciliation incrementally.
6. Preserve pull-to-refresh as explicit `refetch()`.
7. Use memory-only cache and clear it on sign-out.
8. Add mutation invalidation/update rules before removing manual reloads.

## Phase 3 — Purpose-built query projections ✅ done — closed (3 shipped, 4 declined on measurement; see Implementation status)

Implemented in this order:

1. ✅ Compact card projection with product label/signature — shipped as a **view
   extension** rather than a `list_deliveries_v2` RPC (additive `CREATE OR REPLACE
   VIEW`; same role gate; less surface than a new RPC).
2. ✅ Stock scoped queries — **without** the proposed summary RPCs, which caching
   made unnecessary.
3. ✅ User-facing bot review projection.
4. ⏭ Compact picker/reference projections — declined (~5–10 kB/session, tsc-unsafe).
5. ⏭ Dashboard snapshot RPC — declined (superseded by 2.4b cache sharing).
6. ⏭ Client-bank reconciliation projection — declined (~8 kB; the 2.3 cache
   already reduced it to ~16 kB once/session).
7. ⏭ Lazy raw message/debug endpoints — declined (measured **224 B**).

The general lesson: **re-measure each item against the post-Phase-2 baseline
before building it.** Caching removed the premise of items 4, 5, and 6, and item
7's payload turned out to be 600× smaller than the line it sat next to. Four of
seven audit items were dissolved by earlier phases rather than implemented.

Each new endpoint ran in parallel with the old implementation in development, comparing normalized results before UI cutover.

## Phase 4 — Realtime event shaping ✅ done — closed (4.1 shipped + validated in-app; rest declined on measurement)

Measurement narrowed this phase to essentially **one query**, and killing it
closed the whole category. `delivery_messages` was the #1 remaining line
(~570 KB/burst) and was almost entirely `opsUnreadAgentCounts()`:

| Filter stage (measured live 2026-07-15) | rows | deliveries |
| --- | ---: | ---: |
| Unread agent messages — what shipped per call | **1,122** (≈**155 kB**) | 1,076 |
| After the terminal filter only | 56 | 53 |
| After the auto-seeded filter only | 62 | 53 |
| **After both — what the badge actually shows** | **2** | **1** |

**~94% of the payload was `cant_reach_client`** (1,060 rows) — auto-seeded
soft-fail notes the app fetched and then explicitly discarded. 155 kB over the
wire to render **one badge**.

Worse than finding #7 describes, the trigger was an **unfiltered whole-table
subscription**, and `markRead()` flips `read_at` one row at a time, so opening a
5-message thread emitted 5 events → 5 × 155 kB × every connected ops device. It
was self-amplifying: **reading messages generated the traffic**.

Scope was smaller than the audit assumed: `agentUnreadCounts()` returns **1 row**
today (already date-scoped — left alone), and threads are small (avg **2.7**
messages, max 32). One query, not a domain.

### Phase 4.1 — the ops unread map ✅ `011e03b` + **applied live & validated in-app**

1. **Grouped RPC** — `tools/live-defs/ops_unread_agent_counts.sql`, applied to
   prod. `GROUP BY delivery_id` with the terminal / auto-seeded / `not_my_route`
   filters in Postgres. **SECURITY INVOKER**, so the caller's existing RLS on
   `delivery_messages` + `deliveries` applies exactly as before — no new gate, no
   escalation. The terminal set is **derived** by joining `delivery_status_defs`
   (`category='terminal'`), verified to match the app's `TERMINAL_STATUSES`
   (theme.ts) exactly — all 11 — so a status reclassification can never silently
   desync it.
2. **Coalesced realtime handler** — 250 ms trailing debounce (finding 7's
   100–300 ms window).
3. **Cached** under `['unread']` so `List` + `RepDashboard` share one fetch;
   `invalidateOpsUnread()` after `markRead` keeps the chip instant.

**NOT date-scoped, deliberately.** A `p_date` param was built and then removed:
the list merges CROSS-DATE rows into what's on screen (a postponed order appears
on its postpone day while its `scheduled_date` is already bumped **forward**;
Unassigned is date-independent by design) and the chip is `allRows ∩ map`, so
scoping would have silently stripped those chips. It also bought nothing — the
filters already take 1,122 → 1.

**Verification** (the standard this phase had to learn the hard way — see below):

- **Parity, same-transaction / same-role / real RLS**: admin, dispatcher, rep —
  **0 badges lost, 0 gained**.
- **Strong parity** (the live snapshot had only 1 badge, so agreeing on one row
  proves little): lifting the `read_at` restriction pushed **3,044 agent messages
  across 18 distinct statuses** through both implementations — 19 deliveries each,
  **0 lost, 0 gained**.
- **Security, by calling it as each role**: admin/dispatcher/rep → the badge;
  agent → 0 rows (RLS boundary holds); anon → 0 rows over the real PostgREST path
  (note: Postgres grants `EXECUTE` to `PUBLIC` by default on new functions, which
  is harmless under INVOKER — confirmed empirically, not assumed).
- **In-app, the only test that counts**: `POST rpc/ops_unread_agent_counts ×1
  **0.0 KB**`. 155 kB → 0.

### ⚠️ The bug this phase exposed — `supabase.rpc` unbound (fixed `7fd74f1`, `c514387`)

The first in-app capture showed **neither** the new RPC **nor** its 155 kB
fallback — no request at all. That is only explicable by a throw before fetch,
and it was: `SupabaseClient.rpc` is a **prototype method** whose body is
`return this.rest.rpc(...)`. Four call sites had extracted it **unbound**
(`const rpc = supabase.rpc as unknown as (...)`), so `this` was undefined and the
call threw `TypeError: ...reading 'rest'` **synchronously, before issuing any
request**. Because it threw at the call rather than returning `{ error }`, every
`if (error) …fallback` beneath it was **unreachable**, and it failed **silently**
— a missing badge looks identical to "nothing to badge".

**Three were pre-existing and had never worked in the app**, despite being marked
"applied live & verified" in this document:

| Broken RPC | Surface | Now |
| --- | --- | --- |
| `count_pending_location_changes` | pending zone-change badge (Phase 1 item 3) | ✅ `0.0 KB` in-app |
| `preview_eod_rollover` | the EOD screen | ✅ `36.5 KB` in-app |
| `requeue_failed_inbound` | review-screen retry | ✅ fixed |
| `ops_unread_agent_counts` | Phase 4.1 (new) | ✅ `0.0 KB` in-app |

Subtlety: casting **in place** — `(supabase.rpc as X)(...)` — is safe (the cast
erases, the member reference keeps `this`). Only the **variable assignment**
breaks it. That is why `agent-departures.ts` / `stock-counts.ts` were fine and
others weren't — the same idea existed in **three** implementations, two correct
**by luck**.

Fixed and made unrepeatable: one shared `rpcUntyped<T>()` in `lib/supabase.ts`
(binds once, documents why; all **14** call sites across 9 files route through it;
both duplicate local helpers + 3 redundant `UntypedRpc` types deleted), plus an
eslint `no-restricted-syntax` rule rejecting the assignment form — verified
against a probe to fire on all 3 bad forms and flag neither good form. Delete the
helper at the Feature A cutover, when `gen:types` makes every RPC typed.

**Process lesson, and the reason this phase's verification section is so long:**
"the SQL works" was treated as "it's validated". Three already-broken RPCs had
cleared exactly that bar. **Verifying the database says nothing about whether the
app can reach it** — nothing is validated until it appears in an in-app capture.

### Declined — measured

| Item | Status | Why |
| --- | --- | --- |
| Patch local cache from mutation responses | ⏭ declined | Every remaining message/claim/notification line is now ≤2.7 KB/burst (<1% of egress). Nothing left to reclaim. |
| Grouped RPC for `agentUnreadCounts` | ⏭ declined | Already date-scoped; returns **1 row** today. |
| Private Broadcast topics with RLS (Stage B) | ⏭ **deferred — unmeasured, see caveat** | Large lift; targets websocket traffic this audit has never measured. |
| Migrate threads / claims / notifications | ⏭ declined | Threads avg 2.7 messages; the whole detail burst is ~30 KB incl. everything. |
| Foreground safety reconciliation | ✅ unchanged | Kept, as specified. |
| Calls | ⏭ declined | Unchanged and low-volume, as the audit recommends. |

### ✅ Realtime websocket egress — measured 2026-07-15, gap closed

Supabase counts **Realtime** as egress; `egress-log.ts` originally wrapped
`fetch` only. `7fc7a2a` + `c079775` + `045518f` added a dev-only counting
WebSocket transport (scoped to Supabase's socket via `realtime: { transport }`,
NOT a global patch), so websocket frames now fold into the same burst tables,
labelled `WS pg/<table>/<op>`. Validated end-to-end in-app: the install line
prints, and sending a reply produced a real `WS pg/delivery_messages/INSERT`
frame.

**Measured — one admin walk, ≈696 KB session:**

| Frame | Cost | Note |
| --- | ---: | --- |
| `WS pg/delivery_messages/INSERT` | **1.0 kB / event / device** | the reducible cost — a full row pushed |
| `WS phx_reply` / `system` / `phx_close` (protocol) | ≈6 kB total | connection chatter — **not** reducible by Broadcast |
| **All WS combined** | **≈7 kB (~1% of the session)** | — |

**The whole Phase 4.1 loop is visible in one burst:** a
`WS pg/delivery_messages/INSERT` (1.0 kB) immediately followed by its debounced
`POST rpc/ops_unread_agent_counts` refetch at **0.0 kB** — the refetch that cost
155 kB before 4.1.

**Verdict — Broadcast (Stage B) DECLINED, on measurement.** The estimate held:
the notification pipe is real but small. One message event = ~1 kB per connected
device; with realistic fan-out (~50–250 `delivery_messages` changes/day ×
read-receipt updates × N ops devices) it lands in **single-digit MB/day** —
against a delivery list that costs **~264 kB per load, many loads per device per
day**. Broadcast would shave the 1 kB data frame to ~0.1 kB but cannot touch the
comparable protocol chatter, and it is a large lift (RLS on `realtime.messages`,
reconnect handling, per-domain migration). Not worth it while the list is ~90% of
egress. **Revisit only if a future measurement shows message-event fan-out
growing** (more ops devices, or a jump in message volume).

## Phase 5 — the delivery list ◀ **NEXT** (no longer "optional")

The audit filed this as optional. Measurement has promoted it: after Phases 1–4,
**the delivery list is ~90% of all egress** (663.2 kB of a 733.4 kB admin walk;
one load = 279.5 kB). It is the only remaining work that moves the needle — and
also the only line a user actually waits on.

Phase 3 already narrowed the rows to a 28-column compact projection and removed
the per-list `delivery_items` fetch, so **the remaining weight is row count, not
row width**. Two distinct problems, and they are not equally hard:

### 5a — Do Postponed/Unassigned need their own rows? (investigate FIRST)

A single burst shows `deliveries_admin ×3`: the date-scoped list, plus
`listPostponed` and `listUnassigned` — each a **separate full-width, all-dates
fetch**. They exist because both chips are deliberately date-independent
(`project_list_sort_activity`, and see Phase 4.1's cross-date note). Before
reaching for pagination, check whether they can be **derived from, or share, the
main list's cached rows**, or be reduced to an id + a few fields and joined
against the cache. Cheaper and lower-risk than pagination if it works; it is the
same "collapse duplicate fetches" move that made 2.4b free.

⚠️ Constraint: these two are cross-date **by design** — a postponed order's
`scheduled_date` is bumped forward, so it is genuinely not in today's rows. Any
sharing scheme must preserve that or chips/counts silently change. Verify against
the sibling-collapsed counts before cutover.

### 5b — Progressive loading for the remaining bulk

Then keyset/infinite loading, as originally specified:

- Load the first 50–100 immediately.
- Prefetch the next page before the user reaches the end.
- Preserve server-wide search across all history.
- Preserve scroll position on detail/back navigation.
- Show the same “recent rows/search older” guidance.

Do not paginate reconciliation share sources unless the complete report is still produced independently.

### Validation bar (non-negotiable after Phase 4)

Nothing here is "done" on a psql check. It must show up in an **in-app egress
capture**, and the sibling-collapsed unique counts must match exactly — see the
process lesson in Phase 4.

---

## Mutation-to-cache invalidation matrix

| Mutation                        | Immediate cache update                   | Background invalidation                                                                            |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Create/update/delete delivery   | Insert/patch/remove list and detail row  | Delivery lists, dashboard snapshot, unassigned/postponed, relevant stock                           |
| Change status                   | Patch detail/status immediately          | Lists, dashboard, history, stock if delivered/reverted, reconciliation if terminal/payment changed |
| Assign/unassign                 | Patch agent fields immediately           | Lists, dashboard workload, unassigned, available orders                                            |
| Reply/flag message              | Append returned message                  | Thread, unread count, delivery activity, issues                                                    |
| Mark messages read              | Patch `read_at`/count                    | Thread and unread safety query                                                                     |
| Claim/release follow-up         | Set/remove returned claim                | Follow-up map and relevant delivery                                                                |
| Mark client notified            | Insert returned tag                      | Delivery notification map and rep coverage                                                         |
| Stock adjustment/transfer/count | Apply returned quantities if trustworthy | Affected holder(s), global/client summaries, movement first page                                   |
| Catalog change                  | Patch changed record                     | Corresponding picker/list/detail cache                                                             |
| Settlement                      | Patch settlement state                   | Reconciliation summary/detail and settlement list                                                  |

## Validation and regression test matrix

Every phase should be verified for:

| Area           | Required checks                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Roles          | Admin, dispatcher, rep, agent, warehouse                                                                 |
| Delivery types | Manual, bot, multi-product, waybill, postponed, unassigned, sibling/race assignment                      |
| Search         | Customer name, full/partial phone, all dates, older-than-first-page result                               |
| Messages       | Agent→ops, ops→agent, read clearing, actionable issue, auto-seeded issue, `not_my_route` rep restriction |
| Stock          | Positive, zero, low, negative, warehouse, agent, client aggregation, transfer both legs                  |
| Reconciliation | Cash, transfer, vendor-direct, POS fee, waybill, client-specific format, phone-enabled format            |
| Connectivity   | Offline mutation, reconnect, foreground after missed Realtime event, backend outage                      |
| Multi-device   | Same user on two devices, two reps claiming, team call first accept, notification read state             |
| Security       | RLS parity, cache cleared at sign-out, no admin fields in rep/agent projections                          |

## Success criteria

The optimization is successful only when all are true:

- Every existing user-visible field remains available in its current workflow.
- Dashboard totals, stock totals, unread counts, and reconciliation totals match the old implementation exactly.
- Share messages remain complete and intentional formats remain byte-identical.
- First useful content is no slower and preferably faster.
- Live operational updates are no slower.
- Initial screen request counts fall to one bundle.
- Obsolete search/filter requests are canceled.
- Back-navigation can display cached data immediately.
- Supabase egress per active user/device decreases measurably.

## Recommended order by benefit and risk

| Order | Change                               | Benefit          | Risk                         |
| ----: | ------------------------------------ | ---------------- | ---------------------------- |
|     1 | Remove duplicate first-focus loads   | Very high        | Very low                     |
|     2 | Scalar pending/review counts         | High             | Very low                     |
|     3 | Cancel superseded searches           | Medium–high      | Low                          |
|     4 | Compact normalize-address response   | Medium           | Low                          |
|     5 | Shared reference/query cache         | High + faster UX | Medium                       |
|     6 | Scoped stock queries                 | Very high        | Medium                       |
|     7 | Compact delivery list RPC            | Very high        | Medium                       |
|     8 | User-facing bot review projection    | High             | Medium                       |
|     9 | Dashboard snapshot RPC               | High             | Medium                       |
|    10 | Realtime shaped events/cache patches | High at scale    | Medium–high                  |
|    11 | Progressive “All dates” loading      | Medium           | Medium                       |
|    12 | Call Broadcast redesign              | Low currently    | High correctness sensitivity |

## Final recommendation

Begin with Phase 1 and measure again before redesigning data contracts. The first-focus, scalar-count, search-cancellation, and compact Edge Function response changes should reduce egress with essentially no product risk.

Then introduce a shared stale-while-revalidate cache. This is the architectural change most aligned with the stated priority: users see useful data sooner, the app refreshes quietly, duplicated requests collapse into one, and mutations/Realtime events can update only the affected information.

After caching is in place, compact list and stock projections become easier to roll out safely because each endpoint has a stable query key, explicit invalidation, and a clear UI data contract. Full detail and financial/reporting data should remain complete; the optimization should target invisible payloads and repeated transfers, never operational clarity.
