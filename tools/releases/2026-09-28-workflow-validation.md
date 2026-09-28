# Combined release workflow validation — September 28, 2026

These checks used the integrated `september-28-preview-release/Reda-dev`
worktree based on main `7dd947b`, after combining the pending fixes. They are
local verification, not proof of production publication or physical Android
behavior. Every command below passed with exit code 0.

## Isolation

A fresh PostgreSQL 17 cluster was created under the task's temporary directory,
listening only on `127.0.0.1:55449`, role `reda_test`, database `reda_eod_test`.
PostgREST 14.12 used the existing test configuration on `127.0.0.1:55451` and
the payment-contract pre-request hook. Scripts verify the database identity
and empty synthetic fixture before testing. Notification/network database
functions are fixture stubs; no real notifications were sent.

Browser tests served the integrated `mobile/dist` export on localhost:55453.
Tests intercept application API traffic; real-HTTP tests forward only their
specified API operations to the isolated local PostgREST. No browser test sends
requests to production. Chrome ran headless using the bundled Playwright.

## Commands and results

Run commands from the release repository root. Browser commands used
`PLAYWRIGHT_MODULE_PATH` pointing at the installed bundled Playwright package
and `EOD_UI_BROWSER_CHANNEL=chrome`.

```text
node tools/eod-reliability-20260921/test-runner.mjs --setup
node --experimental-strip-types --test mobile/src/lib/delivery-search.test.mjs
node tools/eod-reliability-20260921/test-immediate-http.mjs
node --experimental-strip-types tools/eod-reliability-20260921/test-phone-search.mjs
node tools/eod-reliability-20260921/test-review-save.mjs
node tools/manual-fee-waivers/test-runner.mjs
node tools/manual-fee-waivers/test-concurrency.mjs
deno test --no-check --no-config --node-modules-dir=none --allow-net=127.0.0.1:55451,127.0.0.1:55452 --allow-env tools/test-eod-compatibility.ts
node tools/eod-reliability-20260921/test-stock-wrap.mjs
node tools/eod-reliability-20260921/test-immediate-http.mjs --browser-only
node tools/eod-reliability-20260921/test-review-save.mjs --browser
node --experimental-strip-types tools/eod-reliability-20260921/test-phone-search.mjs --browser
node tools/eod-reliability-20260921/test-manual-eod-ui.mjs
node tools/manual-fee-waivers/test-ui.mjs
node --experimental-strip-types tools/eod-reliability-20260921/test-closure-display.mjs
```

The final mock EOD and waiver commands ran with `EOD_UI_WIDTH=390` and `1280`.
The waiver command also ran at width 390 with `FEE_UI_EDGE_CASE=missing` and
`confirm`. Other browser suites iterate their widths/scenarios internally.

### Database and API coverage

- Fresh migration installation; maintenance across all seven weekdays;
  rescheduling failures; group permissions; manual EOD Monday/Tuesday/Saturday
  through both scheduled and immediate execution; manual failures; historical
  scaling; simple workflow regression.
- Phone search helper: 3 tests. Real API primary/alternate format matrix,
  embedded views, role-scoped visibility, soft deletion, names/fragments,
  Failed and Same customer search, edited numbers, 100-result bound and indexed
  search over 20,011 synthetic orders. Final indexed executions were 13.615ms
  for a full number and 7.400ms for a fragment.
- Atomic Review save: original message and all form fields, multiple products,
  idempotency, concurrent devices, dispatcher/agent/anonymous permission checks,
  stale link/discard protection, missing/expired/stolen locks, transaction
  rollback and corrected retry, blacklist, unassigned/date/fee parity and
  independent-source behavior under contention. The documented old-client
  independently-created-order limitation remains explicit and tested.
- Existing waiver integration and actual simultaneous save/settled-handover
  contention passed. Scheduled HTTP payment-gate tests: 2 passed.
- After the workflow setup, both `20260928120000_call_session_recovery.sql` and
  `20260928140000_blacklist_notices.sql` applied successfully to the same
  synthetic database. All real browser/API suites then ran with these extra
  migrations installed. Their feature-specific suites are documented elsewhere.

### EOD HTTP and browser timing

Real HTTP EOD used committed batches and no scheduled worker for the normal
latency matrix. Permissions, SERIALIZABLE enforcement, approved scope, retry
delays, operational pause, changed orders, group atomicity, bounded continuation,
failure/reapproval, simultaneous users, manual/scheduled exclusion, app-absent
recovery and saved weekend/midnight destinations passed.

| Current groups | Batches | Total including preparation/submission |
| ---: | ---: | ---: |
| 0 | 1 | 0.155s |
| 1 | 1 | 0.104s |
| 99 | 1 | 1.820s |
| 100 | 1 | 1.968s |
| 101 | 2 | 1.951s |
| 153 | 2 | 3.014s |
| 1,530 plus 20,000 historical orders | 16 | 24.765s |

The scale run's slowest batch was 1.935s. The deliberately slow 11-second atomic
group also completed without creating a new timeout/retry threshold.

| Real browser: 153 groups | Phone, 390px | Desktop, 1280px |
| --- | ---: | ---: |
| Normal | 1.866s | 1.864s |
| First execution response lost after commit | 4.918s | 4.897s |
| Reload after first committed batch | 2.594s | 2.559s |

These are local test measurements, not production latency guarantees.

### Other browser results

- Review normal click-to-return: 389ms phone and 419ms desktop with a deliberate
  300ms delay per mutation. The old three-request chain in the same browser took
  969ms and 961ms. Lost/failed-response scenarios retained values and produced
  one saved order after retry at both widths.
- Phone search: equivalent formats, alternate contact, partial/name search,
  no result, and previous-delivery replacement lookup passed at 390px/1280px.
- EOD mock workflow: cancellation with no request, full-scope confirmation,
  pagination, actual completion gating, connection/reload recovery,
  prepared-date assignments and all three Reconciliation entry points passed
  at 390px/1280px. Tests click the shared HTML alert dialog.
- Rider fee mock workflow: zero waiver, unchanged confirmation, missing client
  charge, current-pay prefill, stale save recovery and exact handover passed.
- Policy closure: manual/historical closures, genuine failure and an ancestor
  closure that must not relabel the current order passed at both widths.
- Stock movements: full secondary descriptions wrap at 320px/390px, remain
  readable at 1280px and do not overlap quantity/time. No page runtime errors.

The integrated app's lint, typecheck, Android/web exports, call-specific and
blacklist-specific checks are recorded by the main release task separately.
