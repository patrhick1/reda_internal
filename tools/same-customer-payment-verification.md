# Payment compatibility verification — 16 September 2026

## Verdict

Core local payment tests passed. Automatic payment activation remains blocked by
legacy-client compatibility and release validation. No production database was
accessed or changed during this verification; no payment policy was activated.

## Fresh results

- Full isolated PostgreSQL integration runner passed: discovery, shadow pay,
  final full/half projection, actual Lagos completion day, retries, reversal and
  re-delivery, normal-fee corrections, manual exceptions, frozen settlement
  protection, pending-pay blocking, financial readers, permissions and pagination.
- Final-pay simultaneous completions passed: second writer waited 2,086 ms;
  exactly one full and one half earning.
- All 11 settlement concurrency cases passed. Coordinated cases waited
  1,996–2,053 ms; direct conflicting writes returned retryable errors in 123 ms;
  an independent rider settled in 107 ms. These are local timings, not production
  throughput guarantees.
- 21 JavaScript tests passed: delivery-payment (10), client-balance (5),
  delivery-pay (1), replacement earnings (2), offline occurrence/retries (3).
- Full application TypeScript check passed.

## Reproduced compatibility gap

`tools/test-same-customer-legacy-compatibility.sql` creates two synthetic completed
orders, then an unacknowledged manual fee exception. The canonical reader reports
2 pending payments and no final total. The legacy deliveries_safe projection still
contains a numeric total of 4,000.00. This demonstrates that the underlying legacy
projection does not encode pending pay and must not be treated as final earnings.

This projection diagnostic ran as the local database owner with the synthetic
rider identity: authenticated SELECT on deliveries_safe is absent in this
schema-only clone. It does not establish the current production view grants or a
real API exploit. Existing role-based financial RPC checks passed separately.

The deployed discovery-only web source still calls the old earnings summary.
The full local implementation has versioned readers, but older direct-view clients
and external reports remain unverified. Shipping only the calculation engine is
therefore insufficient.

## Release gates still open

1. Protect or retire legacy financial reads and ship compatible web/native clients.
2. Validate through a real API/browser and native offline queue; database tests and
   earlier browser mocks are separate evidence.
3. Complete outstanding writer/race coverage (identity merges, deletion, sub-agent
   ownership and rollover), refresh schema comparison, and rehearse representative
   historical volume. Existing tests do not prove these paths.
4. Reconcile representative shadow results with operations and implement the audited
   activation/suspension workflow with an agreed future Lagos boundary.

## Isolation

Tests used localhost:55439 / reda_same_customer_test, an existing schema-only
local test cluster. Synthetic transactions rolled back; concurrency runners
restored their empty checkpoints. Final counts: deliveries=0, users=0, earnings=0.
