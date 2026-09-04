# Agent weekly stock counts

The existing dispatcher and warehouse count workflow remains available. Agents
use the same count entry screen with the holder locked to their signed-in user.

- Agent: **My stock → Count my stock / Count history**.
- Admin/dispatcher: **Stock → More actions → Weekly agent counts**.
- Existing **Count history** includes warehouse counts, dispatcher counts of
  agents, complete agent self-counts, and explicit no-stock confirmations.

Each cycle starts on Saturday in Africa/Lagos and runs through Friday. Counts
submitted after Saturday are marked late. All currently listed products must
be counted, including negative app balances; zero is a valid physical count.
An agent can also add a catalog product physically present but missing from the
stock list. A complete submission with differences fulfils the counting
requirement. Existing partial operations counts do not fulfil agent self-counts.
Recounts remain separate records; the checklist shows the latest submission.

The checklist uses active agents plus inactive agents with a submission for the
selected week. It is not a historical staffing roster. No draft is saved on the
server: leaving the entry screen before submission does not fulfil the weekly
requirement. Reminders and discrepancy-resolution workflow are not included.

## Database rollout

Applied `supabase/migrations/20260903120000_agent_weekly_stock_counts.sql` to the
live self-hosted database on **3 September 2026**. It depends on the
existing `stock_counts`, `current_stock`, users and product catalog, plus the
existing permission/audit helpers. The new history RPC names preserve older
builds' existing API contracts. No historic count is relabelled as a complete
weekly submission. No count changes inventory or creates an adjustment.

The previous live `stock_counts_select` policy is captured in
`tools/live-defs/stock-count-policy-before-agent-weekly-20260903.sql`.
The migration passed a transactional dry run against the live PostgreSQL 17.6
schema before being committed. The disposable database suite and the live
rollback-only smoke suite both passed.

The local production web build was also tested against the live API using the
existing Test Agent and Test Dispatcher accounts. Verified no-stock confirmation,
missing-product discrepancy entry, saved receipts, agent history, the operations
weekly checklist and Differences filter, and drill-through to count history.
API checks verified latest-submission selection and denied agent access to the
operations checklist. Database checks covered complete counts, stale snapshots,
idempotent retries, privacy and preservation of legacy count history.

Browser testing identified and fixed the agent return destination, stale receipt
when starting another count, and excessive spacing below the weekly filters.
The final build and targeted lint passed; TypeScript and week-boundary tests
also passed during implementation. Native device testing was not performed.

Both browser test submissions, their one count row and eight audit field rows
were removed by exact test batch IDs. All **198 existing count rows** remain,
there are no test submission headers left, and the test agent still has zero
inventory rows. Temporary test sessions were signed out. Counts did not adjust
inventory.

Published on **3 September 2026** from commit
`0833f76affeab2a771b8bc201adeff3a514b6516`:

- Web: Vercel production deployment `CfGbtQc2KyRP3TwAp5YQXvfkQPvq` succeeded.
  `https://app.redalogisticss.com` serves the stock-count bundle with HTTP 200;
  the sign-in screen loads successfully. GitHub CI and security checks passed.
- EAS: preview branch/channel, runtime `1.1.1`, Android and iOS update group
  `9c4f0d68-5bad-4d71-9685-91ca1afdbf23`. Both preview manifest endpoints were
  verified to serve the new update IDs after publication.
- Built from an isolated checkout so concurrent blacklist work was excluded.
  Bundles were checked for the live API URL, public key and stock-count RPCs.
  EAS has no server-side preview variables configured; the release used the
  preview environment values from `mobile/eas.json`, with a clean Metro cache,
  then uploaded the verified bundles using `--skip-bundler`.

Existing preview installations on runtime `1.1.1` receive the update on relaunch;
no new native dependencies or APK rebuild were required.

## Reproduce checks

From `mobile/`: `npm run typecheck`, lint the changed TypeScript files, and
`node --experimental-strip-types --test src/lib/stock-count-week.test.mjs`.

For the database suite, create an **empty disposable** database whose name begins
with `reda_count_tests`, then run `psql -v ON_ERROR_STOP=1 -f
tools/test-agent-stock-counts.sql` against it as its owner. The script creates
fixtures and installs the actual migration. It verifies full coverage, stock
snapshot validation, quantities and variances, no-stock confirmation, safe
retries, weekly status, history visibility, legacy partial counts, and role
boundaries. Never run this fixture script against the application database.

`tools/smoke-agent-stock-counts-live.sql` is the separate rollback-only live
smoke suite. It uses existing test users and rolls back all test submissions.
