# REDA UX findings and simplification plan

Recorded: 23 September 2026, Africa/Lagos.

Status: implementation authorized on 23 September 2026. The owner explicitly instructed: no order protection, thorough tests, and publication to web only for acceptance testing. No EAS/native update is authorized for this release.

## Owner's product direction

The owner prefers simple, familiar workflows for nontechnical business users. Reliability improvements must not make ordinary work more complicated.

Specific directions:

- Remove the new order-processing notifications.
- Restore the familiar end-of-day screen from roughly two weeks earlier.
- Show Roll forward and Close out separately, as the previous screen did.
- Restore the familiar reconciliation layout and remove unnecessary financial-review clutter.
- Explain a proposed feature's business benefit and its simplest user experience before introducing it.
- Document the identified issues and explain the incident-specific protected orders.

Working rules for future changes:

1. Preserve existing terminology, navigation, and successful business workflows by default.
2. Do not expose jobs, queues, workers, revisions, internal IDs, or recovery infrastructure in routine screens.
3. Show one clear primary action for the task being performed.
4. Show exception information only when an actual exception affects the current task.
5. Do not ask users to reconfirm an intentional decision merely because an internal calculation changed.
6. Keep calculations, audit history, retries, concurrency checks, and settled-money protection in the background.
7. State plainly when an action changes money, dates, assignments, or closes an order.
8. Present any additional workflow or feature as a proposal with its benefit, user steps, and before/after example. Do not silently bundle it into a bug fix.
9. Verify familiar tasks with realistic business examples, not only technical tests.

## What protected orders meant

A protection hold was an incident-specific instruction to the maintenance system: do not automatically roll over or close these particular records while their correct handling is being reviewed. Both scheduled processing and the new manual end-of-day path checked the hold.

It was not a normal delivery status, customer blacklist, cancellation, payment protection, or a ban on all manual edits. Existing status and assignment operations could still edit the order.

During the manual-rollover incident, 17 affected orders were reviewed. Five could be carried under the rules then applicable; twelve would have reached the carry-limit closure. The owner selected keeping those twelve for Uzo's review instead of automatically closing them as Unserious. That was temporary incident containment, not approval for a permanent protected-order management feature.

The assistant did not explain the operational meaning clearly enough. The owner subsequently instructed that no order be protected. That instruction supersedes the earlier temporary containment decision: retire every unresolved maintenance hold and apply normal business rules.

The implementation was defective: it required the order's last-edit timestamp to match the timestamp recorded in the hold. Ordinary edits could therefore make an unresolved hold ineffective. The protected-order list used the same condition, so the order could disappear from that list without an explicit release.

Last production observation, approximately 01:30 Lagos on 23 September:

- Nine of the twelve remained held and pending.
- One had been postponed to 25 September and its hold no longer matched.
- One was automatically closed as Unserious at midnight.
- One was rolled into a pending order for 23 September at midnight.

This is a timestamped observation, not a guarantee of present state. Any repair must first read the latest order histories, descendants, assignments, completion and financial records. Do not blindly reverse completed work or roll all twelve forward. The later owner instruction authorizes removing all holds; it does not authorize bypassing normal carry limits, choosing arbitrary dates, or reversing completed transactions.

## Confirmed issues from the review

