# Financial integration audit

This is implementation guidance from the schema-only export inspected on 15 September 2026. Discovery, shadow calculation, completion review, normal-fee preservation, rollover identity propagation and shared financial locking are implemented locally. **Final projection, pending/frozen-pay settlement guards and primary financial readers are now implemented and tested locally. Remaining direct-view/client compatibility, correction paths and rollout validation still block automatic payout activation.**

## Current behavior that must be preserved

| Path | Observed behavior | Required integration |
|---|---|---|
| `change_delivery_status` | Locks delivery first; inserts immutable status history before writing the final scheduled date; stock changes follow. Defaults missing `effective_at` to server time. | Explicit occurrence is now retained separately. Acquire financial locks before the delivery row when final projections can update other deliveries. Preserve status, cash, item and stock atomicity. |
| `settle_period` | Admin-only; snapshots ordinary deliveries by assigned rider and scheduled date, plus replacement attempts. No shared advisory lock in the inspected definition. Null payout is coalesced to zero. | Implemented locally: canonical successful-rider snapshots, unresolved-pay rejection and shared locks. Client/replacement accounting is preserved. The table-boundary readiness guard now also covers direct privileged inserts/updates. |
| `bulk_settle_agents` | Atomic batch; sorted, deduplicated riders; request idempotency; calls `settle_period`. | Acquire all rider/period locks in deterministic order before taking individual row locks. Preserve all-or-nothing behavior and payload-bound retries. |
| `void_settlement` | Locks the settlement row before updating it. | Implemented locally: outer locks, recalculation after voiding, immutable historical snapshots and reasoned audit. |
| `agent_change_delivery_location` | Previously compared and recorded the payout snapshot as a normal fee. | Normal-rate comparison and reversion evidence are implemented and tested. Coordination of approval, application and reversion with frozen periods remains. |
| `update_delivery_fields` | Pre-delivery only, with an application edit lock. Resnapshots rates for rider/client/location changes; otherwise writes the existing snapshot back. | Explicit normal-rate resnapshot and name-only preservation are implemented and tested. Final-pay projection and settled-delivery update guards are implemented; continue the wider writer audit. |
| `correct_delivery_charge` | Accepts direct rider payout and charged amount corrections. | Audited manual exceptions, preserved normal fee and charge-only exclusion are implemented and tested. Group review and reasoned preview removal are available. Final projection is integrated. Add a separate normal-rate correction path. |
| Rollover | Copies an explicit list of fields into a child delivery. | Identity propagation, normal-fee fallback, audit evidence and single-order retry are implemented and tested. EOD batch financial lock ordering remains. |

## Implemented locking protocol

The financial-lock migration adds sorted outer keys: `agent:<id>` for a rider across periods, and `client:<id>:<accounting-date>` for client reconciliation. Main completion, correction, assignment and settlement entry points acquire these before existing row/group locks. Bulk handover acquires all selected rider keys first; void acquires the subject key before the settlement row.

Before-write triggers on deliveries, replacement attempts and settlements cover direct/older paths and subject changes discovered after reading rows. These guards only try locks; contention aborts with retryable `40001`. Nested operations likewise avoid blocking for new outer locks after taking other locks. Early history-driven shadow mutations participate too. Existing queue classification retains `40001` as retryable.

Seven two-session tests passed for completion/settlement, date review/settlement, fee correction/settlement, void/review, overlapping bulk handovers, the direct-write retry safeguard and an independent rider. The latter completed while another rider remained locked, so the protocol does not use a global financial mutex. These local tests do not establish production contention or throughput; measure hot client/day traffic during rollout.

Final projection uses this protocol. Enabled-policy tests passed for completion, manual review, settlement, fee/date correction, void and bulk handover contention, including independent riders. Continue the matrix for identity merges, deletion, sub-agent handoff and other correction paths. Frozen-period and pending-pay guards are implemented; late activity across accounting periods is covered by the final-pay SQL suite.

## Authority and compatibility work

