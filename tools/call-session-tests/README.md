# Call lifecycle fix — 28 September 2026

> Historical implementation record. See the [28 September release record](../releases/2026-09-28-preview-release.md) for current validation and publication status.

Implemented locally. No production migration or Android update has been deployed.
The same-customer investigation remains paused in
`../same-customer-uchenna-investigation-paused-20260928.md`.

## Behavior

- Android Back minimizes the call. The app-wide session keeps audio callbacks,
  token renewal, and server reconciliation alive independently of the screen.
- A Return to call / End bar remains available when browsing the app.
- Repeated Call taps resume the current session on that device. Concurrent taps
  are serialized locally and in the database.
- Opening the app restores a still-active call belonging to that user/device.
- Expired ringing calls are cleared during retry/recovery without waiting for cron.
- Call errors display the server message instead of `[object Object]`.
- Late tokens cannot revive an ended call. Failed hang-up keeps retry controls
  and cannot silently reconnect audio through background polling.

## Automated verification

From `mobile`, run `npm run test:calls`, `npm run lint`, and `npm run typecheck`.
The 16 call tests cover screen removal, cold recovery, duplicate taps, remote
end/expiry, token and account-switch races, hang-up errors, mute/speaker recovery,
native handler ordering, and Cancel racing acceptance.

`node tools/call-session-tests/run.mjs` exercises the actual migration in an
isolated synthetic PostgreSQL database, including device ownership, role checks,
team acceptance, expiry, idempotency, and concurrent starts. The runner is pinned
to `127.0.0.1:55461`, user `reda_call_test`, database `reda_call_session_test`.
For a fresh dedicated cluster, create that user as its local superuser and use
`--setup` once. Never run the bootstrap against a shared or production database.
The synthetic schema excludes notification triggers; these tests place no calls.

Android and web Expo exports also validate bundling. They do not exercise native
audio, Android Back gestures, CallKeep, or OS process/background behavior.

## Deployment order

1. Deploy only the reviewed migration
   `supabase/migrations/20260928120000_call_session_recovery.sql` first. It adds
   `get_my_active_call` and replaces `initiate_call` and `accept_call` while keeping
   existing signatures. Do not blindly apply unrelated pending migrations.
2. Release the matching Android JavaScript update through the normal compatible
   runtime channel, or build a new APK if the deployed runtime requires it. This
   change introduces no new native dependencies.
3. Verify the installed app received the update, then perform the checks below.

## Uzo's device checks after deployment

Use two Android phones/accounts with microphone access and an available tester.

1. Call an agent from an order and immediately press Android Back while ringing.
   The other phone should keep ringing; a Return to call / End bar should appear.
2. Browse another screen, return through the bar, and tap Call again from the
   order. It should show the existing call, with no duplicate call or busy error.
3. Answer on the other phone. Repeat Back/return and confirm two-way audio,
   mute, speaker, and End all work. Check remote hang-up while minimized too.
4. Let an unanswered call pass its 45-second deadline, then immediately call
   again. It should start without waiting for the minute-based cleanup job.
5. Close and reopen the app during an active call. It should recover the server
   session if still active; an expired call must not block a new call. Audio
   continuity while Android kills the process is not promised by this fix.
6. Briefly disconnect the network, try End, then reconnect. A readable error
   and controls should remain if End failed; retry End and confirm both phones
   leave the call. Audio must not silently restart after the failed End.

Record app version/update ID, phone model, approximate time, and the actual error
text if any check fails. Device checks remain pending until performed on phones.
