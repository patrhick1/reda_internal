# Same-customer deliveries: implementation checkpoint

Updated 16 September 2026 (Lagos). The full feature is **not ready for financial activation**.

## Production web trial

The discovery-only release was published from isolated commit `8f49512` on 16 September 2026. Only migration `20260915223000_same_customer_discovery.sql` is installed in production, with `same_customer_discovery=true`. The payout engine, financial readers and native OTA changes remain undeployed. The web trial adds group discovery, order comparison, reasoned identity correction and explicit manual assignment. These actions operate on live orders; existing rider-pay rules remain unchanged. See [web trial rollout](same-customer-web-trial.md).

The sections below document the broader local implementation and its initial isolated validation, not a claim that all of it is deployed.

## Implemented locally

- Versioned Nigerian phone normalization, preserving original contact strings and existing duplicate keys.
- Scheduled-day discovery across vendors and riders, with exact primary matches and separate alternate-phone suggestions. Names do not drive matching.
- Logical duplicate counting mirrors the current server's phone/items/day plus forwarded-text-or-address predicate, including connected copies.
- Paginated groups, full group counts before vendor/rider/search filters, batched row badges, detail entry points, and a related-orders sheet.
- Explicit manual selection and rider assignment, reporting assigned/already assigned/closed/unavailable outcomes. Request retries return the original result.
- Manager-only reasoned link/split/reset corrections with revisions, request idempotency, audit records, and protection against direct-table audit bypass. Contact/day edits invalidate stale correction forms.
- Split orders remain reachable from delivery detail to restore phone matching.
- Ops-only relationship data; reps can inspect but cannot assign/correct. Rider and warehouse requests are rejected. Non-admin detail payloads omit rider pay values.
- Discovery and shadow-pay flags default off; final-pay policy is unconfigured and has no public activation API. No production payout deployment or automatic assignment.
- Shadow earning/group records snapshot the successful rider, original normal fee, accepted Lagos day and final scheduled accounting date. Calculation is one full fee followed by half-fee lines, with exact decimal rounding.
- Shadow recalculation covers completion, reversal, re-delivery, identity/contact changes and normal-rate corrections. It records append-only earning revisions, marks unequal rates/date discrepancies for review, and preserves manual-override fields for the later correction integration.
- Queued completions now send their persisted creation timestamp as the occurrence claim. Retries cannot replace it with the retry time; the database owns acceptance of the Lagos day.
- Explicit occurrence is retained in immutable status history before the legacy server fallback is applied. Missing claims stay pending in shadow pay; original evidence is not rewritten by review.
- Admin-only completion-day review supports reasoned, revision-checked, idempotent corrections, recalculation of both affected day groups, and an append-only before/after review record. A flagged admin delivery panel shows current payable amounts separately from proposed earnings and lets admins review dates.
- Normal rider fees now have separate snapshot fields. Enrolled shadow earnings retain their baseline across payout-only and unrelated edits; location application/approval/reversion and rate-changing order edits explicitly resnapshot the normal fee. Captured NULL rates remain reviewable errors rather than falling back to payable amounts. Legacy rows are read through a compatibility adapter without a bulk historical rewrite.
- Rollover carries resolved customer identity, uses the normal fee as its fallback, and records the inherited identity in the rollover audit. It remains manually assigned. Unchanged shadow inputs no longer trigger another group recalculation.
- Shared financial locks now coordinate main completion, correction, assignment, settlement, bulk handover and void paths. Locks are per rider and per client accounting day; nested/direct delivery, replacement-attempt and settlement writes try the same locks and raise retryable `40001` on contention instead of waiting while holding rows. The default-off policy preserves existing payable amounts; final-pay projection now participates in these locks when configured in isolated tests.
- Existing explicit rider-fee corrections now record immutable manual-exception decisions while preserving the normal baseline. Charge-only edits do not create an exception. The admin can inspect paginated group amounts, acknowledge the whole group with a reason, or remove an exception. The UI distinguishes preview-only review from a review that changes actual open-period earnings. Group membership, customer/day context and new completion events invalidate earlier acknowledgement without erasing the amount or its reason.