- Separate normal-fee snapshots and explicit location/order rate writers are implemented. Final projection, manual exceptions and reversal are implemented; finish the deletion/sub-agent handoff audit before treating every entry point as covered.
- Snapshot the successful rider; later assignment edits must not transfer earned pay. Settlement, versioned earnings summaries and rider earnings detail now use successful ownership. Remaining direct views need integration.
- Keep both dates: actual Lagos completion day selects the pay group; accounting date selects the existing reconciliation period. One pay group can span accounting periods.
- A pending date/rate is not zero earned pay. The new readers expose known totals, pending counts and unavailable final remittance. The old summary RPC rejects pending results. Older direct-view clients still need explicit compatibility protection before activation.
- Implemented `agent_earnings_summary_v2`, replacement merging, rider earnings, primary reconciliation summary/share text and admin detail. Rider Today/detail and negative-margin lists/counts now use explicit payment metadata too. Finish older direct-view client protection and remaining exports. Replacement and waybill amounts retain their own rules.
- Preserve settled snapshots. Recalculating an unchanged settled anchor should not block a valid new half-fee line in an open period; changing a frozen amount requires an explicit correction workflow.
- Manual exception acknowledgement now records a signature of the reviewed members, completion events, normal fees and exception decisions. Changed membership or customer/day context requires renewed review; clearing an exception is reasoned and idempotent. Final projection preserves these semantics; local tests cover acknowledgement, invalidation and clearing.
- Activate by a future Lagos date with a persisted policy version. Disabling future enrollment must not reprice an already enrolled day or partially apply that day's rule.

## Required release evidence

Exercise completion versus settlement, completion versus correction, overlapping corrections, bulk settlements and date changes across periods in separate sessions. Verify one full anchor, no duplicate earnings/stock, no deadlocks, consistent pending behavior and immutable settled snapshots. Rehearse migration/backfill on representative volume and verify the real local API with the browser, followed by native-device/offline checks.

The admin date-review guard coordinates with settlement and void under shared locks. Final-pay settlement races passed with projection and pending/frozen-state enforcement enabled in the isolated database. This does not establish coverage of all correction races or production throughput.


## Current financial read contract

`agent_earnings_summary_v2` returns `known_earnings`, `pending_pay_count`, nullable `total_earnings`, and nullable `total_remit`. Both final totals are unavailable while any ordinary earning in that rider/accounting period needs review. Replacement pay adds to known earnings without resolving pending ordinary pay. Customer collections remain available.

`list_my_earnings_v2` returns only the caller's own successful-rider earnings, including pending rows, with bounded keyset pagination. Reassignment does not move already earned pay. The private row source is not executable by API roles. The manager predicate excludes reps (the older helper named `is_admin_or_dispatcher` also includes reps).

Review endpoints expose `shadow`, `final`, or restored `legacy` mode. A final pending value is null rather than a provisional delivery snapshot. The UI explains when review affects actual open-period earnings. None of these readers activates the policy.


`get_delivery_pay_state` accepts at most 500 IDs and returns only admin-visible or the rider's relevant records. It distinguishes pending, reversed and not-earned states; another assignee receives no successful rider amount or margin. Main delivery detail fails closed on a real metadata read error, with missing-endpoint fallback only for client-first deployment. Completed rider cards use one metadata lookup per batch.

`get_negative_margin_delivery_ids` uses final ready pay for enrolled earnings and excludes unresolved amounts; its count-only mode avoids transferring row IDs. The client rechecks hydrated payment metadata before rendering flags. Existing raw views are not yet guarded against older clients reading provisional snapshots, so production activation remains blocked.


## Settlement write boundary and export audit

The inspected schema enables RLS on `settlements` with only a SELECT policy for app roles. The only settlement INSERT in the inspected function definitions is in `settle_period`; the existing UPDATE is in `void_settlement`. The table trigger now enforces active rider-period readiness too, covering privileged/older writers without expanding app permissions. Voiding skips the readiness check so pending late activity can still be resolved. A conflicting direct insert raises retryable `40001`; isolated tests also cover pending inserts, reactivation and subject changes.

The nine two-session cases passed with this guard enabled and restored the empty test database. This is evidence for the tested entry points and lock order, not proof of every future privileged SQL writer or production contention profile.

The current app's Moniepoint and Kuda download handlers both source `clientsQ` and `clientAmountPayable`; their export types describe vendor beneficiaries. They do not consume rider pay. Summary share text already labels unavailable rider-pay and margin totals as pending. Searching checked-in Edge Functions found no `agent_payment_snapshot`, `total_earnings`, or `total_remit` references. External reports and older deployed clients remain outside this source-code evidence.


## Dedicated normal-fee correction

`correct_same_customer_normal_fee` uses the shared financial lock before row locks, checks earning revision and all affected settled rider periods, and changes only the normal baseline. It does not create or clear manual exceptions. Append-only API audit records retain actor, reason and before/after earnings. Shared SQL tests pass with shadow and final policy; both settlement race directions passed with final policy. The full eleven-case concurrency runner restored its original empty database.