| ID | Finding | Business impact | Review status |
| --- | --- | --- | --- |
| UX-01 | Unresolved protections can expire silently after an ordinary edit, and disappear from the protection list. | The interface promises explicit review but automatic processing can still close or move the order. Two incident orders were processed after protection stopped applying. | Implemented: all maintenance holds removed by later owner instruction. |
| UX-02 | Processing pushes expose internal outcome codes, describe closures as success, and resend cumulative historical totals without identifying them as such. | Uzo cannot tell which actions happened now, which day was processed, or whether an order was delivered, moved, or closed. | Implemented: processing pushes suppressed at their producer and pending retries retired. |
| UX-03 | Recovery pushes reuse the original failure message; the overdue condition can clear when the time window changes. | A recovery message can contradict itself or imply a verified resolution that has not been established. | Implemented: no recovery push; an active overdue alert persists across midnight until the condition clears. |
| UX-04 | The end-of-day page exposes recent jobs, group counts, technical statuses, worker check-ins, recovery options, and internal identifiers. | Routine closing becomes a technical administration task. | Implemented: technical dashboard removed from EOD. |
| UX-05 | The replacement preview mixes rollovers and closures; the previous screen separated them. | Consequential closures are harder to distinguish from preparing tomorrow's work. | Implemented: Roll forward and Close out sections restored. |
| UX-06 | Reconciliation moves affected riders out of Outstanding into Pay review and introduces repeated pending/known-total terminology. | A problem with a small number of orders makes the entire rider account confusing and hard to finish. The latest issue links help, but the overall structure remains complicated. | Implemented: familiar filters restored; genuine fee issue stays with the rider in Outstanding. |
| UX-07 | Healthy rider cards show both Rider pay (kept) and Known rider earnings. | Users see duplicate numbers and an unnecessary distinction even when there is no issue. | Implemented: normal rider cards show only the three familiar amounts. |
| UX-08 | Fee editing presents several similar concepts and correction paths: agreed pay, automatic base rate, current payable, earning, and manual exception. | An operator can change the underlying rate while intending only to waive a particular delivery's fee. | Implemented: direct rider-fee editing preserves the client charge and accepts zero. |
| UX-09 | Different riders keep a same-customer group flagged even when the split was deliberate. | Valid operating decisions produce persistent warnings and reduce trust in alerts. | Open; no additional acknowledgement workflow approved. |
| UX-10 | Customer-match corrections request a reason without previewing their applicable effect on rider fees. | A correction that looks organisational can change earnings unexpectedly. | Open. |
| UX-11 | The matching assignment view lacks pickup context, and a delivery's detail view does not surface extra candidate groups. | The operator does not have all the relevant information for matching and assignment decisions. | Open; proposals only. |
| UX-12 | Tapping a rider's name in the matching picker immediately applies assignment. | A control labelled Choose rider also commits a live change without clearly stating that effect. | Open; clarify the action without assuming an extra confirmation dialog is necessary. |

Previously introduced problems already repaired in released code:

- Manual rollover blocked before the automatic cutoff: early manual closing was restored.
- An intentional zero rider fee triggered unnecessary review: explicit waivers were repaired in the latest release.
- Customer matching appeared on ordinary single deliveries: the unconditional action was removed.
- The entire fee review panel appeared above ordinary delivery details: it was moved into collapsed payment details.
- Reps could see customer matching: access was restricted to Admin and Dispatcher.

These repaired items remain regression cases; do not present them as currently unfixed.

## Verified historical baseline

- Around two weeks earlier: commit `eee47fa572b4f8d23bceb0bd00a1c16af2c72d6c` from 9 September.
- Latest baseline before the new matching/payment work: `ecb656910c62091109ee5d1ac58d4665a016c67e` from 10 September.
- The old end-of-day screen already used separate Roll forward and Close out sections, business-facing order cards, counts, and one Run end of day button.
- The familiar reconciliation tabs were By client, By agent, and Summary. Agent filters were Outstanding, Handed over, Nothing due, and All. Rider cards showed customer collections, rider pay kept, and amount to remit.
- The 10 September client payment-received feature is unrelated to the later complexity. Preserve that existing business function when restoring the familiar reconciliation layout.
- Restore the presentation and business workflow against these references. Do not restore old RPC implementations or numeric fallbacks that could reintroduce broken rollover or misleading financial totals.

## Proposed implementation plan

### 1. Remove processing notification noise