- Final-pay projection applies the full/half rule to actual payable snapshots on enrolled Lagos days, preserving normal fees and successful ownership. A private day ledger prevents later suspension from repricing an already enrolled day. Pending amounts remain null in the earning authority, and rider settlement is rejected until review is resolved.
- Frozen settlement snapshots remain immutable. A valid new half-fee line in another open accounting period is allowed; late or changed activity that conflicts with a frozen period becomes pending. Voiding the settlement recalculates affected open pay.
- Late offline activity after suspension still receives date review when it may belong to an active day. Explicit manual exceptions survive suspension and subsequent date review; changed date context requires renewed acknowledgement. Corrections to before activation restore the normal/explicit legacy amount.
- Versioned financial readers return known earnings, a pending count, and nullable final pay/remittance. Updated rider earnings, reconciliation, bulk handover, summary share text and admin detail handle pending values explicitly. Replacement amounts retain their separate rules; waybill costs remain separate. Successful ownership survives reassignment, and rider detail is paginated.
- The old earnings-summary RPC rejects unresolved totals instead of returning a provisional amount. This is only one compatibility safeguard: legacy direct views and other finance surfaces still need the broader audit below. Review panels now explain when an action changes actual earnings, and financial screens refresh after these changes.

- Delivery payment metadata is now shared by admin and rider detail, and fetched in bounded batches for completed rider cards. Pending/reversed/other-rider earnings have explicit labels; a new assignee cannot see another rider's fee or margin. Today earnings use successful-rider totals rather than the currently assigned delivery list. Optimistic completion shows pending sync until the server confirms it, and pre-completion figures are labelled estimates.
- The negative-margin list and attention count use a shared server calculation that excludes unresolved same-customer pay. Counts can be requested without returning IDs. Hydrated rows are checked again so a correction between requests removes a resolved flag.

- Settlement readiness is enforced at the table boundary, in addition to the handover RPC. Privileged inserts, reactivation and subject changes cannot create an active settlement over pending pay; voiding remains available. The check uses active earning predicates covered by the period indexes. Existing settlement RLS still grants app users only the applicable read policy.
- Export audit: current Moniepoint/Kuda downloads use vendor balances (`clientsQ` and `clientAmountPayable`), not rider-pay snapshots. The financial summary share text already represents pending rider pay/margin explicitly. No rider-payment snapshot consumer was found in the checked-in Edge Functions.

The user confirmed that the pay rule uses **actual completion day in Africa/Lagos**. Discovery continues to use scheduled dates for operational planning. The plan now records that distinction.

## Normal-fee correction checkpoint

Admin delivery detail now provides a dedicated correction sheet for the full normal fee, separate from a manual payout exception. Saving requires a changed finite amount, a reason, the earning revision, and an idempotency key. The RPC preserves manual decisions, recalculates the group and records the previous/new earning with the actor and reason. Settled affected rider periods reject corrections. Private audit tables remain inaccessible to app roles.

Validation: the full PostgreSQL suite passed in shadow and final-pay modes, including missing-rate repair, exact retries, conflicting request reuse, stale revisions, zero/invalid amounts, unchanged/missing reason rejection, pending-order rejection, manual-exception preservation, settled-period protection and dispatcher/private-table rejection. All eleven two-session settlement cases passed with final pay enabled; normal-fee-before-settlement waited 2,043 ms and settlement-before-normal-fee waited 1,983 ms. The original empty test database was restored.

TypeScript, targeted ESLint and the local Expo web export passed. The mock browser check verified invalid precision blocks saving, changed fee and reason enable saving, successful feedback and visible reviewer evidence, with no horizontal overflow at 390×844. Database tests establish recalculation correctness; the mock browser check establishes UI behavior only. This does not close the real API/native-device release gate.

## Validation evidence

