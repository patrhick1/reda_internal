# REDA fixes for the 28 September 2026 preview release

Prepared from the original working directory, the separate workflow-fix
checkout, and earlier publication records. This covers eleven fixes across the
tasks, including work completed outside the call/blacklist conversation.

**Status at preparation:** changes are being assembled and verified for main,
web and EAS preview. This document is not yet a publication receipt. Final
verification and release identifiers belong in the record at the end.

## Problems and solutions

| # | Problem | What changes for the user |
| --- | --- | --- |
| 1 | Changing the reason for a warehouse issue worked on Android but stalled on web because its confirmation did not open. Other actions used the same native-only confirmation. | Use one confirmation interface that works on Android and web. It covers the transfer-type switch and the other affected confirmations, including bulk actions, sign-out and financial void/handover actions. Cancel still leaves the action uncommitted. |
| 2 | Pressing Android Back after starting a call could abandon its screen while leaving the server call active. Another attempt then failed, sometimes showing `[object Object]`. | Back minimizes the call. A Return to call / End bar stays available elsewhere in the app. Repeated taps resume the existing device session, reopening restores an active session, and expired unanswered calls no longer wait for the minute cleanup before a retry. Errors are readable. Failed End retains retry controls without silently reconnecting audio. |
| 3 | A blacklisted bot order was refused without an active explanation to staff. A manual creation failure also needed to explain the block where the user was working. | Manual and Review forms show a clear inline refusal and keep entered values. Admins, dispatchers and reps receive one grouped notice linking to blocked orders; each user can mark their displayed notices seen. Bot notifications are quiet and limited to one push per ten minutes across the operations audience, with no historical backfill or repeated alert for the same inbound message. Manual attempts do not broadcast to colleagues. |
| 4 | Shared Stock Updates omitted active products with zero stock, although clients needed to know they were unavailable. | Include active products with quantity or **Out of stock**; continue hiding inactive products. Allow sharing when all active products have zero stock. Sharing requires both the selected client's stock and active-product data to load successfully: loading, failed refreshes or another client's cached rows cannot be reported as zero stock. |
| 5 | Manual end of day took approximately two minutes because it waited for scheduled workers, despite only a few seconds of processing. Larger runs waited between batches. | Start processing the confirmed saved operation immediately and continue ready batches without a minute delay. Preserve saved progress, retry rules, order-change checks, duplicate prevention and scheduled recovery if the app closes. Completion appears only after the saved operation has actually finished. |
| 6 | The Run end of day action was below a long order list. | Place the existing action immediately beneath the totals and destination, above the list. Its confirmation and disabled states remain. |
| 7 | The owner wanted the Create replacement shortcut removed from order details. | Remove that shortcut for admin/dispatcher. The established Home replacement entries still open the form and let the user find the original order. |
| 8 | Searching equivalent Nigerian phone formats could miss orders. The instant list filter could discard valid server results, and alternate numbers were not searched consistently. | The existing search treats local, country-code, international-prefix and punctuated forms consistently, including alternate contacts. Deliveries, Unassigned, Postponed, Failed, Same customer and replacement lookup follow the same search rules within their existing permissions/scopes. Names still work. Contact records and customer-grouping rules are unchanged. |
| 9 | Orders closed under a client's no-rollover policy looked like ordinary failed deliveries and displayed technical reasons. | When the current order's recorded event proves a policy closure, detail/history display **Closed** and a plain explanation that this client's orders do not roll over. Genuine failures retain Failed and their reason. A closure on an ancestor does not relabel the current order. |
| 10 | Creating an order from Review used several separately committed requests, adding delay and risking a created order without a completed source link. Concurrent or lost-response retries could duplicate work. | One atomic save creates the order, links and handles the review source, and releases its edit lock. Updated-device retries return the same saved order, and a failed transaction leaves the form intact without a partially committed creation. The original WhatsApp message and existing creation rules are preserved. |
| 11 | Secondary stock-movement details were clipped on narrow screens. | Allow details to wrap at a readable line height while keeping movement icons and quantities from shrinking. |

The notification design is deliberately restrained: one grouped in-app notice,
per-user acknowledgment, a quiet Android channel, and a cooldown. The notice
hides during calls and order entry so it does not compete with those tasks.
Web receives the in-app notice; this release does not introduce browser push.

## Earlier fixes preserved, not counted again

The original checkout is based on `ecb6569`, while the fetched release baseline
is `7dd947b`. Its dirty/untracked files include earlier releases, so the release
is assembled on current main instead of replacing it with the old working tree.