- Stop the added Order processing success, recovery, and needs-attention pushes to business users.
- Apply the suppression to the processing notification producer and any undelivered processing notifications, without discarding their technical audit records.
- Preserve ordinary delivery, assignment, and other unrelated business notifications.
- Retain the already requested GitHub heartbeat and technical failure records for investigation.
- A manual action that fails should explain the failure where Uzo is working. Do not replace the removed pushes with a new notification category without discussing its benefit first.

### 2. Restore end of day

- Load the business preview automatically when the page opens; remove the separate technical preview step.
- Restore two distinct sections: Roll forward and Close out.
- Show the customer, product, rider, status, and a plain-language closure reason, using the old card layout as the starting point.
- Show the actual next working date so Saturday-to-Monday and evening preparation are clear.
- Keep one Run end of day action and one understandable confirmation showing the date and rollover/closure counts.
- Allow Uzo to finish when work ends, including 8–10 p.m. Lagos. Preserve the automatic fallback and the correct next-day assignment behavior.
- While the existing worker runs, show Working… and a short result when done. Hide technical job history, worker diagnostics, and recovery controls from the normal page. Only a real failure or changed order needs an actionable explanation.
- Separate sections do not mean introducing two mandatory operations. Preserve the familiar single closing action unless the owner explicitly requests independent execution.
- Keep bounded processing, duplicate prevention, stale-edit checks, and date correctness behind this simpler screen.

### 3. Restore reconciliation

- Restore the familiar By client / By agent / Summary layout and original business filters.
- Remove the separate Pay review filter, duplicate known-earnings rows, and technical financial vocabulary from the everyday view.
- For a normal rider account, show only customer money collected, rider fee kept, and amount to remit, with the familiar handover action.
- Keep client settlement, client payment-received, bulk handover, exports, and sharing behavior that predates the new complexity.
- Keep the agreed full/half calculation and intentional zero/nonzero fee adjustments. A correct manual waiver should immediately allow the normal handover flow.
- If there is a genuine unresolved fee, keep the affected rider visible in the ordinary unsettled list and show one local explanation such as One delivery fee needs checking, with a direct action to the affected order. Use an existing control or compact inline correction where practical rather than a separate review workspace.
- Do not show a guessed fee, zero, or an incomplete total as a final amount. If a total excludes an unresolved rider, explain the omission once in plain language. Do not mark that account handed over until its actual amount is known; other riders should remain usable.
- Restore the familiar EOD entry point from reconciliation using the same safe operation, with a clear target date and no technical intermediate dashboard.

### 4. Keep fee adjustment understandable

- Make the routine action Change rider fee, supporting zero and a brief reason; show what the rider will keep after saving.
- Keep Reda's client charge clearly separate so changing one does not silently change the other.
- Keep underlying rate and completion-date correction available only as secondary actions when relevant. Do not require routine users to understand the accounting model.
- Preserve recorded handovers and background audit/concurrency safeguards.
- Do not expand customer matching or add new screens as part of this restoration. The separate findings UX-09 through UX-12 remain documented for a focused proposal.

### 5. Remove all maintenance holds — owner-approved revision

- Retire every unresolved maintenance hold with an audit reason and make the legacy exclusion helper always return false.
- Preserve historical records. Ordinary edits cannot create or revive a protection exclusion.
- Let normal rollover, carry-limit closure, postponement, and assignment rules operate. Do not force a new date, reverse a completed transaction, or waive a carry limit.
- Pre-release read at approximately 02:30 Lagos on 23 September found 33 unresolved historical holds: 28 still matched their recorded revision. All 33 are in scope.
- Financial and stock safeguards remain separate; removing maintenance holds does not remove those safeguards.

### 6. Verify the simplified workflow and release

Business scenarios to demonstrate:

1. Close at 8 p.m. and 10 p.m.; the destination is the next working day.
2. Close Saturday; prepared orders are for Monday.
3. Rollover and closure lists are distinct; counts and reasons match the actual results.
4. Assign prepared orders; the overnight job does not shift or clear the correct preparation.
5. Retry/double-tap or a concurrent edit does not duplicate processing or overwrite a newer decision.
6. A normal rider handover follows the familiar flow with no review state or duplicate totals.
7. Two deliveries with one fee waived produce the agreed combined rider fee and allow handover.
8. A genuine unrelated fee issue identifies only the affected order and does not obscure other riders' accounts.
9. Previously recorded handovers retain their financial protections.
10. Routine order-processing pushes stop; ordinary business notifications continue.
11. No maintenance hold can exclude an order, before or after an ordinary edit.

Show a phone-sized before/after review of EOD and reconciliation. Validate calculations and worker behavior with the existing database/concurrency tests plus targeted coverage of these defects. Passing code checks alone is not sufficient evidence of a good business workflow.

Implementation should use the existing workspace structure rather than create more nested release folders. Any eventual cleanup of old worktrees must first preserve uncommitted work and private deployment evidence. No folder deletion is part of this documentation step.

## Beneficial capabilities and their simplest presentation

| Capability | Business benefit | Proposed presentation |
| --- | --- | --- |
| Reliable background processing | Orders do not remain stuck after a missed run. | Keep it behind the existing EOD action; show only brief progress and actual exceptions. |
| Rollover destination and closure preview | Uzo knows what will move and what will close. | Familiar two-section list with date and counts; one confirmation. |
| Financial correctness checks | Prevent incorrect remittance or changes to money already settled. | Normal totals when correct; a single order-specific explanation only when there is a real issue. |
| Intentional fee adjustment | Supports charge-once and waived-fee decisions. | One agreed rider amount, including zero, and a simple resulting total. |
| Technical monitoring | Detects server/scheduler faults without relying on Uzo opening the app. | Existing GitHub monitor and internal records; no routine processing push feed for business users. |

These capabilities do not justify broad new business workflows. Any further addition should be explained and reviewed in terms of the user's actual task.

## Evidence used

- Historical and current Git versions of `mobile/app/(admin)/eod.tsx` and `mobile/app/(admin)/reconcile/index.tsx`.
- Current `SameCustomerPayReview`, `AgentPayDetails`, `CorrectChargesSheet`, and `SameCustomerOrdersSheet` components.
- Maintenance queue/runtime/API migrations dated 21 September and manual EOD/waiver repair migrations.
- `tools/same-customer-ux-review-2026-09-17.md` in the original working directory.
- Live maintenance runs, notification records, and incident-order state read during the preceding review around 01:30 Lagos on 23 September.
- The owner's directions in this conversation.

Only this documentation file was created for the current request. App implementation, data repair, notification changes, and publication have not been performed in this step.

## Implementation and release verification

- Reused the existing release checkout; no additional nested checkout was created.
- EOD loads the familiar Roll forward and Close out lists with one Run end of day action. A submitted request survives reload, waits for confirmed results, and reports only its own orders. A fresh confirmed review can retry unfinished work.
- Reconciliation retains the familiar tabs, filters, three money rows and handover. Only genuine fee issues show an action; approved waivers never appear as unresolved issues. Rider fee edits preserve the client charge.
- Processing push producers are suppressed, and pending/submitted retry records are retired. Already delivered device notifications cannot be withdrawn. Ordinary business notifications remain enabled.
- The existing GitHub heartbeat and internal operational records remain. An existing overdue alert no longer falsely resolves just because midnight passed.
- Passing isolated checks: clean migration install; nightly/manual order suites including Monday, Tuesday and Saturday; stale previews and permissions; no-hold/no-processing-push rules; failed-run retries; 20,000 archived plus 500 active orders; fee waiver and handover suites; real concurrent saves; actual HTTP payment-contract boundary; phone/desktop exported browser workflows; typecheck, lint and formatting.
- UI publication target is https://app.redalogisticss.com only. Necessary hold/notification backend changes are shared with existing clients; no native bundle will be published.
- Findings UX-09 through UX-12 remain documented for a separate focused proposal, as agreed.