| Check | Result |
|---|---|
| Full app TypeScript check | Passed |
| ESLint on modified application files | Passed |
| Expo web export | Passed, using a verified localhost-only API configuration |
| PostgreSQL integration suite against schema-only clone | Passed |
| Existing delivery-payment tests | 10 passed |
| Existing client-balance tests | 5 passed |
| Existing stock-summary tests | 5 passed |
| Queue occurrence/retry tests | 3 passed |
| Replacement earnings merge tests | 2 passed: pending stays null; separately rated replacement-only pay and vendor-collected money |
| Shadow pay through real completion/reversal RPCs | Passed: 1–4 successes, independent riders, multi-product orders, different accounting dates, postponed completion, duplicate closure, retries, reversal/re-delivery, rate review and correction, identity correction, offline/future claims, rider snapshot preservation, unchanged payable amounts |
| Concurrent completion transactions | Passed after financial-lock integration: second writer took 2,156 ms; exactly one full and one half earning; stock and payable snapshots consistent. Timer now stops when the second process exits, before waiting for the first process. |
| Settlement concurrency | Seven real two-session cases passed: completion before settlement (2,034 ms wait), settlement before day review (1,952 ms), settlement before fee correction (2,012 ms), void before day review (2,003 ms), opposite-order bulk handovers (1,980 ms), fallback write retry (364 ms while the competing lock remained held), and independent rider settlement (247 ms while the first rider remained locked). |
| Normal-fee integration | Passed through real RPCs: payout-only baseline preservation, unchanged earning revision, equal/higher rate agent location decisions, manager approval/reversion, delivered-location correction, pre-delivery name/rate edits, rollover identity/normal-fee fallback/retry, explicit NULL rate review and direct-write/helper access rejection |
| Manual exceptions | Passed: charge-only exclusion, preserved normal fee, explicit current correction, pre-completion exceptions, full-group acknowledgement, pagination with complete totals, exact retries, conflicting request reuse, stale review, non-finite amount rejection, new-member invalidation, clear/retry, unequal-rate rejection, re-delivery, single-order customer/day changes, settled successful-rider protection and dispatcher rejection |
| Manual-review concurrency | Passed: a new completion waits for an in-flight review (2,029 ms), then invalidates that acknowledgement while preserving the exception. The seven previous settlement concurrency cases passed again. |
| Completion-day review | Passed: missing legacy occurrence, reviewed group membership, old/new anchor recalculation, original-evidence preservation, exact retries, conflicting request reuse, stale revision, future-date rejection, dispatcher rejection and already-settled period rejection |
| Browser check with local mock API | Group filter, details, manual selection, rider assignment/result feedback, reasoned correction, desktop and 390×844 layout exercised |
| Admin day-review browser check with local mock API | Passed: initially pending date, required fields, future-date rejection, successful correction feedback, refreshed half-fee preview with unchanged current payable, visible review reason, and 390×844 summary layout |
| Manual-review browser check with local mock API | Passed: confirmation disabled until every page is loaded and a reason entered; full/half tiers, exception reasons and complete group total; successful review feedback; reasoned removal restores the fixed preview while current payable stays unchanged; 390×844 sheet layout |
| Final-pay integration | Passed: actual full/half snapshots, retries, reversal/re-delivery, manual review/clear, rate correction, missing/future/offline claims, pre-activation correction, immutable policy-day decision, successful-rider settlement attribution, frozen/late activity, void/recalculation, and unchanged vendor charges/stock invariants |
| Final-pay concurrency | Passed with policy enabled: simultaneous completions (2,085 ms second writer); manual review/completion (2,014 ms); completion/settlement (2,046 ms); settlement/date review (2,008 ms); settlement/fee correction (1,995 ms); void/date review (2,048 ms); opposite-order bulk handovers (2,013 ms); direct-write retry (101 ms); independent rider (134 ms) |
| Financial reader SQL tests | Passed: confirmed totals, explicit null pending totals, live review mode, legacy summary error, successful ownership after reassignment, own-detail pagination, rep rejection and private-helper rejection |
| Financial browser checks with local mock API | Passed: pending rider category, known earnings, no handover action for unresolved pay, pending summary/margin, financial-read error instead of a zero summary, rider pending earnings/remittance, live-review wording, required full-group pagination/reason, and synchronized admin detail after acknowledging/removing an exception; 390×844 layout inspected |
| Delivery pay metadata | Passed: legacy behavior, final amounts/margins, reversed/pending states, successful-rider visibility, reassigned-rider redaction, private/unrelated IDs, role rejection and 500-ID bound |
| Negative-margin readers | Passed: confirmed loss appears, pending provisional loss is excluded, count-only response omits IDs, rep access rejected |
| Delivery-pay UI | TypeScript, lint and web export passed; local mock browser verified pending Today totals/cards/detail and “Not earned by you” after reassignment; 390×844 layout had no horizontal overflow |
| Delivery pay label test | Passed: pending/reversed/not-earned/missing-rate states stay distinct from confirmed zero |
| Settlement table guard | Passed: direct pending insert, reactivation and subject changes rejected; original records preserved; void and client settlement behavior retained |
| Settlement guard concurrency | All nine cases passed with final pay enabled. Direct settlement contention returned retryable failure in 161 ms; independent rider completed in 311 ms; coordinated competing operations waited about two seconds. Empty database restored. |
| Discovery load test | 2,500 synthetic orders, 1,250 groups, complete counts with 50-group pages; recorded p95 59.919 ms across 10 calls |

