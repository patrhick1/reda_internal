# Manual fee waivers

An authorised fee correction previously entered `manual_review` merely because
the customer group contained multiple deliveries. Unequal stored base rates
were also checked before explicit payout decisions, hiding the intended zero.

Explicit rider amounts, including zero, now remain final. Baseline validation
applies to amounts still calculated automatically. Full/half ordering and
successful-delivery eligibility are unchanged. A material change to a waived
delivery's rider/customer/completion context still needs confirmation; adding
another delivery alone does not invalidate the waiver. Settled handovers and
independent completion-date checks retain their guards.

The existing correction RPC remains supported. The updated form has a shared
server calculation preview, separate client-charge/rider-pay inputs, explicit
override intent, stale-preview detection and idempotent save requests. Saving an
entered amount unchanged can explicitly confirm that amount. An untouched rider
field never turns a client-charge adjustment into a rider-pay override.

Reconciliation loads paginated issue/waiver details when an admin expands a rider
card. It shows the affected order, explanation, actor and saved reason, with a
direct order link. `Adjust pay` is available beside rider pay without requiring
a negative margin. Automatic base-rate editing is labelled separately.

## Verification

The fixed localhost PostgreSQL service used by the maintenance CI suite also
runs `test-runner.mjs` and `test-concurrency.mjs`. Tests cover before/after
completion, waiving either or both deliveries, nonzero adjustments, unequal
automatic/manual rates, preserved baselines, same-amount decisions, retries,
third deliveries, reversals, stale previews, cash/read-model agreement,
individual/bulk handovers, completed settlements, role boundaries and independent
date problems. Real concurrent sessions exercise duplicate requests, competing
edits and handover/edit contention. Fixtures are synthetic and cleaned up.

`test-ui.mjs` exercises the exported app using intercepted synthetic responses:
issue-to-order navigation, separate fee inputs, zero preview, stale-save
recovery, visible saved waiver and handover amount. It never sends a test action
to production. The existing maintenance and early-rollover suites run alongside
these tests. Native device interaction is not implied by browser verification.

## Release and recovery

The migration changes calculation and adds API/audit support without recalculating
historical groups. Before release, inspect affected open periods and preserve
their actual decisions. A separately approved repair restores the incident pair
to one paid delivery and one waived delivery, using its existing audit history.
Rehearse that repair in a rolled-back transaction and verify exact totals before
committing it. Do not automatically rewrite closed handovers.

The existing rider/date and active-group indexes bound calculation to affected
groups. Review signatures are computed once per affected calculation. Detail
reads are paginated; ordinary rider cards do not load every delivery up front.