Already shipped work includes same-customer discovery and full/half rider-pay
calculations, manager-only matching access, relevant-only matching links,
payment-compatible financial readers and offline handling, resumable maintenance,
early manual closing and assignment preservation, intentional fee waivers, the
simpler reconciliation/EOD layout, removal of maintenance holds and noisy
processing pushes, Decency's delivered-report format, and the weekday/Sunday CI
repair. These features remain in place.

In particular, the new release must retain Change rider fee, intentional zero
fees, the client charge when editing rider pay, and the familiar reconciliation
filters. It must not restore the obsolete separate Pay review workflow or the
old technical EOD dashboard.

Earlier publication evidence includes preview group
`fe1010a7-c9c3-4e67-8d3e-a28392fb1e02` from `76878b8` on 23 September and Decency
group `e452a75f-f7e9-411c-95ca-ba2cb00579fe` from `a7e1e6a` (merged as `758c9ec`) on 27 September, both
runtime `1.1.1`. The latest fetched baseline also contains the CI repair at
`7dd947b`. Detailed evidence is in the two audits linked below.

## Paused investigations and unapproved proposals

- **Uchenna same-customer report:** paused while the owner checks with Uzo
  whether the entries represented separate purchases or re-forwarded copies.
  No matching-rule or customer-record change is part of this release.
- **Postponed orders moving down the list:** the owner asked Uzo whether they
  should retain their original positions. No replacement sorting rule has been
  approved or implemented.
- Intentional split-rider acknowledgment, additional pickup context,
  customer-correction fee previews and extra candidate-group visibility remain
  proposals, not hidden additions to this batch.
- The Age Store/PelviBeat intake investigation found matching manual entries;
  it did not leave an approved code fix or data repair to publish.

## Verification evidence and remaining checks

The combined source passed the checks below. Remote CI, publication and physical-device results are recorded separately at the end.

| Area | Recorded local evidence |
| --- | --- |
| Confirmations | Browser tests for dialog choices/cancellation, plus application lint, TypeScript and web export. |
| Calls | Sixteen session/adapter tests, isolated PostgreSQL lifecycle/concurrency tests, lint, TypeScript and Android/web exports. Includes late tokens, account switches, duplicate taps, expiry, failed End and Cancel racing acceptance. |
| Blacklist notices | Six helper tests, isolated database/concurrent-refusal tests, mocked exported-browser flows, lint, TypeScript and Android/web exports. Covers cooldown, acknowledgment races, role restrictions, no historical flood and retained form values. |
| Stock sharing | Six tests of the actual transpiled screen pass, including loading/error states, stale-client data, active zero stock, inactive exclusion and refresh ordering. |
| Immediate EOD | Actual PostgreSQL 17/PostgREST 14.12 HTTP tests with committed batches and no normal-path scheduler; 0/1/99/100/101/153 groups and a larger 1,530-group case with 20,000 historical orders. Recent-sized isolated runs met the ten-second target. Browser tests covered completion, lost response and reload recovery. |
| EOD regression | Permissions, confirmed-operation scope, duplicate/concurrent requests, scheduled overlap, real retry delays, stale edits, app-absent recovery, Lagos midnight/weekends, assignment retention and financial/stock safeguards. |
| Phone search | Helper tests, authenticated API/view/RPC role and scope tests, edited/alternate phones, soft deletion, index usage and result cap; 390px/1280px browser and replacement searches. |
| Closure wording and replacement entry points | Phone/desktop browser checks for policy closures, genuine failures, ancestor history and preserved Home replacement routes. |
| Atomic Review save | Actual HTTP and phone/desktop browser tests for full form contents, multiple products, original messages, validation rollback, blacklist enforcement, permissions/edit locks, concurrent saves and lost-response retries. Controlled tests with 300ms added per mutation measured about 380ms for the atomic save versus 979–986ms for the former request chain. |
| Stock movement wrapping | Actual exported screen passed at 320px, 390px and 1280px: complete descriptions, no quantity overlap and no runtime errors. |

Local timing results are measurements under controlled conditions, not promises
for Uzo's network. Bundles and browser tests do not test Android audio, hardware
Back, CallKeep or notification delivery on a phone.

## Backend and release dependencies

EAS publishes the JavaScript bundle; it does not install database migrations or
deploy the notification function. The release operator must record each step
separately.

