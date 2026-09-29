# WhatsApp delivery-report splitting — 29 September 2026

Status: published to main, the live web app and Android EAS preview on 29 September 2026. No database migration or native dependency change. Physical WhatsApp acceptance remains pending. The sharing/app CI checks passed; an unchanged maintenance calendar-fixture test failed, as detailed below.

## Problem

The shared Android delivery update was already truncated before WhatsApp Send. The pasted example ended mid-order and lacked totals. With LF newlines, it measured 4,095 UTF-8 bytes (3,937 characters); a trailing space would reach 4,096. This suggests a handoff boundary but does not prove a universal WhatsApp limit. The original report builder handed one full string to the OS share menu.

## Solution and usage

- A complete share payload is capped at 3,500 UTF-8 bytes, including the client/date header, part numbers, continuation labels and separators.
- Short reports retain the existing direct Share with client flow and exact formatting.
- Long reports open a numbered preview. Share part / Copy act on the current part; Previous / Next part change it explicitly. Send each part to the same WhatsApp chat.
- Closing the preview (including Android Back) retains the current part while the report screen stays mounted. Continue sharing reopens it. Done clears the snapshot; leaving the report or changing its client/date scope also starts fresh. Progress is not persisted across an app process restart.
- The snapshot is built once, so changes to later query results cannot alter an in-progress series. Buttons remain pinned below the scrollable preview. Desktop width is capped at 640px; small phones use the available width.
- Complete orders stay together. An individual oversized order, note or totals block is split at a newline/word where possible, otherwise at a Unicode code-point boundary, with continuation labels. No report content is discarded. Totals appear once at the end (continued across parts only if the totals block itself is oversized).
- Share cancellation does not advance a part. Sharing never marks the client notified or claims a message was sent. Failures offer retry/copy; copy confirmation reflects the clipboard result.
- A new share waits for both report and balance queries. Load failures have an explanation and Retry. An already prepared snapshot remains resumable.
- Admin and rep client-report paths use the same component and formatter. Existing client-specific layouts, fees, phone visibility, negative remits, pickup/replacement content and running-balance wording are preserved.

## Implementation

The structured report builder separates header, order blocks and footer; the original single-message builder remains a compatibility wrapper. UTF-8 sizing uses code-point iteration without Buffer or TextEncoder runtime dependencies. Packing is linear per numbering-width pass; only a change from one to two (or more) part-number digits requires another pass. A local synthetic 10,000-order report split into 313 parts in about 35ms; this is a local measurement, not a device timing promise.

Files: mobile/src/lib/share-report.ts, mobile/src/lib/reconcile.ts, mobile/src/components/ClientReportShare.tsx, both client reconciliation screens, and optional Sheet header/scroll/width props.

## Verification

- 12 regression tests: independent UTF-8 encoder comparison, exact 3,500-byte boundary, complete/orderly order coverage, final totals, long Unicode/notes, oversized totals, 9/99/999 part-number boundaries, custom financial layouts, empty/negative/pickup/replacement data, oversized-heading error and 10,000-order scale.
- Exported-app browser tests use synthetic accounts and intercept every API/share/clipboard operation. Admin and rep flows are exercised at 320, 390 and 1280px, including exact payload byte counts, every customer once, totals, cancellation, failure/retry, copying, explicit navigation, close/resume, direct short sharing and load-failure recovery.
- TypeScript, ESLint, Prettier and Android/web exports passed, along with all 12 regression tests and all six browser scenarios. The final 320px phone and 1280px desktop layouts were visually reviewed. The unit and UI tests are wired into existing CI for the next push.
- Real WhatsApp handoff and hardware Back still require the updated Android app on a device. No WhatsApp message was sent by automated testing.

## Device acceptance

Open a long delivered update in the updated app. Share all numbered parts to an authorized test chat. Confirm each part includes its full ending, every order is present and the final total matches Reda. Cancel once, return from WhatsApp, close/reopen the preview, copy a part, and verify the current part is retained. A short update should still open the share menu immediately.

## Publication record

- Source: [ee601e4c68c8fcf565465d03a3851e5f13e8c5a1](https://github.com/patrhick1/reda_internal/commit/ee601e4c68c8fcf565465d03a3851e5f13e8c5a1), pushed to main. Existing older working-directory changes were preserved.
- Web: [live app](https://app.redalogisticss.com), successful deployment 6744495670. Live HTTP 200 and bundle entry-ca391d2b8db3f83d850bcbe3201a881e.js verified to contain the split preview, Continue sharing and 3500-byte limit, with production API/public key and no synthetic test key.
- Android: [EAS preview group 83c38204-d674-4188-a651-c20d9e14b6ef](https://expo.dev/accounts/patrhick1/projects/reda/updates/83c38204-d674-4188-a651-c20d9e14b6ef), update 01a0eed2-80b1-7758-8e6b-af2824dfb365, runtime 1.1.1, published 2026-09-29T20:19:28.049Z. Active preview channel points to this group. EAS confirms exact source ee601e4 and a clean working tree.
- Android bundle verification: production API/public key and new share UI present; synthetic test key absent. Published manifest SHA-256 matches the validated local bundle: 3sW77pj9bHusr4JAgwvGCbILGG4Jo6D6GxZ3OZGfk84.
- Publishing configuration: an initial EAS export omitted the local API settings; its attempt was stopped before publication. The final export explicitly supplied the values from eas.json, cleared Metro cache, verified the bundle, then published with --skip-bundler. Reuse that verified sequence for future releases; the EAS preview environment currently has no server-defined public variables.
- [Remote CI run 36624910234](https://github.com/patrhick1/reda_internal/actions/runs/36624910234): mobile typecheck/lint/format, sharing regression/browser tests and security checks passed. The maintenance job failed at test-reschedule-failures.sql:45, assertion 'unrelated group committed'. That test enqueues business_day()-2, which is Sunday on this Tuesday, while fixture.sql moves those historical orders to Saturday and close planning selects the exact requested date. These test/backend files were unchanged by this release. This existing calendar-test mismatch is recorded for follow-up; the complete CI run is not green.
- Device acceptance remains pending: install the update, share a long report to an authorized WhatsApp test chat, and confirm every numbered part and the final totals arrive intact. Automated tests did not send any real messages.