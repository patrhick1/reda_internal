# Approved To work on fixes A–D

Implemented and verified locally on 2026-10-16. No production deployment,
historical counter repair, order replay, feature work, or Trello edits were made.
Existing unrelated working-tree changes were preserved.

## Changes and acceptance criteria

| Approval / card | Cause and change | Acceptance criteria |
| --- | --- | --- |
| A — [Situp bar quantity #256](https://trello.com/c/m0935tLG/256-situp-bar-quantity) | The Bowan override recognized only the old pipe-column format and `Closer:`. Current messages use `xN · NGN…` and `Closer name:`. The extractor could mistake the `3 -` product-name prefix for three units. `applyBowanQuantities` reads both formats and matches quantities to individual paid products. | Explicit x1/x2/x3 become 1/2/3; distinct products retain independent quantities; prices, gifts, and repeat-message handling remain unchanged. Old pipe arithmetic must be valid. Missing markers, ambiguous matches, and invalid quantities are not guessed. |
| B — [To allow orders be attempted twice #308](https://trello.com/c/X5MpEnQ0/308-to-allow-orders-be-attempted-twice) | Rollover incremented/enforced the counter for broad status categories, including untouched Pending orders. Preview used the same overly broad categories. One shared failed-attempt predicate now drives counting, enforcement, audit, and preview. | Untouched/operational rollovers preserve the counter. For ordinary clients, a first retryable failure rolls with count 1; a second closes Unserious without a third attempt. Pending gaps do not consume that second attempt. Existing client policies, terminal statuses, disinterest/follow-up closure, idempotency, stock, and Sunday rules remain intact. |
| C — [Postponed orders sink to the bottom #283](https://trello.com/c/vkUZPG5X/283-that-thing-where-postponed-orders-go-down-in-the-list-an-agents-orders-is-it-neccesary) | The All list appended cross-date postponed orders after sorting the ordinary rows. The merged rows now use the existing activity comparator, shared with the service. | Newest activity sorts first after merging; one row per order; agent filter and search still work; the dedicated Postponed view retains scheduled-date ordering. |
| D — [Rider departure visibility #294](https://trello.com/c/kqBWxtY9/294-that-feature-of-when-a-rider-has-left-the-warehouse) | Admin Home did not load or pass departure data to the already-capable AgentWorkloadCard. It now uses the existing service/chip and refreshes on return to Home. | The correct rider shows today's Lagos departure time; yesterday's/absent departures do not show; returning Home reloads once and reflects an undo. This implements the approved admin bug portion only. |

The B migration contains function definitions and a private helper only. It was
based on the captured live definitions in `../live-defs/*_before_attempt_fix_20261016.sql`,
preserving financial locks, same-customer inheritance, pricing, notifications,
and caller permissions. The existing cap remains **one permitted rollover after
a qualifying failure, then closure on the second qualifying failure**. No new
policy toggle or allowance was introduced. Older inflated counters are deliberately
left unchanged, so this prevents further operational increments without repairing
past mistakes.

## Executed tests

| Check | Before | After |
| --- | --- | --- |
| Actual parser handler, six synthetic acceptance scenarios | 3 failed: x1 and x2 both submitted 3 units; two products submitted 3/9 instead of 1/2. Old format, x3, and unrelated format passed. | 6 passed. |
| SQL attempt regression | Failed: Pending consumed an attempt. | Passed: repeated Pending carryovers, a Pending gap between failures, cap, retries, operational statuses, stock, Sunday, and untouched historical fixture. |
| SQL workflow acceptance | Failed: one-strike Pending previewed as Unserious. | Passed: preview → manual EOD → unassigned successor → reassign → second failure → scheduled close → retry. |
| Browser acceptance, original and fixed Expo exports | Failed ordering, missing departure badge, and missing focus reload; search/Postponed-date compatibility passed. | All 4 checks passed, with no browser runtime errors or data mutations. |

Further executed checks:

- **105 Deno tests passed:** 93 existing parser/product/vendor/gift/total tests,
  plus 6 Bowan unit tests and 6 new handler acceptance tests.
- **21 Node tests passed:** 17 existing earnings/payment/balance tests and 4
  activity-order tests (creation fallback, activity across dates, and stable ties).
- **11 PostgreSQL suite invocations passed:** 8 existing invocations plus the 3
  new SQL files. The policy suite checks 64 status/count/client-policy combinations
  and all four retryable-failure lifecycles. All fixture transactions rolled back.
- The migration applied and reapplied successfully to the isolated PostgreSQL 17
  test database. Existing function signatures remain unchanged.
- Mobile TypeScript check, full ESLint check, and Expo web export passed.
- Full mobile format check was executed and reports **9 pre-existing files**:
  `app/(agent)/today/[id].tsx`, `src/components/delivery/NotifyAttentionBlock.tsx`,
  `src/components/ui/StatusPill.tsx`, `src/lib/client-notification.ts`,
  `src/lib/negative-margin.ts`, `src/screens/deliveries/Detail.tsx`,
  `src/screens/deliveries/List.tsx`, `src/screens/review/reviewReason.ts`, and
  `src/services/deliveries.ts`. The remaining formatting differences in the two
  files touched here are unrelated existing status/notification code; they were
  left intact. New/changed fix lines follow the formatter.

Fail-before SQL used captured pre-fix functions in uncommitted local sessions;
the expected failure closed each connection and rolled back both definitions
and fixtures. Parser fail-before used an isolated source copy with only the old
Bowan helper/call restored. Browser fail-before used the export built before
the UI changes. The current source tree was not reverted for these checks.

Local evidence is under `.codex-to-work-on/` at the repository root (ignored):
`parser-before.txt`, `parser-after.txt`, `attempts-regression-before.txt`,
`attempts-acceptance-before.txt`, and the `to-work-on-before` / `to-work-on-after`
browser `results.json` files and screenshots.

## Re-run

From the repository root, with Deno and Node 22.6+:

```sh
deno test --no-lock --node-modules-dir=none --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,INTERNAL_FUNCTION_SECRET,OPENROUTER_API_KEY supabase/functions/_shared/bowan-quantity.test.ts tools/to-work-on-20261016/parser-acceptance.test.ts
node --experimental-strip-types --test mobile/src/lib/delivery-order.test.mjs
npm --prefix mobile run typecheck
npm --prefix mobile run lint
```

Use the existing [isolated database setup](../eod-reliability-20260921/README.md)
on localhost:55449, role `reda_test`, empty database `reda_eod_test`:

```sh
node tools/eod-reliability-20260921/test-runner.mjs --setup
# Subsequent runs, without rebuilding the database:
node tools/eod-reliability-20260921/test-runner.mjs
```

The runner now installs this migration and includes the new SQL suites. Its
existing Pending carryover expectation was updated from 1 to 0; other existing
expectations were retained.

For browser acceptance, export the app from `mobile` using `EXPO_NO_DOTENV=1`,
`EXPO_PUBLIC_SUPABASE_URL=https://api.redalogisticss.com` and the synthetic
`EXPO_PUBLIC_SUPABASE_ANON_KEY=isolated-ui-test`:

```sh
node node_modules/expo/bin/cli export --platform web --max-workers 2 --output-dir dist/to-work-on-after
```

From the repository root:

```sh
node tools/to-work-on-20261016/ui-acceptance.mjs
```

Use `REQUEST_UI_DIST` for a different export directory, `PLAYWRIGHT_MODULE_PATH`
for an existing Playwright installation, and optionally `REQUEST_UI_BROWSER`
for its Chromium executable. The test starts its own loopback server and browser,
intercepts API traffic with synthetic responses, and blocks other external traffic.
The CI workflow now invokes the new parser, SQL, ordering, and browser checks;
the hosted CI run itself has not been executed in this session. No dependency
was added to the application.

## Remaining integration acceptance (not executed)

The handler tests mock the model, address resolver, and database responses; they
verify the real parser's outgoing creation payload, not a live provider or persisted
order. Browser tests exercise the real web app with synthetic responses, not live
RLS or a physical phone. PostgreSQL tests use the actual business functions with
synthetic fixtures and sanitized outbound integrations. No Android/iOS simulator
or device run was performed.

After deployment to a non-production acceptance environment, use fresh test orders:

1. **A:** Submit a Bowan message containing `Order number: TEST-A`, a product line
   `3 - SUCTION SITUP-BAR + FREE SKIPPING ROPE x1 · NGN39,500`, and
   `Closer name: TEST`, with valid synthetic customer/address fields. Verify the
   created order has one paid Situp Bar, the expected total and existing gift
   handling. Repeat with x2/NGN79,000 and the old `| 2 | 39500 | 79000` format.
   Retry the same inbound event and verify no second order appears.
2. **B:** For a test client with auto-cancel off, leave an order Pending and finish
   the day. Verify its unassigned successor retains count 0. Assign it, record
   Not answering, and finish that day: count 1 and one successor. Leave the
   successor Pending for another day: count remains 1. Assign it, record Not
   connecting, and finish that day: Unserious, no third attempt. Reopen/retry the
   same EOD run and verify no duplicate children. Use the acceptance environment's
   test clock to cross days; do not alter production clocks or historical orders.
3. **C:** On a phone, have a test rider postpone a new order to a future working
   date. In the admin web app, open that rider's All list for today. Verify the
   order remains in newest-activity order, appears once, and retains the promised
   date. Search its name, then open Postponed and confirm due-date ordering.
4. **D:** Have the test rider select “I've left.” Open admin Home and confirm the
   rider's “On the road” badge and Lagos time. Confirm another rider without a
   departure has none. Undo the departure, navigate away/back, and verify removal.
   On the next Lagos day, verify yesterday's departure does not appear.

Release units are the parser Edge function with its new shared helper, the
definition-only SQL migration, and the app build. Compare the captured database
definitions with the deployed versions before applying the migration to detect
concurrent changes. Deployment and historical repairs were not performed here.
