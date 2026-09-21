# Order maintenance reliability

The nightly job previously depended on an authenticated app client. Payment
contract enforcement rejected that caller before order processing started.
Maintenance now uses a private PostgreSQL entry point with a fixed System actor.

## Execution

- Dispatcher and worker run once per minute in separate committed transactions.
  Dispatcher enqueues the 23:59 Lagos release/close boundaries, catches missing
  runs after restart, and reconciles due work again at 06:00 Lagos.
- One worker claims at most 100 complete sibling groups, with a 12-second soft
  invocation budget. Production jobs also have a 20-second statement timeout
  and 2-second lock timeout. No batch closes an in-progress business day.
- Failed transient groups retry after 5/10 minutes, with three attempts total.
  Configuration/data errors require review. Claims left behind by a dead worker
  are detected after three minutes. Successful groups are not repeated.
- Native and manual processing share classification and mutations. Manual
  previews expire after 30 minutes, include at most 500 orders without splitting
  a group, and retain the reviewed revisions. Changed groups are skipped.
- Groups larger than 500 orders become explicit exceptions. Protected incident
  rows are excluded until their revision changes or an operator resolves the
  hold with an audited note. Held siblings do not block other eligible copies.
- Notifications are saved with the order transaction and submitted separately.
  HTTP/provider failures are retried. Provider acceptance does not prove device
  delivery; an ambiguous timeout can produce a repeated push.
- Health includes completed outcomes, pending/failed/changed groups, protected
  rows, scheduler check-ins and notification failures. A five-minute monitor
  detects stale/missing runs and overdue work. The external GitHub heartbeat
  checks server/scheduler health every 30 minutes; GitHub scheduling can be delayed.

The fixed actor must remain the active `system@reda.local` admin with ID
`2d8d5895-d2a8-4900-b15e-7662b176a805`. Anonymous and ordinary authenticated
callers cannot invoke the worker or access its tables. The public external
heartbeat returns only a boolean, timestamp and version.

## Validation

Use PostgreSQL 17 on **localhost:55449** with role `reda_test`. The runner has no
production connection option. For a fresh database named `reda_eod_test`:

```
node tools/eod-reliability-20260921/test-runner.mjs --setup
```

The compressed baseline is schema-only and has outbound integrations sanitized.
Its checksum is verified. Only status definitions/transitions are fixture data;
orders and users are generated synthetic records and rolled back after tests.
`build-test-fixture.py` documents regeneration from a private schema capture.

The suites cover boundaries, carry rules, complete sibling groups, policy clients,
replacements, native-role permissions, audit identity, stale/offline rescheduling,
immutable promised dates, held/changed rows, partial failures and recovery,
worker loss, and notification timeouts. The real PostgREST payment gate is also
exercised using the scheduled-client factory; an old client remains blocked.

For a fresh separate `reda_eod_race` database, `--setup --race` checks concurrent
rider/worker activity and overlapping workers. For a fresh `reda_eod_bench`
database, `--setup --bench` measures separately committed batches at 1x/10x/50x
the observed 419-delivery daily peak. Both modes are localhost-only and clean
only their explicitly named synthetic database.

Recorded local load results (not production capacity guarantees):

| Orders | Batches | Slowest worker batch | Total test processing |
|---:|---:|---:|---:|
| 419 | 6 | 3.1 s | 11.4 s |
| 4,190 | 43 | 3.3 s | 101.2 s |
| 20,950 | 211 | 5.1 s | 663.9 s |

All runs had zero failed groups and duplicate children. At one batch/minute,
211 batches take about 3 h 31 min plus scheduling/retry delays, within the
six-hour morning window in this test. Load and lock contention must still be
monitored in production. The first untuned 50x run was interrupted to remove
per-group summary recomputation; the completed measurements use per-batch totals.

## Deployment and rollback

Apply the six versioned maintenance migrations together with the private
incident-hold manifest and scheduler cutover in one transaction after backup.
Verify deployed business-function checksums before applying. Disable the old
HTTP schedule in that transaction; only the native jobs own processing.
Deploy the notification provider-error fix and updated app alongside the API.

Set repository Actions variable `REDA_PUBLIC_ANON_KEY` to the existing
publishable anon key. It is not a privileged credential. Actions failure
notifications follow the repository/account notification settings.

If the worker misbehaves, set `reda_maintenance.settings.enabled=false` and
disable the three `reda-maintenance-*` cron jobs. This preserves committed
orders, work records and audit history for inspection. Correct the failing
operation and resume with its existing work IDs. Do not restore the unsafe
all-dates RPC or blindly reverse completed orders.

Diagnostics: successful notification attempts are retained for 30 days,
completed work details for 90 days, and previews for seven days. Runs retain
aggregate outcomes. Unresolved failures/holds remain visible. Order history and
financial audit records are never deleted by maintenance retention.
