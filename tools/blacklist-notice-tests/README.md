# Blacklist notices — 28 September 2026

> Historical implementation record. See the [28 September release record](../releases/2026-09-28-preview-release.md) for current validation and publication status.

Implemented locally. Not deployed. The production investigation was read-only.

## User experience

- Manual creation and creation from Review show the database blacklist refusal
  inline, explain that no order was created, and retain the form. The error is
  scrolled into view and exposed to assistive technology. Editing the form clears
  the stale error; the server still enforces the block on retry. Manual attempts
  do not broadcast notifications to other staff.
- Admins, dispatchers, and reps see one grouped, persistent notice in the app
  and web. It refreshes while foregrounded (up to 30 seconds) and on return.
  View blocked orders opens the Blocked tab and expands the referenced record,
  including an older record outside the default 100-row list.
  The grouped notice is hidden during calls and order-entry forms so it does
  not compete with the task or the form's own error message.
- Mark seen is per user, shared across that user's devices. It acknowledges
  only the displayed snapshot, preserving later arrivals. It does not remove
  blacklist entries or unblock orders. A failed acknowledgment stays visible.
- One durable event per inbound message prevents duplicate alerts from retries.
  Android push scheduling is limited to one per 10 minutes across the operations
  audience. Further refusals still update the grouped notice and Blocked list;
  there is no delayed push digest. No old records are backfilled at deployment.
- Blacklist pushes use a quiet Android channel, normal priority, no vibration,
  and a shared tray tag. Other call/delivery push behavior stays unchanged.
  These options follow [Expo's push message API](https://docs.expo.dev/push-notifications/sending-notifications/).
- The app notice remains available if push permissions are disabled. Web uses
  the in-app notice; browser/OS push support is not introduced.

## Verification

Completed locally: six unit tests, the database suite and concurrent-refusal
check, the mocked browser flow, lint, TypeScript, and Android/web exports all
passed. Physical Android push verification is pending deployment.

- `cd mobile; npm run test:blacklist-notices`: refusal text, unrelated errors,
  all ops deep links, quiet push policy, and preserved urgent notification policy.
- `node tools/blacklist-notice-tests/run.mjs`: actual migration in an isolated
  local synthetic database. Covers retries, cooldown, concurrent refusals,
  acknowledgment races, per-user state, resolved orders, role/access checks,
  no historical flood, and failure of push scheduling. No real notifications.
  For initial setup use `--setup` with a dedicated cluster on 127.0.0.1:55461,
  user `reda_call_test` (created by the earlier isolated call tests). The test
  database is `reda_blacklist_notice_test`; production targets are not accepted.
- `node tools/blacklist-notice-tests/web.mjs`: real Expo web export in headless
  Chrome, with every external HTTP/WebSocket request intercepted and synthetic
  authentication/data. Checks grouped notice, specific blocked-order routing,
  failed/successful acknowledgment, persistence after reload, mobile/desktop
  rendering, and actual manual submission rejected without losing form contents.
  `BLACKLIST_WEB_BUILD` selects the local export. `PLAYWRIGHT_MODULE` selects
  Playwright when not available at the bundled Windows path.
- Lint, TypeScript and Android/web Expo exports are required release checks.
  Native notification delivery/sound and Android gestures require real phones;
  bundling and mocked browser tests do not verify them.

## Release order and device checks

1. Release the Android/web app changes through the normal channel. Opening the
   updated Android app creates the quiet `blocked-orders` notification channel.
   Its absence on an older app may prevent the new push from displaying, so
   have the testers open the updated app before testing.
2. Deploy `send-notification` with `_shared/notification-policy.ts` and its
   existing shared dependencies, preserving other reviewed pending changes.
3. Apply only `20260928140000_blacklist_notices.sql` after the existing customer
   blacklist migration. Do not bulk-apply unrelated pending migrations.
4. Test with an authorized synthetic blacklist entry/order: first refusal gets
   one quiet push and an in-app notice; another within 10 minutes changes the
   grouped count without another push. Tapping opens Blocked. After 10 minutes
   a new refusal may send again and replaces the prior blacklist tray notice.
5. Check manual refusal on Android and web, another staff account's independent
   unread state, app reopen, disabled push permission, and late arrivals during
   Mark seen. Existing urgent call/delivery alerts must still work.

The migration stores no duplicate customer details and exposes summary/ack
RPCs only to active operations users. A notification scheduling failure does
not undo the blocked status or durable notice. Scheduling/provider acceptance
is not proof of physical-device receipt.
