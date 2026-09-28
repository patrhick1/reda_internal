# Existing-release audit for the 28 September 2026 publication

This is a source and release-record audit, recorded before the new publication.
It distinguishes new fixes from older work that still appears dirty in the
original checkout. It does not itself claim a deployment was performed today.

## Why the original checkout is not the release baseline

The original checkout's `main` is `ecb6569`, dated 10 September. The fetched
`origin/main` is `7dd947b`, fourteen commits ahead. Several earlier releases were
built from separate checkouts, leaving their source changes and migration files
uncommitted or untracked in the original directory. Those files are not evidence
that the corresponding feature is unpublished.

The new release must start with current `origin/main` and add verified new
patches. Replacing current main with the original working tree would undo the
already approved simpler reconciliation/end-of-day screens and rider-fee fixes.
Preserve the original working tree as the historical work-in-progress copy.

## Already released work to preserve

| Problem | Existing solution | Release evidence and status |
| --- | --- | --- |
| Separate orders for the same customer were difficult to discover across riders/vendors. | Scheduled-day phone matching, related-order inspection, and explicit manual assignment/correction; logical duplicate copies are counted separately from genuine purchases. | Discovery web trial `8f49512`, 16 September; full payment/client release `a1355b7`. See the same-customer rollout records below. |
| Same-customer rider fees and financial displays needed one consistent rule. | First eligible successful delivery earns the full fee; further eligible deliveries for the same rider/customer/Lagos completion day earn half. Preserve normal rates, audited manual exceptions, successful-rider ownership, pending values, and settled financial snapshots. Compatible earnings/reconciliation/detail readers and offline occurrence handling were shipped together. | Backend/client release `a1355b740853505e28293f08a3fdefd81f6f2f7c`; EAS group `149ced59-b93c-4de7-a134-f7dd77668c57`, runtime `1.1.1`. Policy scheduled for 17 September 00:00 Africa/Lagos. This calculates amounts; it does not send money. |
| Reps could inspect customer matching, beyond the owner's intended audience. | Admin/Dispatcher-only server guards and matching UI/query permissions. | Web `4584994b4f5955c778c9c7a15ff022a8fac57fac`; preview group `d1a3a6eb-53aa-41cf-addb-796869e46cf6`, 17 September. |
| An unconditional customer-matching action cluttered ordinary delivery detail. | Show the matching link inside the Customer card only when relevant; retain a discreet correction-review link for manually separated orders. | Published commit `394d23b`, 17 September, documented in the UX review. |
| Postponements/end-of-day work could be missed or depend on opening the app. | Resumable server processing, bounded work, retries, stable operation identifiers, and monitoring independent of app login. | Merged release `dd8f8ea` on 21 September, followed by manual-EOD repair `d0f39e0`. Retain the subsequent simpler user-facing workflow. |
| Early manual closing and already prepared next-day assignments were mishandled. | Permit deliberate early closing; preserve prepared orders and assignments; process later additions safely and show Roll forward and Close out separately. | `d0f39e0`, 21 September; later UX restoration described below supersedes its technical dashboard. |
| Intentional zero rider fees and some other agreed fees unnecessarily blocked handover. | Audited fee adjustments accept waivers, preserve client charges, and distinguish legitimate changes from actual unresolved problems. Missing-charge and unchanged-fee edge cases are explained by the form. | `cc7ab0e` and `76878b8`, 22 September git dates; release verified in the UX record on 23 September. |
| Maintenance notifications and financial-review terminology overwhelmed routine work. | Restore familiar reconciliation tabs/filters/three amounts; keep genuine fee issues with the affected rider and link to that order. Restore simple EOD lists and one action; suppress routine processing pushes and retire maintenance holds. | Web release verified at `76878b875d6874fa3fac4f83d3b929b684a6109f`; preview publication later approved and completed 23 September, group `fe1010a7-c9c3-4e67-8d3e-a28392fb1e02`, runtime `1.1.1`. |
| Decency's delivered update needed a clearer payment breakdown. | Its per-order share format shows Customer paid, Delivery fee, and To remit; the server allows the necessary client-specific fields. Other client formats remain unchanged. | Published 27 September at main `758c9ec`; preview group `e452a75f-f7e9-411c-95ca-ba2cb00579fe`, runtime `1.1.1`. The maintenance audit checked the release record's database and web/native asset verification. |
| Maintenance CI fixtures depended on the weekday and could fail on Sundays. | Reliable weekday/Sunday fixtures and explicit checks for the relevant behavior. | Already merged in `7dd947b`, 27 September. Preserve this CI repair rather than copying stale workflow files. |

Recorded earlier validation includes isolated SQL integration and concurrency
tests, actual local API checks, browser workflow checks, TypeScript/lint, and
published-bundle verification. Those historical results are not a substitute for
testing the combined release. Publication also does not prove installation or
physical-device behavior on every Android phone.

