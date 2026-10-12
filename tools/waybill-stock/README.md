# Card #279 — Waybill stock adjustment implementation

Implemented and tested locally on October 12, 2026. **Not deployed.** No Trello comments or list moves were made for #279. The user has already moved #235 to Testing.

Source checkout: `C:/Users/ebube/.codex/worktrees/urgent-october-release/Reda-dev`, based on current main `0bea29733967997c42c2b96155e99cff3b4083b4`. The original dirty working copy was preserved.

## Delivered behaviour

- Admins can choose **Waybill — stock out** in stock adjustments, select the holder and products, and record quantities and an optional shipment reference.
- It removes stock and records the reason, actor, time and note. It creates no financial waybill, charge, rider earning or remittance.
- Existing stock history, shared Adjustments filtering and totals include the movement. The existing money-only Waybill feature and old Correction rows are unchanged.
- Warehouse users and riders cannot create stock waybills. Retired products already held can still be shipped out.
- Zero, negative, fractional and excessive form quantities cannot create the requested removal. Pasted fractions are no longer silently turned into different whole numbers.
- Repeated requests use one deduction. Concurrent waybills and stock transfers cannot both spend the same available units.
- On a partially failed batch, the form clears submitted rows and reports how many succeeded. Failed rows remain in **Sync issues** with their original request IDs; retrying there sends only the failed rows, so successful rows cannot be repeated by resubmitting the old form.

## Database design

Migration: `supabase/migrations/20261012110000_waybill_stock_adjustment.sql`.

It adds the reason to the existing constraint and adjustment RPC, with admin-only permission, negative-delta and available-stock checks. It preserves existing product-retirement handling and writes the existing audit trail. A reused adjustment request ID with changed parameters is rejected.

A transaction advisory lock per product coordinates the adjustment and transfer balance checks. A ledger trigger makes inserts, updates and deletes from other stock writers participate. Both sides of a transfer use the same product key, avoiding opposite holder-lock ordering. Different products do not share a lock. A request lock before the retry lookup makes concurrent identical requests return the original result.

This is stock-availability protection, not order reservation. Existing intentional Correction deficits and recording of actual delivered quantities retain their prior policy. A delivered movement that commits first reduces the balance seen by a waiting waybill; a later actual delivery is still recorded even if it reveals a physical stock discrepancy. No historical ledger rows are rewritten.

## Verification completed

- **19 grouped database checks** passed against the actual migration: balances, idempotent retries, changed-request rejection, audit fields, history filter, summary, no financial record, quantity/availability failures, admin-only permission, retired products and preserved Correction behaviour.
- Concurrency cases passed: overlapping waybills; simultaneous identical requests; waybill versus transfer in both commit orders; opposite transfers; and a waybill waiting for an actual delivery-ledger deduction.
- Migration application and reapplication passed in the isolated database. It also loaded successfully through the current CI schema setup from the sanitized baseline.
- **Three real exported-web form scenarios** passed using synthetic intercepted API data: ordinary submission with fractional/excessive input validation; partial-batch failure and retry with the same request ID; warehouse menu exclusion. No production requests were permitted by this browser harness.
- **Six stock-summary tests** passed, including mixed waybill/correction/internal-transfer totals.
- Existing maintenance, rescheduling, permissions, manual EOD, history-scaling and simple-workflow SQL regression cases passed, including their weekday variants.
- Mobile TypeScript, ESLint and formatting checks passed. Web export and `git diff --check` passed.

The browser form and actual SQL are tested separately; this is not a physical Android-device test or a production shipment. Synthetic SQL fixtures were rolled back or explicitly cleaned. The temporary local database server was stopped after verification.

## Reproduction and CI

The CI workflow now loads the migration in the normal schema setup and runs these checks automatically:

```text
node tools/eod-reliability-20260921/test-runner.mjs --setup
node tools/waybill-stock/test.mjs
npm --prefix mobile run test:stock-summary
node tools/waybill-stock/test-ui.mjs
```

The database test uses the existing isolated CI PostgreSQL service on localhost port 55449 (`reda_test`, database `reda_eod_test`). `--local` uses the earlier dedicated port 55459 test cluster; `--apply` applies the actual migration there. Never point it at production. Browser checks need the web export and the existing `PLAYWRIGHT_MODULE_PATH` / `EOD_UI_DIST` conventions. CI runs that test from `mobile` with `EOD_UI_DIST=dist`.

## Deployment and acceptance

Back up/recompare the live adjustment and transfer function definitions before deployment. Apply the migration before publishing the app so the new option is supported when it appears. Publish web and the active Android channel, then let Uzo check a real approved stock shipment.

Suggested concise handoff after deployment:

> I've added “Waybill — stock out” to Adjustments. It removes shipped products from stock without recording a charge. Please check that removing 5 from 10 leaves 5 and shows as Waybill in stock history. If part of a batch fails, retry it from Sync issues—the successful items won't be repeated.

The handoff above is a draft only; it has not been posted. Do not mark the card complete until Uzo accepts the deployed behaviour.