The database suite covers phone variants/invalids, alternate candidates, forwarded duplicates, different vendor/name/address/product data, date isolation, pagination, filtering, correction retries, stale revisions, contact edits, reset, role redaction/rejection, direct-write protection, manual assignment outcomes, and unchanged money/status/stock during discovery.

Database timings are local query timings, not a production SLA. The browser used mock API responses; this is **not** a claim that a real PostgREST-to-browser end-to-end test or native-device test has passed. Shadow and enabled final-pay completion/settlement concurrency tests have passed. The full correction-race matrix, legacy-client coverage and production-scale behavior remain outstanding. Earlier concurrency timing included waiting for both processes; the corrected measurement and additional cases supersede those timing claims.

## Test isolation and cleanup

- During initial implementation, production access was read-only schema inspection; the later discovery-only rollout is documented above. No production customer rows were copied into the test database.
- Dedicated PostgreSQL 17 cluster on `127.0.0.1:55439`, database `reda_same_customer_test`; the normal local PostgreSQL service was untouched.
- The test clone has no outbound HTTP extension. Notification functions are no-ops during test transactions; local schema copies have internal notification secrets redacted.
- Synthetic data, assignments, corrections, audits, feature-flag changes, and the 2,500-row load fixture run within transactions/savepoints and are rolled back.
- The two-session concurrency test needs mutually visible committed fixtures. Its runner first checkpoints the empty isolated database, then restores that exact checkpoint in `finally`, including schema/functions/sequences/flags. Cleanup was verified after both a harness failure and the successful run.
- Post-test checks verify that delivery/user/decision/assignment-request fixtures are absent.
- The browser fixture server uses synthetic identities only, does not forward API requests, and restricts browser connections to localhost. Its state exists only in memory.
- The local fixture server and isolated PostgreSQL cluster were stopped after the checks. Final database fixture counts were zero for deliveries, users, corrections and assignment requests.
- Generated test files and schema snapshots stay in the ignored `.codex-deploy-same-customer-test` directory. They are not deployable artifacts.

To rerun after starting the isolated schema-only clone:

```powershell
./tools/test-same-customer-local.ps1
./tools/test-same-customer-pay-concurrency.ps1 -FinalPay
./tools/test-same-customer-settlement-concurrency.ps1 -FinalPay
npm --prefix mobile run test:queue-occurrence
npm --prefix mobile run test:agent-earnings
npm --prefix mobile run test:delivery-pay
```

The runner fixes host, port and database, refuses a nonempty database, applies the eleven same-customer migrations locally, runs the transaction-wrapped suite and verifies cleanup even after a test failure. It cannot be pointed at production by passing a connection string. Reapplying all eleven migrations was also verified on the empty clone. The settlement concurrency runner restores the exact empty schema checkpoint between cases and in `finally`.

## Remaining work before release

1. Finish discovery UX: explicit selection/search for linking unrelated-phone orders, representative/copy visibility, unusually large contact groups, and a real local API/browser integration pass.
2. Finish the financial writer/reader audit against refreshed live definitions. Verify sub-agent ownership and all remaining correction, deletion, identity merge and rollover races. The direct-write pending-pay guard is implemented; continue auditing the remaining historical correction paths.
3. Finish compatibility protection for older direct-view clients and audit remaining exports and financial writers. Main reconciliation, rider earnings/Today/detail, admin detail and negative-margin readers are integrated locally; the old summary RPC guard alone still does not make old clients safe for activation.
4. Complete successful-rider correction UX. The dedicated normal-rate correction path is implemented and tested locally. Backtest representative historical shadow data and validate the late/offline review procedure with operations.
5. Rehearse the full migration on representative historical volume. Stored generated contact columns may rewrite/lock the table; use staged backfill if needed. Measure financial reader plans and hot rider/client contention. Small local fixtures do not establish production throughput or migration duration.
6. Ship compatible clients and test through a real local API plus native devices/offline queues. Browser mocks validate rendering and interaction only.
7. Add the audited future-date policy activation/suspension workflow, choose the Lagos activation boundary, and reconcile the first live day. Keep activation unavailable until the earlier gates pass.

The full payout feature is not release-ready. Financial implementation and enabled-policy experiments remain local; no production payout activation occurred. Discovery alone is available in the production web trial.

## Fresh compatibility verification

See [16 September verification](same-customer-payment-verification.md). Core SQL,
11 settlement races, simultaneous completions, 21 JavaScript tests and TypeScript
passed again. A diagnostic reproduced a numeric legacy-view projection while
canonical pay is pending. Activation remains blocked; production was untouched.
