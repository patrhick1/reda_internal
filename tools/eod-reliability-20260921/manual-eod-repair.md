# Manual end-of-day repair

The preceding maintenance release incorrectly applied the automatic cutoff to manual end-of-day and disabled the RPC still used by Reconciliation. Manual closing before 23:59 therefore failed. Assignment itself retained the original scheduled date, so assigning those unprocessed orders left them on the old day.

## Behavior

- Finish today is available before the nightly cutoff. The saved review fixes the next working day as the destination; Saturday prepares Monday.
- One reviewed operation combines ordinary rollover and postponement release. Existing carry limits, client policies, duplicate handling, replacements, payment/stock guards, and protected records remain in force.
- Updated screens show source/destination, action totals, paginated details, and actual processing progress. All three Reconciliation buttons open this workflow. Skipped groups show a partial result.
- Prepared orders open in an explicitly dated Unassigned view. The usual Unassigned queue still spans all dates. Assignment displays and verifies selected dates atomically; it does not reschedule orders.
- Older installed clients retain the original scalar rollover RPC. It returns completed rollovers synchronously, or rolls back the entire request on failure. New clients use bounded background batches.
- The automatic 23:59 Lagos fallback and morning catch-up remain in place. They preserve prepared orders/assignments and can process late additions.

## Efficiency and safeguards

Each sibling group is reviewed and locked as a unit. The existing worker, financial lock order, retry budget and stable effect identifiers are reused. A private saved approval permits early release; automatic and public permission boundaries stay intact. Large reviews are paginated for display without truncating submitted work. Revision checks skip changed groups instead of overwriting accepted human actions.

Local synthetic load tests: 419 and 4,190 additional orders, no failed groups or duplicate children. At 4,190 orders, preview/enqueue took 8.5 seconds and the longest worker batch took 6.2 seconds. These are local measurements with concurrent app builds, not a production latency guarantee. The legacy compatibility RPC remains synchronous; updated screens are the scalable path.

## Verification

- SQL suites cover Monday, Tuesday and Saturday manual finish; early cutoff separation; postponed releases; carry/client/duplicate rules; held records; replacements; double submission; assignment; nightly/morning preservation; and late orders.
- Failure tests cover actual legacy completion counts, rollback after a second-group failure, stale snapshots, assignment date mismatch, preview expiry/day changes and role boundaries.
- Concurrent sessions exercise rider/worker contention, exclusion of overlapping workers and legacy calls, and unique history effects.
- The actual exported UI is exercised at desktop and phone widths with synthetic, intercepted API responses. Database semantics are tested separately against PostgreSQL. UI coverage includes all three Reconciliation entrypoints, saved-preview pagination, confirmation scope, completion gating, dated Unassigned, guarded assignment and returning to all dates.
- CI runs the PostgreSQL/HTTP suites, app type/lint/format checks, and exported-browser workflow test. No test calls the live backend.

The 17-order incident is handled separately from the code migration. The owner explicitly chose to keep the 12 carry-limit orders protected for Uzo's review; only the 5 eligible orders are to be repaired to September 22 with Uzo's recorded agents and unchanged payment policy.
