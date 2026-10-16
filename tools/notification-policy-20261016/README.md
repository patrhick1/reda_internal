# Admin delivery notification policy

Trello: https://trello.com/c/g5RW6Cj9 (#312).

Approved scope: stop routine Delivered pushes for every admin; preserve all other alerts, sounds, recipients, delivery records and financial behavior. This is an approved notification policy change. No app update is required.

The database trigger used to include `delivered` in its status set. The sender then resolved every active admin and every registered device. Remove that one status at the source and acknowledge delayed/retried `status_change/delivered` events before database access in the sender. Do not filter by notification title: unrelated internal alerts may use the same words.

## Automated verification

Run from the repository root:

```sh
deno test --no-lock --node-modules-dir=none --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,INTERNAL_FUNCTION_SECRET tools/notification-policy-20261016/handler.test.ts supabase/functions/_shared/push-batch.test.ts
# Existing isolated PostgreSQL test service, initialized with:
node tools/eod-reliability-20260921/test-runner.mjs --setup
node tools/notification-policy-20261016/test-database.mjs
```

The database runner requires the dedicated empty local/CI database and rolls back all test data. It uses the actual completion RPC, current trigger function and existing synthetic payment fixtures. Only outbound notification transport is captured. It checks delivery state, collected amounts, completion history, established rider earnings and retries, then tests INSERT, UPDATE, unchanged-status edits and waybills for every affected status. Applying the migration twice must give identical outcomes.

The Deno suite uses the actual handler and Supabase client with deterministic HTTP responses, without network permission. It checks both internal authentication methods, repeat Delivered events, two active admins with multiple devices, inactive-admin exclusion, all other supported audiences, existing blacklist silence, and invalid/unauthorized requests. Existing push-provider tests cover retryable failures and expired tokens.

Results on 2026-10-16:

- Before: 3 sender regression tests failed; 14 unchanged-alert checks passed. The real completion RPC test failed because a Delivered notification was emitted, after payment/history/earnings assertions passed.
- After: all 17 handler tests and 2 existing push-provider tests passed. Database acceptance and the full trigger matrix passed with one and two migration applications.
- Existing order maintenance and manual payment/waiver suites were run against the changed trigger. CI also runs the new checks alongside the existing app, database and security checks.

## Release and acceptance

Capture the previous live function in `tools/live-defs/tg_notify_delivery_status_change_before_20261016.sql`. Back up the server schema and sender privately, check source drift, and dry-run the migration in a rolled-back transaction. Deploy the tested sender first, restart the Edge runtime and verify method/authentication gates plus an authenticated Delivered request with an invalid synthetic ID. It must return the suppression acknowledgment without a lookup or push. Then commit the trigger migration, verify its exact definition and unchanged owner, grants and trigger binding.

No table, RPC signature, mobile type or notification-channel changes are needed. Rollback restores the saved trigger definition and sender, then restarts the runtime.

Physical phone acceptance is not automated or performed by these tests. On a controlled test order with two admin accounts/devices: complete the order, verify Delivered status, payment and history in the app, and confirm neither admin receives a new completion push. On a separate test order, record Failed delivery and confirm both admins receive the usual alert. Confirm assignment and call alerts still arrive. Check both foreground and background states. Existing notifications already on a phone are not removed.