## Today's new user-facing deltas in the original checkout

The release's main change log should describe these as new work, with its final
validation and actual publication identifiers recorded after release:

- **Cross-platform confirmations:** warehouse issue reason changes stalled on web
  because the native confirmation did not run there. A shared alert/dialog
  implementation now supports both Android and web and is used for other affected
  confirmations, including financial void/handover actions.
- **Call lifecycle:** navigating Back could strand a ringing server call, make
  retries fail, and expose an object-shaped error. App-wide session ownership,
  return/end controls, recovery, same-device resumption, immediate expiry checks,
  and readable errors address this. Its server migration must accompany the
  client release. Real-device call/audio validation remains necessary.
- **Blacklist feedback:** blocked bot orders had review records but no active
  notice; a failed manual submission also needed an explanation on its form.
  Grouped notices, quiet/coalesced push behavior, links to blocked records, and
  inline manual-order errors address those gaps. Its database/notification
  changes are release dependencies, not something EAS uploads by itself.
- **Shared stock update:** active zero-stock products were excluded together
  with inactive products. Shared reports now include active products marked
  Out of stock, keep inactive products hidden, and remain shareable when all
  active products have zero stock.

The EOD latency work has separate local changes in another checkout and must be
included in the complete publication inventory; this audit does not replace that
task's implementation and validation record.

## Exact integration boundaries for earnings and reconciliation

Compared with fetched `origin/main`:

- `mobile/app/(agent)/earnings.tsx`,
  `mobile/src/services/reconciliation.ts`, `mobile/src/lib/reconcile.ts`,
  `mobile/src/services/deliveries.ts`, and the payment-contract/queue occurrence
  changes have no new patch. They already exist on main. In particular, the
  weekly/monthly earnings upper date bound and pending-pay handling are not new
  fixes today.
- `mobile/app/(agent)/today/index.tsx` has only the new shared Alert import.
- `mobile/app/(admin)/reconcile/client/[id].tsx` has the shared Alert migration,
  including removing separate browser alert/confirm branches for voiding a
  payout or received payment. Preserve its financial behavior.
- `mobile/src/screens/deliveries/List.tsx` has only the shared Alert migration
  and unified assignment/queue/bulk-action feedback.
- `mobile/src/screens/deliveries/DeliveryFieldsForm.tsx` has the shared Alert
  migration for the change-client confirmation.
- For `mobile/app/(admin)/reconcile/index.tsx`, apply only the shared Alert
  migration to current main: native imports, `notify`, un-settle confirmation,
  and handover confirmation. Do not copy back the obsolete Pay review filter,
  duplicated known-earnings amounts, or removal of `AgentPayDetails`.
- For `mobile/src/screens/deliveries/Detail.tsx`, apply the shared Alert import,
  session-based call import, and `errorMessage` use for failed notification/call
  actions. Preserve current main's Change rider fee action, `riderFeeOnly`
  handling, Agreed fee wording, and `CorrectChargesSheet`'s `riderOnly` prop.
- The original untracked same-customer hooks/service/components and
  earnings/payment-upgrade helpers/tests mostly hash-match current main. The
  original `SameCustomerPayReview.tsx` contains obsolete review wording; use
  current main's version. Do not treat missing tracked files in the old checkout
  as intentional deletions.

## Investigations and proposals that are not fixes

- **Uchenna duplicate/same-customer report:** explicitly paused while the owner
  asks Uzo whether the entries are separate purchases or re-forwarded copies.
  Existing duplicate grouping explains the absent group; no matching-rule or
  customer-record change is authorized by this investigation alone.
- **Postponed orders moving down the list:** the owner requested a response to
  Uzo asking whether to retain original positions. No new sorting rule has been
  approved or implemented.
- Intentional split-rider acknowledgement, pickup context, fee-impact previews
  for customer corrections, and extra candidate-group visibility remain earlier
  proposals. Do not silently include them in this release.

## Evidence

- [Same-customer rollout and published client identifiers](../same-customer-payment-rollout.md)
- [Matching UI release and remaining proposals](../same-customer-ux-review-2026-09-17.md)
- [Business workflow restoration and later EAS publication](../../reda_ux_simplification_plan.md)
- [Maintenance audit, including the Decency release record](2026-09-28-maintenance-audit.md)
- [Paused Uchenna investigation](../same-customer-uchenna-investigation-paused-20260928.md)
- [Call investigation](../call-back-button-investigation-20260928.md)
- [Call tests and release dependencies](../call-session-tests/README.md)
- [Blacklist tests and release dependencies](../blacklist-notice-tests/README.md)
- Git comparison: `ecb6569..7dd947b` and file comparisons against `origin/main`.

Some older implementation reports retain explicitly superseded statements that
payment activation or native publication was pending. Use their final rollout
sections and published identifiers instead of interpreting an older checkpoint
as current release status.
