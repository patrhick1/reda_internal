# Android call / Back-button investigation — 28 September 2026

> Historical implementation record. See the [28 September release record](releases/2026-09-28-preview-release.md) for current validation and publication status.

The initial investigation was read-only. The authorized local fix is now
implemented; see `call-session-tests/README.md` for validation and rollout.
No production call records or server settings were changed.
The separate same-customer investigation is paused; see
`same-customer-uchenna-investigation-paused-20260928.md`.

## Report

The supplied screenshot describes an initial agent call followed immediately by
Android Back. The user expected WhatsApp-style minimization, thought ringing
stopped, retried from the order, and saw **Could not start call / [object Object]**.
Restarting the app did not immediately help. The screenshot shows the Oladele
order, Original Buy, assigned agent Funke, created 18 September 2026.

## Verified production evidence (read-only)

The matching call is `91018b62-61d5-40ca-bbf2-8fc495d46e65`, Greg Uzo → Funke,
related delivery `2fab2b8e-0ae7-45a5-9b51-849394445a8c` (Oladele).

All times below are Lagos time (UTC+1), 18 September 2026:

- Created/ringing: **11:37:41**.
- Audio token issued: **11:37:42**. This confirms token issuance, not that audio
  was audible or the remote phone rang.
- Ringing deadline: **11:38:26** (45 seconds after creation).
- Marked missed / ended: **11:39:00**, about 79 seconds after creation.
- `started_at` is null: no server-recorded acceptance.

This was the only created call for that caller that day. Failed initiation
attempts do not create additional call rows.

The deployed `initiate_call` inserts a ringing row; unique indexes prohibit
another ringing call for the same caller or individual callee. A conflict
returns SQLSTATE `55000` with message
`caller or callee already has a ringing call`.

`expire_ringing_calls()` marks overdue ringing calls missed. Cron runs it once
per minute; retained cron records confirm successful runs at 11:37, 11:38, and
11:39. The 11:38 run preceded this call's deadline, explaining why it cleared
at 11:39. No ringing or accepted calls remained at investigation time.

No matching error lines were returned by a narrowly filtered database Docker
log query for 11:37–12:00 Lagos on 18 September. The exact failed retry response
and timing are therefore unconfirmed; absence of retained lines is not proof
that no errors occurred.

## Code findings

- `mobile/app/(call)/call/[callId].tsx`: only the explicit Cancel/End button
  invokes cancellation/completion. No Android Back handler or navigation-removal
  guard handles leaving the screen. Unmount removes screen event handlers and
  the outgoing subscription but does not cancel the server call or leave Agora.
  Async token acquisition is also not guarded against a subsequent unmount.
- `mobile/src/lib/calls/coordinator.ts`: explicitly manages incoming calls only;
  outgoing lifecycle ownership belongs to the call screen. There is no shared
  outgoing-call controller or return-to-current-call UI providing a reliable
  minimize/resume flow.
- `mobile/src/screens/deliveries/Detail.tsx`: call errors use
  `err instanceof Error ? err.message : String(err)`. Supabase database errors
  can be plain objects, producing `[object Object]` and bypassing the intended
  `msg.includes('ringing call')` friendly-error branch. Similar formatting is
  present in the team/history/call screens.
- The existing `mobile/src/lib/errors.ts` `errorMessage()` already handles
  these plain-object errors correctly. Changing the dialog mechanism alone in
  the earlier alert fix did not fix these message strings.

## Verification and limits

A local check extracted the actual `startCall` error-message expression from
the TypeScript syntax tree and evaluated a representative `{code:'55000',
message:'caller or callee already has a ringing call'}` object. It reproduced
`[object Object]`, showed the friendly busy branch is skipped, and confirmed
that `errorMessage()` preserves the real message. This used a representative
error, not a captured response from Uzo's failed retry.

The records and code explain retries made before **11:39:00**: the first call
was still ringing server-side, including across an app restart. They do not
prove why a retry after that time would fail. No physical Android reproduction
was performed. The report that audio/ringing stopped after Back cannot be
verified from call metadata alone.

## Follow-up

The user believes Uzo did not retry after two minutes. The approved fix uses
app-wide call ownership, Back-to-minimize behavior, a Return to call / End bar,
server recovery on reopen, immediate expiry checks on retry, and readable
error messages. It is implemented locally with automated tests. Deployment and
physical Android verification remain pending; see `call-session-tests/README.md`.
