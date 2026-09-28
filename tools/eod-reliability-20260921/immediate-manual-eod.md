# Immediate manual end of day

Local implementation verified on September 28, 2026, on branch
`codex/immediate-manual-eod`, based on main commit `7dd947b`. This fix has not
been pushed or deployed. Existing unrelated root-checkout edits were preserved.

The September 21–23 changes made the manual screen save work and wait for the
once-per-minute dispatcher and its worker's 25-second stagger. Runs above 100
groups needed a second scheduled batch. Live submissions on September 23–25
took 116–145 seconds despite approximately 2–3 seconds of actual processing.

The mistake was treating an interactive action as background-only work, then
accepting throughput tests that bypassed the production scheduling delay.
Reliability and correct outcomes were tested; the user's elapsed waiting time
was not. Restoring the simpler screen did not restore immediate execution.

## Implementation

The existing confirmation commits its saved approval through
`request_manual_eod`. The screen then calls `advance_manual_eod` immediately.
Each request processes only groups belonging to that submitted preview and
returns the saved result. Ready batches continue without a timer delay.

The executor uses the existing business functions and saved destination/actions.
It handles at most 100 complete groups, with a four-second soft processing
budget. An individual group is atomic and is never split to satisfy that budget.
The 20-second statement timeout and two-second lock timeout match the scheduled
worker, so the new path does not introduce a tighter failure threshold for a
large group. An invocation may exceed the soft budget while finishing one group.

The function requires an authorized operations user, that user's submitted
preview, and SERIALIZABLE isolation. Nonblocking worker and dispatcher locks
coordinate it with scheduled and legacy callers. Indexed run/group/revision
lookups select its work. Work outside the confirmed preview is not processed.
Completed effects are not repeated; failed groups need fresh approval and real
retry delays are respected. Only selected groups are claimed, and unstarted
work does not consume an attempt.

The screen continues to use its saved preview ID after a lost response or
reload. It reads committed status after an execution error before retrying,
backs off unsuccessful requests, and displays completion only after saved work
is complete. If the app closes, the existing scheduled worker remains a
fallback. The fallback can still take scheduled time; the normal interactive
path no longer depends on that schedule.

This adds no new screen, business decision, notification category, protection
hold, always-on service, or faster idle cron schedule. Existing destinations,
assignments, carry rules, money/stock guards, and reconciliation behavior are
handled by the same business functions.

At the owner's subsequent request, the existing “Run end of day” button is now
immediately below the totals and destination summary, above the order list.
Uzo can reach it without scrolling through the orders. Its confirmation and
disabled states are retained; an oversized-group warning stays beside it.

The owner also requested removal of “Create replacement” from order details.
That shortcut is removed for both admin and dispatcher users. The existing
home-page replacement entry points remain. Browser checks at phone and desktop
widths confirmed that each home-page entry opens the form and can search for
and select the original delivery, with no runtime errors.