| Dependency | Purpose |
| --- | --- |
| `20260928120000_call_session_recovery.sql` | Recover/resume active calls, expire overdue ringing calls during retries, and serialize conflicting call starts/acceptance. |
| `20260928140000_blacklist_notices.sql` | Durable blocked-order notices, per-user acknowledgment, retry deduplication and push cooldown. |
| `send-notification` and `_shared/notification-policy.ts` | Quiet blacklist delivery without changing urgent call/delivery notification behavior. |
| `20260928160000_immediate_manual_eod.sql` | Authorized bounded execution of the already confirmed manual EOD operation. |
| `20260928180000_delivery_phone_search.sql` | Role-scoped normalized phone-search columns, indexed expressions and aligned search RPCs. |
| `20260928210000_atomic_review_save.sql` | Atomic Review creation/link/lock release and safeguards against stale legacy link/discard requests. |

Install the required call/EOD/search/Review APIs before publishing clients that
depend on them. The phone migration checks the existing search definitions for
drift; its index creation needs a bounded deployment window. Verify the EOD
function through actual HTTP with the required SERIALIZABLE isolation.

For blacklist notices, deploy the quiet notification policy before activating
new push events. Testers should first open the updated Android app so its quiet
notification channel exists. Do not backfill old refusals into new alerts.

Use production API configuration for the published builds. The isolated workflow
test export contains synthetic test configuration and must not be published.
Apply the reviewed new migrations only; old untracked migration files are not
an instruction to reapply earlier releases.

Updated Review saves prevent duplicate retries through the new atomic path.
An old client that already independently created an order before linking can
still leave that separate order. Finish in-flight Review edits and load the
updated app on working devices; do not automatically delete suspected copies.

## Uzo's checks after installing the preview

1. Change a warehouse issue reason on web and Android; confirm and cancel once.
2. Call another Android tester, press Back while ringing and after answering,
   return to the call, check audio/mute/speaker and End, then retry after an
   unanswered call expires. Also check reopen recovery and remote hang-up.
3. With an authorized test case, check one quiet blacklist push, grouped notice,
   no second push inside ten minutes, and an inline manual refusal retaining the
   form. Another staff account should have its own seen state.
4. Share a client's stock update containing available, active zero-stock and
   inactive products. A failed stock load must prevent sharing.
5. Check the EOD button position and elapsed time on a normal real operation;
   confirm the result and prepared orders before assignment.
6. Find an order using different formats of its primary/alternate phone, create
   a replacement through Home, and confirm Closed wording on a policy closure.
7. Save a Review item and confirm it returns once with the original message and
   entered values intact. Check stock-movement text on a narrow phone screen.

The device checks require installation of the published update and remain
pending until someone performs them. Do not create real operational test orders
or notifications without an authorized test case.

## Final release record

Update this section with actual results, not intended actions:

| Item | Result |
| --- | --- |
| Combined release commit | Pending publication |
| Main push | Pending |
| Final lint / TypeScript / relevant test suites | TypeScript, lint, format, generated runbook, 25 call/blacklist/search tests, 6 stock-share tests, 12 browser confirmation tests and 37 existing payment/stock/queue regressions passed. Web/Android exports and blacklist browser flows passed. All integrated workflow browser tests passed at 390px/1280px, including actual HTTP EOD, phone search, atomic Review, fee changes, handover and closure wording; stock movements also passed at 320px. |
| Remote CI | Pending |
| Reviewed database migrations and function deployment | Private server-side database/source backup verified. Calls, immediate EOD, phone search and atomic Review migrations applied; new functions/indexes verified. Notification source deployed and hashes matched; Edge runtime restarted. Blacklist notice activation follows client publication. |
| Web deployment and smoke check | Pending |
| EAS preview update group / Android update ID | Pending |
| EAS runtime and source-commit verification | Pending |
| Real Android call and notification checks | Pending Uzo/tester verification after installation |

## Supporting records

- [Already released work and selective integration audit](2026-09-28-existing-release-audit.md)
- [Maintenance/workflow inventory and validation](2026-09-28-maintenance-audit.md)
- [Combined workflow verification results](2026-09-28-workflow-validation.md)
- [Call tests and Android checks](../call-session-tests/README.md)
- [Blacklist behavior, tests and release requirements](../blacklist-notice-tests/README.md)
- [Immediate EOD implementation](../eod-reliability-20260921/immediate-manual-eod.md)
- [Phone search](../eod-reliability-20260921/phone-search.md)
- [Closure wording](../eod-reliability-20260921/closure-wording.md)
- [Atomic Review save](../eod-reliability-20260921/review-save.md)
- [Paused Uchenna investigation](../same-customer-uchenna-investigation-paused-20260928.md)