[PostgREST 14 transaction documentation](https://docs.postgrest.org/en/v14/references/transactions.html)
describes function-level isolation and hoisted timeouts. The live API image was
checked read-only and is v14.12, matching the local and CI integration runtime.

## Regression coverage

`test-immediate-http.mjs` sends actual HTTP requests to the isolated PostgreSQL
17 / PostgREST 14.12 fixture. Each batch commits independently. The latency
matrix runs with no dispatcher or worker invocation, so a return to depending
on cron cannot pass the test. It covers 0, 1, 99, 100, 101 and 153 groups, plus
1,530 active groups alongside 20,000 historical orders. Normal recent-sized
operations must complete within 10 seconds.

The same suite checks permission and GET denial; approval scoping; duplicate
requests; an operational pause; real retry delays; stale and concurrently edited
orders; time-budget exhaustion; atomic group failure and explicit reapproval;
two simultaneous admins; scheduled/manual overlap; app-absent scheduled
recovery; and midnight/weekend continuation using the saved destination.

`test-immediate-http.mjs --browser-only` serves the exported production screen
at phone and desktop widths and forwards all EOD requests to real local HTTP
endpoints. Only unrelated login/navigation data is stubbed. It measures from
the confirmed button click to the displayed completion and covers a response
lost after commit and a reload during processing. No EOD result is mocked.

The existing UI suite additionally checks cancellation, preview paging,
completion navigation, prepared-date assignments, partial failures and all
three reconciliation entry points. The existing SQL business-rule matrix now
runs the immediate executor on Monday, Tuesday and Saturday as well as the
scheduled path. Other maintenance and financial regression suites remain.

CI runs both real HTTP and real browser integration. The browser job reuses
the web export from the existing mobile job; it does not build a second bundle.

### Commands

Use only the empty synthetic `reda_eod_test` database on localhost:55449 with
role `reda_test` and its PostgREST service on localhost:55451, with the existing
payment-contract pre-request hook. The scripts enforce the isolated database
and empty fixture preconditions; do not point them at production.

```text
node tools/eod-reliability-20260921/test-runner.mjs --setup
node tools/eod-reliability-20260921/test-immediate-http.mjs
node tools/eod-reliability-20260921/test-immediate-http.mjs --browser-only
```

The browser command requires `mobile/dist` from the current web export and
Playwright. `EOD_UI_DIST`, `PLAYWRIGHT_MODULE_PATH`, and
`EOD_UI_BROWSER_CHANNEL` support an existing test installation. Set
`EOD_IMMEDIATE_RESULTS` to an output path to record API timing results.

## Deployment order and recovery

1. Apply `20260928160000_immediate_manual_eod.sql` and reload the API schema.
   It adds one restricted execution endpoint; it does not alter order records,
   existing business functions, schedules or settings.
2. Verify the new endpoint's permissions and isolation against the installed
   API. Deploy the tested web bundle first for business verification.
3. Confirm Uzo's actual click-to-completion time and outcomes before extending
   the release to EAS under the owner's publication instructions.

Old clients continue to use their existing APIs. If the client must be rolled
back, completed operations remain committed and recoverable. Roll back the
client version without reversing order or payment history. The added endpoint
can remain unused; do not disable the shared recovery queue to undo this UI
execution change.

Performance measurements from isolated tests are not a production guarantee.
The acceptance check is both correct outcomes and measured user-visible time;
no completion claim should rely only on a direct worker throughput benchmark.

## Recorded local verification — September 28

Final API matrix, including preview and submission:

| Groups | Batches | Total time |
| ---: | ---: | ---: |
| 0 | 1 | 0.134 s |
| 1 | 1 | 0.114 s |
| 99 | 1 | 1.915 s |
| 100 | 1 | 1.893 s |
| 101 | 2 | 1.438 s |
| 153 | 2 | 2.114 s |
| 1,530, with 20,000 historical orders | 16 | 14.931 s |

Earlier scale runs took 21–22 seconds; timings vary with cache and machine
load. Every measured recent-sized normal run remained under 10 seconds.

Browser click-to-completion measurements for 153 groups:

| Scenario | Phone, 390 px | Desktop, 1280 px |
| --- | ---: | ---: |
| Normal | 1.913 s | 2.896 s |
| First execution response lost after commit | 5.967 s | 5.959 s |
| Reload after first committed batch | 3.015 s | 3.367 s |

All API permission, scoping, concurrency, retry, failure, pause, recovery and
date-boundary checks described above passed. The forced 11-second single-group
test completed once without a timeout/retry, confirming that the new executor
preserves the existing 20-second request deadline.

Also passed: the complete existing maintenance SQL suite; immediate-executor
Monday/Tuesday/Saturday business-rule cases; a clean migration installation in
the separate synthetic race database and its concurrency test; rider-fee waiver
and handover integration/concurrency suites; actual HTTP payment-contract tests;
phone and desktop workflow/assignment/reconciliation-entrypoint browser tests;
TypeScript, lint, formatting, web export, JavaScript syntax and diff checks.

The CI YAML and artifact dependency were parsed and checked locally. The new
GitHub CI jobs have not yet run remotely because the branch has not been pushed.
