# Reda Logistics — Phased Implementation Plan (Tech-Debt-Aware)

Companion to [reda_prd.md](./reda_prd.md) and [reda_system_design_doc.md](./reda_system_design_doc.md). The PRD's Section 7 lays out a feature-shipping order; this doc reframes it so that each phase **builds on a foundation that doesn't have to be re-worked later**. Every phase has explicit "tech-debt traps" called out and the discipline needed to avoid them.

## Guiding principles (apply to every phase)

These are the rules that prevent the most expensive rewrites later. Treat them as non-negotiable.

1. **Database is the source of truth, not the app.** Business rules (state machine, money math, stock math, idempotency, permissions) live in Postgres — functions, constraints, RLS, views. The mobile app is a thin client. *Why:* a second client (web admin, retool dashboard, future agent webapp) shouldn't require re-implementing rules.
2. **Snapshots over recomputation for money; computation over storage for stock.** PRD already says this — `charged_snapshot` / `agent_payment_snapshot` freeze history; `current_stock` view recomputes from movements. Don't ever store `current_stock` as a column.
3. **Idempotency from day one.** Every mutation accepts `client_uuid`. Server-side dedup is added with the first mutation, not retrofitted with the first offline-sync bug.
4. **Audit before features.** `audit_log` writes are part of the same transaction as the mutation. Not "we'll add logging later."
5. **RLS is the permission layer, not the UI.** UI hides things for ergonomics; RLS makes it impossible. Margin must be unreachable from a non-admin JWT even if the app is malicious.
6. **Typed end-to-end.** Generate TypeScript types from the Supabase schema (`supabase gen types`) and import them in the app. Hand-rolled types drift; generated types break the build when the schema changes — which is the point.
7. **One way to do each thing.** One mutation queue. One error-toast component. One date-formatting helper. One money-formatting helper. Duplicates become inconsistencies become bugs.
8. **Migration discipline.** Every schema change is a numbered migration file checked into git. Never edit the live DB through the Supabase UI for anything that should persist. The schema must be reproducible from `main`.
9. **Feature-flag the risky, ship the safe.** Bot pipeline and AI normalization land behind flags so the manual flow can run in production while the AI matures.
10. **The cutover is parallel, not a flip.** The PRD's "v1 success criteria" require Reda's day-to-day to keep working. Plan every phase as additive to the spreadsheet, not as a replacement until Phase 7.

---

## Progress

| Phase | Status | Notes |
|---|---|---|
| 0 — Foundation | ✅ done | Hybrid workflow: schema edits via Supabase SQL editor, `npm run gen:types` after each. No Docker. |
| 1 — Auth & permission spine | ✅ done | 4 test users (`admin/dispatcher/agent/warehouse @reda.dev`), expo-router file-based, `useAuth` + `useCurrentUser`, permission helpers 1:1 with RLS. |
| 2 — Catalog + users | ✅ done | All six sub-steps shipped: 2.1 audit helper, 2.2 Clients, 2.3 Locations, 2.4 Products, 2.5 Rate card (versioned), 2.6 Users (+ agent stock-disposition prompt skeleton). |
| 3 — Manual delivery + state machine | ✅ done | State machine in DB (14 statuses, 175 transitions). `create_delivery()` (idempotent, snapshots rate, audit-logged) + `change_delivery_status()` (gates `requires_admin` / `requires_reason`, captures completion side effects). Admin + dispatcher screens: list / detail / new / status update modal / history timeline. |
| 4 — Stock model | ✅ done | All 9 reasons via `create_stock_adjustment` (single-row, 6 reasons, sign-validated) + `create_stock_transfer` (paired-atomic, 3 reasons). Idempotency unique-index on `client_uuid`. Admin Stock matrix + adjustment + transfer forms; Agent & Warehouse My-Stock views. `deactivate_user` now executes the Phase 2.6 disposition (transfer / warehouse / loss) atomically. |
| 5 — Agent app + push | ✅ code-complete | Agent Today list (status-priority sorted), shared delivery detail with tap-to-call + tap-to-map, Agent Earnings view (today/week/month). `expo_push_token` column + `set_my_expo_push_token` RPC. `usePushTokenRegistration` hook fires on login. Edge Function `send-assignment-push` accepts both manual `{ delivery_id }` and Supabase webhook payloads. Production wiring: deploy Edge Function + configure Supabase Database Webhook in dashboard. Real-device test outstanding. |
| 6 — Auto-assign + Reconciliation + EOD | ✅ done (corrections layered in 2026-05) | `auto_assign_delivery` + `AFTER INSERT` trigger on deliveries (stock-coverage + workload + per-agent location preference tier, full scoring trace audited). `rolled_over` terminal status (added to delivery_status_defs + current_status CHECK constraint; 'rollover' added to created_via CHECK) + `rollover_delivery` (atomic, rates re-snapshotted, idempotent on parent) + `run_eod_rollover` bulk runner. **Reconciliation RPCs**: `agent_earnings_summary` (sum `agent_payment_snapshot`, per delivery), `client_remit_summary` (returns `total_customer_price` / `total_paid` / `outstanding` / `total_reda_fee` / `total_remit`), `client_remit_detail` (per-delivery with `reda_fee` and `remit` columns). All admin/dispatcher gated; agents see only themselves. **Money model corrections** ([scripts/pricing-fix-per-delivery.sql](scripts/pricing-fix-per-delivery.sql) + [scripts/client-remit-proper.sql](scripts/client-remit-proper.sql)): `customer_price`, `charged_snapshot`, `agent_payment_snapshot` are all per-delivery flat amounts — quantity tracks stock, not money. Admin Reconcile tab now: **daily-first** range with chip presets (Today / Yesterday / Last 7 days / Custom), three sub-tabs (By client / By agent / Summary), per-client drill-down + **Share with client** plain-text report, summary tab with Reda's daily P&L + share. Per-agent location preferences via `agent_locations` + `set_agent_locations` RPC ([scripts/agent-location-preferences.sql](scripts/agent-location-preferences.sql)). All 12 smoke tests PASS. |
| 7 — Cutover seed + parallel-run protocol | ✅ seeded, parallel-run pending | Reusing current Supabase project as prod (no separate prod env). Real data seeded from 5 xlsx files via [scripts/build-phase7-seed.py](scripts/build-phase7-seed.py) + [scripts/build-phase7-stock-fix.py](scripts/build-phase7-stock-fix.py): 38 active clients, 118 products, 57 locations (split-to-finest with both rate sides), 16 agents (13 from Agent Groups + 3 from Inventory: Anjola, Funke, Mr Austin), Uzo as admin at `redalogisticss@gmail.com`. Stock backfilled via 156 `bulk_intake` adjustments from latest "Left With Agent" snapshots. Agent-identity consolidation: Queen→Queen Favour, M. Jerry→Iya Ayo. Cutover protocol with daily-reconciliation loop + rollback playbook + week-1 stock-reconciliation workflow documented in [reda_phase7_cutover.md](reda_phase7_cutover.md). Temp passwords in gitignored `scripts/phase7-agent-credentials.txt`. Operational xlsx and credentials file added to `.gitignore`. |
| 8 — Bot ingestion + AI normalization | ✅ **live in prod (2026-05-15)** | One Wasender session; client inferred from product (`product_catalog.client_id`), no Gemini client classification. Gemini 2.5-flash for extraction + address pick. Schema in [scripts/phase8-schema.sql](scripts/phase8-schema.sql) (applied) — `feature_flags`, `ai_config`, `bot_inbound_messages` (idempotency on `wasender_message_id`), `address_match_log.delivery_id` nullable. RPCs in [scripts/phase8-bot-rpcs.sql](scripts/phase8-bot-rpcs.sql) — `bot_create_delivery` (impersonates admin so existing `create_delivery` permission check passes; **accepts `p_assigned_agent_id` so the bot can pre-assign — 2026-05-15**), `match_products_by_text` (pg_trgm-ranked), `mark_inbound_processed`. Edge Functions: [supabase/functions/inbound-message](supabase/functions/inbound-message/index.ts) (HTTPS intake for external WhatsApp specialist; bearer-secret auth, `message_id` optional with sha256 fallback), [supabase/functions/normalize-address](supabase/functions/normalize-address/index.ts) (substring pre-check with word-boundary scoring → Maps Geocoding → Gemini pick with out-of-Lagos guard, always logs to `address_match_log`), [supabase/functions/bot-parse-message](supabase/functions/bot-parse-message/index.ts) (Gemini extraction → product trgm-match → client_id → invokes `normalize-address` → resolves `parsed.assigned_agent` → branches on `enable_bot_pipeline` × `bot_shadow_mode`). Mobile admin: [mobile/app/(admin)/needs-review.tsx](mobile/app/(admin)/needs-review.tsx) (tabbed queue: Needs Review / Shadow / Errors / All), [mobile/app/(admin)/flags.tsx](mobile/app/(admin)/flags.tsx) (3 toggles via `set_feature_flag`). **Initial flag state was `enable_bot_pipeline=false`, `bot_shadow_mode=true` (parse-but-don't-create). As of 2026-05-15 both flags flipped to `true / false` — bot now creates real deliveries.** Wasender outbound helper (8.7) deferred — not needed for v1. Corridor-style locations (`Lekki - Chevron`, `Ajah - Badore`, `Orchid - Ajah Under Bridge`) now carry Maps+Gemini-verified neighborhood aliases so the trigram pre-check covers common Lagos addresses without Gemini calls. |
| 9 — Online-with-resilience | ✅ code-complete | Persistent AsyncStorage-backed mutation queue in [mobile/src/queue/](mobile/src/queue/) — one queue, one drain loop, NetInfo-aware. Three executors registered: `change_delivery_status`, `create_stock_adjustment`, `create_stock_transfer` (the mutations agents + warehouse use in the field). Per-job `clientUuid` reuses existing server-side dedup so retries are safe. Backoff schedule 1s → 10m over 8 attempts before dead-lettering. Sticky [QueueBanner](mobile/src/queue/QueueBanner.tsx) above the tab bar shows offline / N pending / sync issues. [Dead-letter review screen](mobile/app/(queue)/dead-letter.tsx) lets admin retry or discard failed jobs. [useGuardedSignOut](mobile/src/queue/useGuardedSignOut.ts) blocks sign-out with double-confirm if queue is non-empty. Shared [Profile screen](mobile/src/screens/profile/ProfileScreen.tsx) added under every role with sync status + guarded sign-out. Sheets (`MarkDeliveredSheet`, `UpdateStatusSheet`) and admin stock forms (`adjust.tsx`, `transfer.tsx`) route through the queue. |
| 10 — Polish + beta + ship v1 | 🟡 dev work done; beta + ship pending | **Sentry stripped** for v1 → console-only [`logError`](mobile/src/lib/sentry.ts) wired into queue drain failures + persistence errors. `@sentry/react-native` uninstalled. **Performance pass** — `FlatList` virtualisation tuning (`initialNumToRender`, `windowSize`, `maxToRenderPerBatch`, `removeClippedSubviews`) + `React.memo` on the hot row components in the agent Today list and the shared Deliveries list; stable `keyExtractor` and separator references. **Error-state audit** confirmed every list/detail has loading/empty/error variants (Phase 1–9 screens use Empty/Banner; legacy catalog forms have functional 3-state but cosmetic raw styles). **Accessibility pass** — `accessibilityRole='button'` + `accessibilityLabel` on Button + FAB; StatusPill renders a label not just color; touch targets on Button stay ≥ 36px (sm) / 48px (md). **Three v1 docs shipped:** [reda_admin_runbook.md](reda_admin_runbook.md) (Uzo's daily loop), [reda_agent_guide.md](reda_agent_guide.md) (agent's day), [reda_paschal_runbook.md](reda_paschal_runbook.md) (deploy schema / rotate keys / where to find logs / disaster recovery). **Yours to drive:** beta week with Uzo + 1 trusted agent in prod with bot behind flag, then flip `bot_shadow_mode=false` when comfortable. ~~Flag flip executed 2026-05-15 after verifying a complete contractor payload (Gina/Gbagada/Queen Favour) ran cleanly end-to-end through the shadow pipeline.~~ |

---

## Iteration log — additions during beta testing (2026-05-15+)

Scope that landed on top of the phased plan during the testing window, ordered by ship date. Each is small enough that re-rowing the phase table would be misleading — they extend Phase 5/6/10 surface area without changing the phase narrative.

**Push notifications — productionised (2026-05-15)**
- Multi-device tokens: new `public.push_tokens` table (unique on `token`) replaces the single `users.expo_push_token` column. Sign-out releases via `release_my_expo_push_token`. Existing column kept until verified stable; drop later.
- New generic Edge Function [`send-notification`](supabase/functions/send-notification/index.ts) — audience-based fan-out (`user`, `admins`, `admins+dispatchers`, `assignment`, `status_change`), batches up to 100 messages, auto-prunes tokens returning `DeviceNotRegistered`. Deployed with `--no-verify-jwt` (internal-only).
- New triggers via `net.http_post`: `notify_pickup_needed` (admins/dispatchers when manual assignment is stockless), `notify_delivery_status_change` (admins on 5 terminal statuses), `notify_bot_review` (admins+dispatchers on `bot_inbound_messages.status='needs_review'`), `notify_negative_stock` (admins). Existing `notify_assignment_push` repointed to send-notification.
- New scheduled function [`scheduled-eod-check`](supabase/functions/scheduled-eod-check/index.ts) wired to Supabase Cron at `0 19 * * *`.
- Mobile [`lib/notifications.ts`](mobile/src/lib/notifications.ts) — `setNotificationHandler` + Android `default` HIGH channel via `configureNotifications()`; `useNotificationTapRouting(role)` for tap-to-route (data.route + data.delivery_id, no-op on web).

**Account self-service + login UX**
- New RPC `update_self_profile(display_name, phone)` — self-only, audit-logged.
- Profile screen rewrite: Edit profile, Change password (with re-auth), Unlock with Face ID / Fingerprint (`expo-local-authentication` native module — required APK rebuild), About → Check for updates (uses `expo-updates`), sign-out confirm dialog.
- Login screen: password eye toggle, lock icon (replaced wrong gear icon), inline Forgot password? → `resetPasswordForEmail`, remember-email via AsyncStorage.
- `Input` component gained a `rightAdornment` slot to keep the eye toggle composable.

**Agent location preferences — soft avoid**
- `agent_locations.kind` column added (`'preferred' | 'avoid'`, default `'preferred'`). Backfilled.
- `set_agent_locations(agent_id, preferred_ids[], avoided_ids[])` replaces the old 2-arg form with a conflict guard.
- `auto_assign_delivery`'s preference_tier extended: 1 preferred / 2 neutral (incl. agents with prefs elsewhere) / 3 avoid. Avoid still eligible — just last-resort.
- Admin UI on user edit: 3-state cycling chip per zone (neutral → ✓ preferred → ✕ avoid).

**Stockless-friendly assignment** (superseded 2026-05-20 — guard fully moved to delivered-time)
- `create_delivery` accepts `p_allow_insufficient_stock` (mobile always passes `true`). Hard-block flow retired in favour of notifications.
- New trigger `notify_pickup_needed` fires admins+dispatchers; the assignment push body gets a *"pick up N from warehouse first"* suffix (logic in send-notification's `assignment` audience).

**Stock UX overhaul**
- New screen `mobile/app/(admin)/stock/receive.tsx` — bulk vendor intake (multi-row, defaults to warehouse, supports direct-to-agent). Subsumes the `bulk_intake` reason on the adjustment screen.
- New screen `mobile/app/(admin)/stock/client/[id].tsx` — per-client stock detail + *Share with client* plain-text snapshot.
- Bulk warehouse transfer — `mobile/app/(admin)/stock/transfer.tsx` now multi-row for `warehouse_issue` / `warehouse_return`; single-row preserved for `transfer`.
- Stock index gained tabs (By holder / By client) and always shows the warehouse section even when empty.
- `services/stock.ts` exports `ADJUSTMENT_REASONS = SINGLE_REASONS - bulk_intake` and `groupByClient()`.
- Catalog → Client → *View stock* shortcut.

**Tech-debt extractions (done in the same PR as their consumers)**
- New shared component [`<Tabs>`](mobile/src/components/ui/Tabs.tsx) — replaces inline tab strips. Reconcile migrated; stock uses it.
- New shared hook [`useBulkRows`](mobile/src/hooks/useBulkRows.ts) — multi-row state for bulk forms. Bulk transfer + bulk receive both use it.

**Operational changes**
- Renamed `Test Warehouse` → `Shomolu warehouse`.
- Funke's −2 Retinol Gold Mask corrected back to 0 via a one-off `correction` stock adjustment (testing data, pre-validation period).

**In-app help guide + runbook as a generated artifact**
- New role-aware help screen at `/(profile)/help` driven by [mobile/src/help/content.ts](mobile/src/help/content.ts) (typed `HELP_BY_ROLE` for admin / agent / dispatcher / warehouse). Markdown rendered via `react-native-markdown-display` (one new runtime dep) inside a new [Collapsible](mobile/src/components/ui/Collapsible.tsx) primitive.
- AppBar gained a typed `helpTopic?: HelpTopic` prop — `?` icon in the top-right of major screens deep-links to the matching section with auto-expand + scroll-into-view. Slug typos fail at typecheck (`HelpTopic = (typeof HELP_BY_ROLE)[Role][number]['id']`).
- `reda_admin_runbook.md` is now generated from `content.ts` by [mobile/tools/build-runbook.mjs](mobile/tools/build-runbook.mjs). `npm run build:runbook` writes; `npm run check:runbook` exits 1 if stale. Authoring loop: edit `content.ts`, rebuild, commit both. The .md is no longer hand-edited.

**Review fix flow + pre-delivery edit + edit locking**
- New SQL paste [scripts/review-reconcile-and-edit.sql](scripts/review-reconcile-and-edit.sql): `edit_locks` table (5-minute TTL + heartbeat) with `acquire_edit_lock` / `release_edit_lock` / `heartbeat_edit_lock` / `_assert_holds_lock`; new mutation RPCs `update_delivery_fields` (admin/dispatcher; pre-delivery statuses only; lock-guarded; audit via `write_audit`), `resolve_inbound_to_delivery` (links a `needs_review` row to a freshly-created delivery), `discard_inbound` (moves a review row to error with reason).
- Mobile: new shared form [DeliveryFieldsForm](mobile/src/screens/deliveries/DeliveryFieldsForm.tsx) lifted from `New.tsx` (three consumers post-extraction: New, Edit, InboundDetail).
- New review-fix screen [InboundDetailScreen](mobile/src/screens/review/InboundDetailScreen.tsx) — pre-fills the form from `parse_result.extracted`, surfaces product-candidate chips when ambiguous, splits "phone1 or phone2" into a one-tap swap. Footer has **Create delivery** and **Discard** (with spam / duplicate / not-a-real-order / other reason picker).
- New delivery-edit screen [Edit.tsx](mobile/src/screens/deliveries/Edit.tsx) wired off an **Edit** icon on the delivery detail AppBar (admin + dispatcher, pre-delivery statuses only).
- New [useEditLock](mobile/src/hooks/useEditLock.ts) hook handles acquire-on-mount, 60-second heartbeat, release-on-unmount + take-over. Both the review-fix and delivery-edit screens render three lock states: `loading` / `held` / `held_by_other` (the latter shows "Uzo is editing this — Take over"). All mutation RPCs require the caller holds the lock; mobile gates are UX-only.
- Folder-ized routes: `(admin)/needs-review/{index.tsx, [id].tsx}`, `(dispatcher)/review/{index.tsx, [id].tsx}`, `(admin|dispatcher)/deliveries/[id]/{index.tsx, edit.tsx}`.
- New permission helpers `canEditDelivery(role, status)` + `canResolveReview(role)` in `permissions.ts`.

**Admin home hero — ops, not money**
- The black hero card on admin Home replaced *Today's gross / Remit collected / Margin* with three operational stats: **Orders** (today's count), **Completed** (delivered count), **Rate** (delivered ÷ total %). Per Uzo: "I don't care about customer money on the home, I care what's done." Daily P&L still lives on Reconcile → Summary tab.

**Stock visibility — zero-stock is now visible**
- Per-client stock detail ([mobile/app/(admin)/stock/client/[id].tsx](mobile/app/(admin)/stock/client/[id].tsx)) now fetches the full active catalog for the client and merges with `current_stock`. Out-of-stock products show with a red "Out of stock" pill + red `0` total. Header gains "· N out of stock" when relevant.
- By-Client tab on the stock screen merges with `listClients()` so every active client (e.g. Elite Store with no stock yet) appears with `0 units · Nothing in stock right now` in red, instead of silently being absent.
- Share-with-client snapshot now includes `OUT OF STOCK` lines instead of omitting zero products.

**customer_price is per-trip, not per-unit (enforced)**
- Four screens were multiplying `customer_price × quantity_ordered` for "money to collect" totals — wrong per the system design's "Charged is per-trip, not per-unit" rule. Fixed in [Detail.tsx](mobile/src/screens/deliveries/Detail.tsx), [(agent)/today/[id].tsx](mobile/app/(agent)/today/[id].tsx), [(admin)/eod.tsx](mobile/app/(admin)/eod.tsx), [(dispatcher)/index.tsx](mobile/app/(dispatcher)/index.tsx). Each line now has an inline comment so the bug doesn't get reintroduced. `MarkDeliveredSheet` already had it right and was the reference.

**Follow-up claim on soft-status deliveries**
- New SQL paste [scripts/delivery-followups.sql](scripts/delivery-followups.sql): `delivery_followups` table (PK on `delivery_id`, admin/dispatcher select-only RLS) + `claim_followup(delivery_id, takeover?)` (soft-status gate, take-over audited) + `release_followup(delivery_id)` (no-op for non-holders) + `tg_clear_followup_on_status_change` trigger (any change to `current_status` drops the claim — including soft→soft).
- New mobile service [followups.ts](mobile/src/services/followups.ts) + [FollowupClaimBanner](mobile/src/components/delivery/FollowupClaimBanner.tsx) with three states (no claim → "I'll handle this", you hold it → "Release", someone else → "{Name} is handling this · Take over"). Banner uses `useFocusEffect` so claim state refreshes on screen focus.
- Deliveries list rows show a small claimer-avatar pill next to the StatusPill on soft-status rows. Permissioned: admins + dispatchers only.
- New helper `canClaimFollowup(role, status)` derived from `STATUS_GROUPS.soft` so the soft-status list lives in one place.

**Delivery comms — agent ↔ ops messaging per delivery (2026-05-16)**
- New SQL paste [scripts/delivery-messages.sql](scripts/delivery-messages.sql): `delivery_messages` table (denormalized `author_role` snapshot mirroring `delivery_status_history.changed_by_name`; nullable `issue_type` set only on the opening agent message; nullable `client_uuid` with partial unique index for idempotency) + three security-definer RPCs (`flag_delivery_issue`, `reply_to_delivery`, `mark_messages_read`) + one trigger (`tg_notify_delivery_message`) that fans out via the existing `send_edge_notification` helper. Deliberately no `direction` column (derive from `author_role`) and no `closed_at` column / auto-close trigger (derive from `deliveries.current_status` — terminal ⇒ closed).
- `flag_delivery_issue` is the only path that writes `issue_type`. It atomically (a) inserts the message and (b) `perform`s `change_delivery_status(p_client_uuid::text, …)` when a non-null `p_new_status` is supplied. The chip → default status mapping (`cant_reach_client → not_answering`; `wrong_address/payment_dispute/product_issue → follow_up`; `other → no change unless opted in`) lives in [delivery-messages.ts](mobile/src/services/delivery-messages.ts) — surfaced in the [FlagDeliverySheet](mobile/src/components/sheets/FlagDeliverySheet.tsx) with `cant_reach_client` showing a `not_answering/number_busy/switched_off` override picker. One submission, one transaction — no drift between status pill and open-issue state.
- `reply_to_delivery` rejects when no prior agent flag exists (prevents ops seeding a thread) and when the parent delivery is terminal (keeps "open ↔ non-terminal" strict).
- New mobile service [delivery-messages.ts](mobile/src/services/delivery-messages.ts) with `listMessages`, `flagDelivery`, `postReply`, `markRead`, `listOpenIssuesForOps`. Notification fanout reuses `send-notification` audiences `admins+dispatchers` (on flag) and `user` (on reply) — no new Edge Function. Tap routing on the existing `data.delivery_id` deep-link path lands ops on the role-appropriate detail screen.
- New shared component [MessageThread](mobile/src/components/delivery/MessageThread.tsx) — vertical bubbles, agent bubbles left-aligned + ops bubbles right-aligned, first agent bubble shows the issue chip, inline composer for ops while open, "Thread closed — delivery is {status}" banner when terminal. Stays hidden until an agent flag exists, so the common no-issue case is silent. Dropped into [agent/today/[id].tsx](mobile/app/(agent)/today/[id].tsx) and [Detail.tsx](mobile/src/screens/deliveries/Detail.tsx) (admin + dispatcher share).
- Agent's AppBar grew an **alert** icon (not a third bottom-bar button) that opens FlagDeliverySheet. Hidden when the delivery is terminal.
- Admin Home gains an **Open issues from agents** attention block listing every unread agent-authored message whose parent delivery is still open. Tapping a row deep-links to the delivery detail; mark-read on focus removes it from the block.
- Smoke harness: [scripts/smoke-delivery-messages.sql](scripts/smoke-delivery-messages.sql) — runs inside a transaction with `ROLLBACK` so nothing persists. Covers flag + status transition, idempotency replay, wrong-agent 42501, ops reply, no-prior-flag 22023, mark-read, terminal-close + reply-blocked. Verified `auth.uid()` propagates through the security-definer wrapping (the inner `change_delivery_status` writes a `delivery_status_history` row authored by the agent, not the service role).

**Deliveries list sort — by most recent status change (2026-05-16)**
- Replaced the old per-role rules (admin/dispatcher: `created_at DESC`; agent: 4-bucket `STATUS_PRIORITY` from PRD §5.8) with a single rule applied in [listDeliveries](mobile/src/services/deliveries.ts): non-terminal rows first, ordered by `delivery_status_history.changed_at` DESC; terminal rows below, also by changed_at DESC. Falls back to `created_at` for never-changed rows.
- Implementation is one extra IN-query against `delivery_status_history` + client-side merge — no schema change, no denormalised `last_status_change_at` column, no trigger. ~50ms for hundreds of rows at current scale.
- Removed `sortByStatusPriority()` and the `STATUS_PRIORITY` map from `deliveries.ts` (not preserved as dead code — in git if anyone needs it). The agent's Today screen drops its `.then(sortByStatusPriority)` wrapper; admin/dispatcher list and the admin home "Recent activity" preview auto-inherit the new order.

**Delivery detail back navigation (2026-05-16)**
- The shared admin/dispatcher [Detail.tsx](mobile/src/screens/deliveries/Detail.tsx) AppBar back button now always lands on the deliveries list (`router.replace`) instead of `router.back()`. Fixes the case where entering the detail from the Home "Recent activity" card or the new "Open issues" attention block would pop back to Home instead of going to the list.

**Sibling coordination — race-assignment auto-cancel + rollover dedup (2026-05-18)**
- Uzo's existing pattern of assigning the same customer/product/day delivery to multiple agents (race-to-deliver) was creating real data integrity problems: double client-billing, double stock decrement, wasted agent trips. Live data probe found 15+ duplicate groups (Emmanuel × 4, Joel FBM × 3, Yetunde × 3, etc.) — frequent operational reality, not edge case. The yesterday-shipped auto-rollover was faithfully multiplying duplicates day over day.
- **SQL** ([scripts/sibling-coordination.sql](scripts/sibling-coordination.sql)): new `_norm_phone(text)` immutable helper strips formatting and country code so `+2348033017212` / `08033017212` / `8033017212` all collapse to one value. New `customer_phone_normalized` generated column on `deliveries` (Postgres backfilled existing rows automatically) + partial index `deliveries_sibling_lookup_idx` for the trigger's hot path. New `_find_sibling_deliveries(uuid)` helper applies a two-tier match: Tier 1 = both bot-created with identical `bot_raw_message` text (handles AI-parser drift across forwarded WhatsApp messages); Tier 2 = identical `lower(trim(raw_address))` + `quantity_ordered` (manual duplicates and rollover children). Two-stage trigger `tg_handle_sibling_coordination`: on `pending → available` push siblings a *"Stand by — <Agent> is on this"* notification (no DB changes); on `→ delivered` cancel all non-terminal siblings, attribute history rows to Reda System user, push the standing-down agents *"Delivery closed by <Agent>"*. INSERT trigger `tg_signal_new_sibling` covers the late-add case (Uzo creates a 4th duplicate after agent A is already en route).
- **Rollover dedup** ([scripts/phase6-rollover.sql](scripts/phase6-rollover.sql)): `run_eod_rollover` now uses a window function to partition eligible rows by sibling key. Only the oldest sibling per group rolls; the rest are cancelled in-place with reason "duplicate not completed, deduped on rollover". `RAISE NOTICE` logs the cancel count for the cron's function logs.
- **One-time backfill** ([scripts/cleanup-existing-sibling-duplicates.sql](scripts/cleanup-existing-sibling-duplicates.sql)): wraps a DO block in a transaction with a `RAISE NOTICE` summary before COMMIT. Dry-run against production found 42 groups loose-matched by (phone, product, date), 18 strict-sibling cancellations after Tier 1/Tier 2 filtering. The remaining 29 groups are correctly NOT siblings (different addresses / quantities / messages) — false-positive protection working as designed.
- **Scalability review surfaced during planning:** phone format variance (3 ways to write the same number), same-day repeat orders (false-cancel risk if match was too loose), trigger scan cost at 10× scale (partial index), late-add sibling signal (INSERT trigger), NULL `assigned_agent_id` in push fanout (skip silently), cancel attribution (Reda System, not the delivering agent), Stage 1 thrash guard (only fire on specific `pending → available` transition), cleanup reason date (`current_date::text` at runtime, not hardcoded). All eight closed before the SQL was written.
- **Smoke verified** in transaction-wrapped probes against live data: phone normalization across 4 input formats → identical output; Emmanuel × 4 → 3 siblings returned (Tier 2 via address+qty since rollover children don't carry `bot_raw_message`); Paul Phillip × 3 with 3 distinct addresses → 0 siblings (false-positive protection); Stage 1 push fires only on `pending → available` (sibling rows unchanged); Stage 2 cancels all non-terminal siblings + attributes to Reda System; rollover dedup on 3 synthetic identical siblings → 1 rolled + 2 cancelled.
- **Deliberately out of scope:** junction-table-based race assignment (Option B from the analysis — proper but ~2 weeks of work; revisit when team grows past ~10 agents), `customer_name`-only matching (false-cancel risk), revive cancelled siblings if winner later fails (rare; manual re-create remains the escape hatch), duplicate-warning popup at delivery creation (Paul Phillip × 3 case — accidental triple-submit, follow-up PR).

**EOD auto-rollover + Sunday-skip + system user + date nav on deliveries list (2026-05-17)**
- Closed the EOD/rollover visibility gaps surfaced by the day-after investigation: scheduled cron only notified (never rolled), `scheduled_date` filter hid yesterday's stuck rows from default views, and `rollover_delivery` blindly added `+1 day` even when that landed on Sunday (Reda doesn't work Sundays).
- **System-user pattern.** New `system@reda.local` admin (a real auth + public.users row — see [scripts/system-user-setup.sql](scripts/system-user-setup.sql)). The cron signs in as this user rather than using service-role, so every downstream RPC works through its normal admin role check and audit attribution shows "Reda System" instead of a faceless service call. Establishes the pattern for any future system-callable RPC.
- **SQL** ([scripts/phase6-rollover.sql](scripts/phase6-rollover.sql)): new `_ensure_workday(date)` immutable helper bumps Sunday → Monday; applied uniformly inside `rollover_delivery` to both default and explicit-override paths. New `run_eod_rollover_all_stuck(p_reason)` walks every distinct stuck date and calls `run_eod_rollover` per date in one transaction. Also fixed a pre-existing latent bug: switched `v_rate record` to scalar `v_rate_charged`/`v_rate_agent_payment` so rollovers for deliveries without `location_id` (common for bot-parsed rows with low-confidence addresses) no longer fail with "record not yet assigned."
- **Edge function** ([supabase/functions/scheduled-eod-check/index.ts](supabase/functions/scheduled-eod-check/index.ts)): repurposed from count-and-notify to sign-in-and-rollover. Reads `SYSTEM_USER_EMAIL` + `SYSTEM_USER_PASSWORD` from Edge Function Secrets, signs in via anon client + `signInWithPassword`, calls `run_eod_rollover_all_stuck`, sends one confirmation push (success: "Rolled N deliveries forward. Tap to review."; no-op: "All clear — nothing to roll."; failure: "Auto end of day FAILED — open the EOD screen and run it manually.").
- **Cron schedule manual step:** updated Supabase dashboard cron from `0 19 * * *` to `0 20 * * *` (21:00 Lagos / 20:00 UTC).
- **Mobile** ([mobile/src/screens/deliveries/List.tsx](mobile/src/screens/deliveries/List.tsx)): replaced the binary "today only / all dates" footer toggle with date-preset chips at the top: **Today / Yesterday / Custom / All dates**. Custom opens a YYYY-MM-DD `Input` (same shape as reconcile). Reuses `todayLagos` + `yesterdayLagos` from [lib/date.ts](mobile/src/lib/date.ts). Agent Today screen intentionally untouched — it's a current-day work queue, not an audit lookback.
- **Smoke test path:** `_ensure_workday` table sweep (Sun→Mon, Sat→Sat, Mon→Mon, Fri→Fri), single rollover with explicit Sunday override (→Monday), `run_eod_rollover_all_stuck` rolled 166 stuck deliveries across the Saturday date all landing on Monday (Sunday skipped), idempotency replay returned 0, history rows attributed to Test Admin (placeholder until Reda System user is created in dashboard).
- **Tech debt deliberately avoided:** I started by patching `rollover_delivery` with `OR auth.role() = 'service_role'` bypasses + `v_actor` admin-lookup fallbacks + inlining the parent flip to avoid `change_delivery_status`'s role check. After the user called this out as accumulating debt rather than fixing the root cause, I reverted all three and adopted the system-user pattern instead. The user-facing functions remain untouched — `auth.uid()` is always real because the caller is always a real user.

**Bot-side discoveries**
- The contractor's parser was hardcoding `quantity = 2` regardless of customer text — verified by querying 157 bot deliveries (zero drift between `raw_payload.parsed.quantity` and `deliveries.quantity_ordered`; 171 inbound messages all had `quantity=2`). Reported back to the contractor; our pipeline is faithful and not at fault. Pre-delivery edit lets admin correct individual cases until the contractor ships their fix.

**Tech-debt audit + cleanup pass**
- Centralised `TERMINAL_STATUSES` in [theme.ts](mobile/src/lib/theme.ts) (derived from `STATUS_GROUPS.done + .closed`) — replaced three identical inline sets in Detail/EOD/agent-detail.
- `FOLLOWUP_STATUSES` and `PRE_DELIVERY_STATUSES` in [permissions.ts](mobile/src/lib/permissions.ts) now derive from `STATUS_GROUPS` — single source of truth on the TS side. SQL inlines the same lists (Postgres can't import the enum); comments name the canonical source.
- Relocated `build-runbook.mjs` from gitignored `scripts/` to `mobile/tools/` (no secrets in the script, needs to ship in the repo so CI + clones can run `check:runbook`).
- Small fixes: duplicate `react-native` import in Detail.tsx folded; `useEffect` → `useFocusEffect` in FollowupClaimBanner; `Edit.tsx` skips lock acquisition on uneditable deliveries; redundant `as` casts in `followups.ts` removed (FK relationship in `database.gen.ts` made them unnecessary).

**Internal voice calling — PRD §5.17 (2026-05-19)**
- 1:1 in-app voice calls between any active internal users (admin / dispatcher / agent / warehouse). Replaces the WhatsApp/personal-SIM coordination layer §1 already targeted.
- 8 build phases (A–H): DB foundation → Edge Functions → Mobile prebuild → Caller side → Callee side → Multi-device coordination → History + entry points → Hardening.
- **Schema** in [scripts/internal-calls.sql](scripts/internal-calls.sql): `calls` table + 3 partial unique indexes + 6 RPCs (`initiate_call`, `accept_call`, `decline_call`, `cancel_call`, `end_call`, `mark_token_issued`) + 2 cron sweeps (`expire_ringing_calls` every 30s, `prune_net_response_log` daily). All 10 smokes in [scripts/smoke-internal-calls.sql](scripts/smoke-internal-calls.sql) pass. Critical caught-in-review fix: `public.calls` added to `supabase_realtime` publication (the publication had zero tables, would have silently broken all Realtime subs).
- **Edge Functions**: new [issue-agora-token](supabase/functions/issue-agora-token/index.ts) (5-min TTL via durations-in-seconds — agora-token v2 API; passing unix timestamps would have minted 56-year tokens, caught in self-review). [send-notification](supabase/functions/send-notification/index.ts) extended with `call_invite` audience.
- **Mobile**: Expo prebuild adopted (`expo-dev-client` + config plugins, compileSdk/targetSdk 35). Added `react-native-agora` for audio + `react-native-callkeep` for the native phone-call ring UX (Android `ConnectionService` → OS plays the user's chosen system ringtone, lock-screen full-screen UI, Bluetooth headset accept/end — same model WhatsApp uses).
- **Screens**: [(call)/team.tsx](mobile/app/(call)/team.tsx), [(call)/history.tsx](mobile/app/(call)/history.tsx) (with `?highlight=callId` deep-link from missed-call push tap), shared [(call)/call/[callId].tsx](mobile/app/(call)/call/%5BcallId%5D.tsx) (caller AND callee, differentiated by `userId === call.caller_id`). Entry from each role's **Profile → Team directory** + **Call history**.
- **Coordinator** ([coordinator.ts](mobile/src/lib/calls/coordinator.ts)) — module-singleton state machine: presentIncoming → CallKeep system ring → answer (RPC + token + Agora join + nav) OR declineFromSystemUI. Multi-device losing-device dismiss via `externallyDismissed` driven by the app-wide Realtime sub on `callee_id=eq.<me>`.
- Bumped `app.json` 1.0.0 → 1.1.0 so the `runtimeVersion: appVersion` channel keeps pre-1.1.0 APKs from downloading JS that references native modules they don't have.
- **Free-tier impact: zero net new cost.** Audio is peer-to-peer through Agora's SD-RTN — never touches Supabase storage. Agora free tier 10k voice min/mo covers projected ~1.2k/mo. `net._http_response` pruned daily.
- Deep dives: [reda_prd.md §5.17](reda_prd.md), [reda_system_design_doc.md §12](reda_system_design_doc.md), [reda_paschal_runbook.md → Internal voice calling](reda_paschal_runbook.md), [reda_admin_runbook.md → Call your team](reda_admin_runbook.md), [reda_agent_guide.md §6](reda_agent_guide.md).

**Stock guard moved from create → mark-delivered (2026-05-20)**
- Triggered by ~40 bot orders/day landing as `status='error'` with `insufficient_stock`. Root cause: `bot_create_delivery` doesn't pass `p_allow_insufficient_stock=true`, so the guard inside `create_delivery` rejected pre-assigned stockless agents. Manual UI sidestepped it for every call, making the parameter effectively dead. 57 (agent, product) pairs in `current_stock` are negative — phantom deliveries marked delivered against agents who never received intakes — and the bot was correctly refusing to compound the drift.
- **Product decision**: a delivery should be creatable + assignable regardless of stock; the guard fires only when the agent/admin tries to mark `'delivered'` without holding the stock. One chokepoint, not two.
- **SQL** ([scripts/move-stock-guard-to-delivered.sql](scripts/move-stock-guard-to-delivered.sql), single paste-able transaction): `create_delivery` drops `p_allow_insufficient_stock` and the stock-check branch entirely. `auto_assign_delivery` flips the hard `WHERE eligible` filter into a soft `eligible DESC` sort key — stocked agents still come first but stockless agents are now selectable as last resort instead of returning NULL. `change_delivery_status` gains the guard inside the existing `if p_to_status = 'delivered'` block, checking `current_stock(agent, product) >= quantity_delivered` (skipped if `assigned_agent_id is null`). Same error shape (`insufficient_stock: agent has X units, delivery needs Y`) so existing mobile error parsers keep working. `bot_create_delivery` redefined to match the new `create_delivery` signature (no longer references the dropped parameter).
- **Smoke**: [scripts/smoke-stock-guard-at-delivered.sql](scripts/smoke-stock-guard-at-delivered.sql) — transaction-wrapped ROLLBACK. Covers: stockless create succeeds, delivered-time guard fires, post-intake delivered succeeds, auto-assign picks a stockless agent when nobody has stock, partial-delivery guard against under-supplied agents.
- **Mobile cleanup**: dropped `allowInsufficientStock` field from `CreateDeliveryInput` ([services/deliveries.ts](mobile/src/services/deliveries.ts)) + the two callers that always passed `true` ([screens/deliveries/New.tsx](mobile/src/screens/deliveries/New.tsx), [screens/review/InboundDetailScreen.tsx](mobile/src/screens/review/InboundDetailScreen.tsx)). Types regenerated via `npm run gen:types`.
- **MarkDeliveredSheet** ([components/sheets/MarkDeliveredSheet.tsx](mobile/src/components/sheets/MarkDeliveredSheet.tsx)) — reuses the existing `getAgentProductStock` helper to fetch on-hand when the sheet opens. Shows on-hand inline under the quantity input + pre-validates `qty > onHand` with a clear inline error before enqueuing. Server raise stays the source of truth.
- **Operational note**: today's 57 negative-stock pairs will hit the new guard on the next mark-delivered attempt. Either record the missing intakes via `stock_adjustments` (reason `'correction'` or `'bulk_intake'`) or accept that those agents need a warehouse transfer first. The guard forces data honesty rather than hiding it.

**delivery_status CHECK → FK (2026-05-22)**
- Symptom: agent in the field hit "Sync issues — new row for relation 'deliveries' violates check constraint 'deliveries_current_status_check'" when trying `Status → not_connecting · Prince Segun`. Queue retried 5×, parked in dead-letter.
- Root cause: [scripts/extend-delivery-statuses.sql](scripts/extend-delivery-statuses.sql) added 8 new statuses (`not_connecting`, `not_around`, `will_call_back`, `not_available`, `picked_up`, `waybilled`, `abandoned`, `deferred_to_client`) to `delivery_status_defs` + `delivery_status_transitions` + mobile theme + three SQL functions — but the hardcoded `CHECK (current_status = ANY (ARRAY[...14 statuses...]))` constraint on `deliveries.current_status` was left at the original list. Mobile UI offered them, transitions table accepted them, then the final UPDATE on `deliveries` failed. Classic two-sources-of-truth drift.
- **Fix** ([scripts/fix-deliveries-status-fk.sql](scripts/fix-deliveries-status-fk.sql)): drop the CHECK; add an FK on `deliveries.current_status` → `delivery_status_defs(status)`. Also adds FKs to `delivery_status_history.{from_status, to_status}` (previously unconstrained) for symmetry + future-proofing. Now `delivery_status_defs` is the single source of truth — adding a future status is one insert; no second migration. Mirrors the existing pattern `delivery_status_transitions` already used.
- Verified orphan-free before applying (0 unknown values in any of the 3 columns).
- **Doc cleanup**: [reda_system_design_doc.md §6](reda_system_design_doc.md) auto-assign+stock paragraph rewritten for the 2026-05-20 stock-guard move (it still referenced `p_allow_insufficient_stock`). [reda_system_design_doc.md §7](reda_system_design_doc.md) status state-machine section now lists all 22 statuses and names `delivery_status_defs` as the source of truth.
- **Known remaining debt** (not silently fixed — out of scope for this incident): three prod functions still hardcode the soft-status list inline (`update_delivery_fields`, `agent_pending_workload`, `claim_followup`). Same drift pattern that just bit us. Refactor candidate: derive the list at runtime from `delivery_status_defs.category` (plus a small subcategory column or flag to keep `picked_up`/`waybilled` out of follow-up + workload sets). Tracked separately.

**Web build on Vercel free (2026-05-26)**
- Uzo asked to access the app from a desktop browser. The codebase already had the right foundation — Expo SDK 54, `react-native-web 0.21`, Expo Router with web support, `"web"` declared in [app.json](mobile/app.json) platforms, and 10 existing `Platform.OS === 'web'` guards across the source tree. What was missing: a static-output config, two native-import crash points to neutralize, a build script, an SPA fallback for deep links, and Vercel config.
- **Decision**: web ships for **all roles** (admin / dispatcher / rep / agent / warehouse). Native-only features (voice calling, biometric unlock, push notifications) gracefully degrade on web with clear "use your phone" hints. One source tree → two targets (Android via EAS, web via Vercel).
- **Web output config** ([app.json](mobile/app.json)): added `"bundler": "metro"` + `"output": "single"` to the existing `"web"` block. SPA mode (single HTML entry) is the right shape for a login-gated internal tool — no SEO benefit to pre-rendering, dynamic routes (`[id].tsx`) don't need `generateStaticParams()`.
- **Native-import crash points neutralized**:
  - [src/lib/calls/agora.ts](mobile/src/lib/calls/agora.ts) was statically `import`-ing `react-native-agora`, which transitively imports `react-native/Libraries/Utilities/codegenNativeComponent` — a New Architecture artifact with no web shim. Bundler crashed at build time before any Platform check could run. **Fix**: added [src/lib/calls/agora.web.ts](mobile/src/lib/calls/agora.web.ts), a no-op stub that exports the same surface. Metro's platform-extension resolution (`.web.ts` wins on web, falls through to `.ts` on native) means the native Agora module is never followed when bundling for web. Cleanest possible split — no runtime checks, no defensive requires, no maintenance burden on the native code path.
  - [BiometricLockScreen](mobile/src/screens/BiometricLockScreen.tsx) had latent risk: on web `expo-local-authentication.hasHardwareAsync()` returns false (so `bioSupported` is naturally false), but a localStorage flag drift could still flip the lock state on. **Fix**: in [app/_layout.tsx](mobile/app/_layout.tsx), `lockState` immediately resolves to `'unlocked'` when `Platform.OS === 'web'`. The screen never renders on web; the actual screen file stays platform-agnostic.
  - [app/_layout.tsx](mobile/app/_layout.tsx) startup wrapped `setupCallKeep()` + `addAnswerListener` + `addEndListener` in a `Platform.OS !== 'web'` guard (the underlying `callkeep.ts` was already defensive — this just silences the would-be console.warns and skips work the browser can't do).
  - `IncomingCallOverlay` mounted only when `Platform.OS !== 'web'`. Showing the overlay on web without Agora would be half-broken.
- **Voice-call gating**: new [src/lib/calls/availability.ts](mobile/src/lib/calls/availability.ts) exports `canPlaceCall()` (returns false on web) + `CALL_UNSUPPORTED_HINT` (copy). Single source of truth for "can this device place a call" — UI surfaces ask this helper instead of inlining `Platform.OS === 'web'` everywhere. Wired into:
  - [Detail.tsx](mobile/src/screens/deliveries/Detail.tsx): per-row Call button hidden on web; "Call a teammate" footer hidden on web.
  - [(call)/team.tsx](mobile/app/(call)/team.tsx): each user row's `disabled` prop respects `canPlaceCall()`; `onCall()` short-circuits with an Alert on web. A `Banner` at the top of the screen on web reads *"Calls work on the mobile app — open the app on your phone to place a call."*
- **Build & deploy plumbing**:
  - [package.json](mobile/package.json) gained `build:web` (`expo export -p web`) and `preview:web` (build then `npx serve dist`).
  - New [vercel.json](mobile/vercel.json) sets the build command, output dir, install command, and a catch-all rewrite (`/(.*) → /`) so deep links like `/(admin)/deliveries/abc-123` resolve to the SPA entry.
- **Local smoke**: `npm run build:web` produces `dist/` with `index.html` + `_expo/static/js/web/entry-*.js` (2.19 MB bundle). `npx tsc --noEmit` clean. The next step is a one-time Vercel project creation pointing at `mobile/` as the root, then push to main.
- **Intentional limitations** (documented in [reda_prd.md §3](reda_prd.md)): voice calling, biometric unlock, push notifications, and OTA updates are mobile-only. Vercel free plan's commercial-use clause is widely treated as unenforced for small internal tools (~5 users); if it ever becomes a concern, Cloudflare Pages offers identical static hosting at the free tier with no commercial restriction.
- **Tech-debt audit**: one new helper file (`availability.ts`), one platform stub (`agora.web.ts`), one Vercel config. Zero parallel codebase — every change either guards on `Platform.OS === 'web'` or uses Metro's platform-extension mechanism (which is the engine's intended split point). No regressions on Android — all guards are `web !== Android` no-ops.

**Self-edit email address (2026-05-26)**
- Every Reda account today uses a `@reda.dev` (or `@reda.local`) placeholder email from phase-7 seeding. Real inboxes are needed for password resets and any future transactional mail. Letting users update their own email closes the gap — the data converges to real addresses as people use the feature, no bulk migration required.
- Display-name and phone editing already shipped via `update_self_profile(p_display_name, p_phone)` (phase 4) — the user can already type whatever they want into the name field on Edit Profile. The only gap was email, which previously showed "Contact Uzo to change your email."
- **Server** ([scripts/email-self-edit-sync.sql](scripts/email-self-edit-sync.sql), single paste): added `tg_sync_user_email_to_public()` SECURITY DEFINER function + `sync_user_email_to_public` trigger on `auth.users` AFTER UPDATE OF email. Whenever Supabase confirms an email change, the trigger mirrors the new value into `public.users.email`. Closes a pre-existing latent drift risk (the two columns were independently maintained with no sync).
- **Mobile**:
  - New service [changeMyEmail](mobile/src/services/users.ts) mirrors the existing `changeMyPassword` shape: re-auth with current password, then `supabase.auth.updateUser({ email })`. The Supabase confirmation flow handles the actual change.
  - New screen [mobile/app/(profile)/change-email.tsx](mobile/app/(profile)/change-email.tsx) — a direct twin of [change-password.tsx](mobile/app/(profile)/change-password.tsx) with current-password / new-email / confirm-new-email fields, basic email regex validation, and an `Alert.alert("Check your inbox", …)` on success.
  - [ProfileScreen.tsx](mobile/src/screens/profile/ProfileScreen.tsx) gains a *Change email* row between *Edit profile* and *Change password*.
  - [edit.tsx](mobile/app/(profile)/edit.tsx) — the old "Contact Uzo to change your email" footer is replaced with a tappable *Change email →* link. The email value stays displayed read-only so users still see what's there.
  - New `mail` icon added to [Icon.tsx](mobile/src/components/ui/Icon.tsx) (envelope; lucide source).
- **No new RPC**: deliberately routed through `supabase.auth.updateUser({ email })` instead of extending `update_self_profile`. Supabase owns the new-email-confirmation roundtrip; routing through our RPC would create a window where `public.users.email` is updated before `auth.users.email` is confirmed, breaking the user's session.
- **Audit**: Supabase's `auth.audit_log_entries` already records `user_modified` events for email changes. We don't duplicate that in our own `audit_log` — the sync trigger inherits that source of truth.
- **Tech-debt audit**: no new RPC, no new audience kind, no new state. New screen + service are direct copies of the password-change pattern. The sync trigger closes a latent drift bug, not introduces one. Mobile typecheck clean. Ships in two steps: paste SQL, then `eas update`.

**New `rep` user role — dispatcher-equivalent minus stock (2026-05-26)**
- Reda needed a role for teammates who book and coordinate deliveries but never handle inventory. Conceptually: dispatcher capabilities, zero stock access (no stock screens, no read on `stock_adjustments`, no stock-flavored pushes).
- **Server side** ([scripts/add-rep-role.sql](scripts/add-rep-role.sql), single paste-able transaction):
  1. `users.role` CHECK constraint extended to accept `'rep'`. `delivery_messages.author_role` CHECK likewise.
  2. `public.is_admin_or_dispatcher()` body widened to include `'rep'`. Verified the dispatcher-equivalent permission surface flows naturally because 16-of-16 RLS policies that mention dispatcher reference this helper (no inlined `role = 'dispatcher'` anywhere — confirmed via `pg_policy` dump). A `COMMENT ON FUNCTION` documents the convention at the definition site, since the legacy name no longer matches the body literally.
  3. The one exception: `stock_adj_select_admin_dispatcher` policy was replaced with a tighter version that only grants SELECT to `('admin','dispatcher')` (+ self-row for agents). Rep gets nothing on `stock_adjustments`, matching the user's "no stock access at all" requirement.
  4. `tg_notify_pickup_needed` audience changed from `admins+dispatchers` to `admins`. Dispatcher has no stock UI to action this push (the (dispatcher) route group has no `/stock` tab) — the audience was stale. Aligning audience with action capability incidentally solves the rep exclusion at the same time.
- **Edge Function** ([supabase/functions/send-notification/index.ts](supabase/functions/send-notification/index.ts)): `admins+dispatchers` audience resolver expanded from `['admin','dispatcher']` to `['admin','dispatcher','rep']`. Mirrors the server-side helper's semantic — reps get bot-review / bot-error pushes (they action those), but not stock-pickup pushes (now `admins`-only).
- **Mobile**:
  - [permissions.ts](mobile/src/lib/permissions.ts): `Role` union widened to 5 members. Introduced a private `OPS_ROLES` set + `isOps()` helper. Refactored 8 existing helpers from `role === 'admin' || role === 'dispatcher'` to `isOps(role)`. Single source of truth on the TS side; mirrors `is_admin_or_dispatcher()` SQL helper.
  - `/(rep)/` route group created as a thin twin of `/(dispatcher)/` (12 files). To avoid duplicating the 200-line dispatcher dashboard, extracted it to [mobile/src/screens/ops/OpsDashboard.tsx](mobile/src/screens/ops/OpsDashboard.tsx) taking a `basePath` prop. Tab-bar similarly extracted to [OpsTabsLayout.tsx](mobile/src/screens/ops/OpsTabsLayout.tsx). Both `(dispatcher)/` and `(rep)/` are now thin shims passing their own basePath. Net code: one shared dashboard, two thin layouts.
  - `BasePath` type widened across [List.tsx](mobile/src/screens/deliveries/List.tsx), notification routing, Detail.tsx back/edit handlers, and the review screen. The dispatcher-vs-admin ternary in Detail.tsx became a three-way ternary; the notification path resolver gained a `rep` case.
  - `VIEW_FOR` in [services/deliveries.ts](mobile/src/services/deliveries.ts) maps `rep → deliveries_safe` (the no-margin view, same as dispatcher and agent).
  - Catalog → New user / Edit user pickers gained a `Rep` option; the call directory ROLE_ORDER + ROLE_LABEL include rep.
  - Help content: `const REP = DISPATCHER` alias + `HELP_BY_ROLE.rep` entry. Identical workflows = identical copy; if rep-specific copy is needed later this is the seam.
- **Routing**: no change. The route picker in [app/_layout.tsx:139](mobile/app/_layout.tsx#L139) already does `/(${account.role})`, so a rep account is routed to `/(rep)/` automatically once the route group exists.
- **Auto-assign**: no change needed. `auto_assign_delivery` filters `role = 'agent'` — rep is naturally excluded from the candidate pool.
- **Tech-debt audit**: no new RPC, no new audience kind, no new RLS pattern. The one semantic widening (`is_admin_or_dispatcher` now includes rep) is documented via SQL `COMMENT`. The `tg_notify_pickup_needed` audience tightening is a fix, not a workaround — dispatcher had no UI to act on it. Mobile dashboard extraction removed an existing 200-line monolith in favor of the same thin-shim pattern already used everywhere else under `(dispatcher)/`. Mobile typecheck clean.
- **Ship order**: paste SQL first (so rep accounts and rep RLS exist), deploy `send-notification` Edge Function (`supabase functions deploy send-notification`), then `eas update` for the mobile changes. Creating a rep account before any of these is harmless — the CHECK constraint rejects the insert until the SQL runs.

**Admin/dispatcher delivery list: customer-name search (2026-05-26)**
- Uzo asked for a way to find a specific customer's delivery quickly on the admin/dispatcher list. Today's filter row already has date + status + agent narrows; customer name was the obvious missing one (the row labels are customer name, so visual scanning works only for tiny lists).
- [mobile/src/screens/deliveries/List.tsx](mobile/src/screens/deliveries/List.tsx): added a search `Input` (icon=search, clear-button right adornment) between the status `FilterChips` and the agent picker. State is a single `nameQuery` string; matching is case-insensitive substring on `customer_name`. Runs in the same `useMemo` as the agent narrow, BEFORE the status-bucket split — so the Active/Soft/Done/Unassigned counts reflect the filtered slice the same way the agent narrow already does.
- Empty-state subtitle updated to call out the search term when it's active ("No deliveries matching \"Tunde\" for Funke on 2026-05-26 — try clearing the search or agent filter") so an empty result doesn't read like a broken date/agent combo.
- Gated by `canAssignDelivery(role)` — admins + dispatchers only. Agents see at most a handful of rows on screen; the search would just add noise.
- **Tech-debt audit**: no new component, no new fetch, no new RPC. Reuses the existing `Input` ui component and the search icon already in the icon set. Mobile typecheck clean. Ships via `npx eas update`.

**Stock-sufficiency guards across all 3 decrement paths + bulk negative-cleanup (2026-05-24)**
- Investigation triggered by "still seeing sync errors in admin view" report. DB showed **67 (agent, product) pairs at negative stock**, **478 open deliveries blocked** by the mark-delivered guard, and 18 new negative deltas accumulated since 2026-05-20 — every one a `warehouse_issue` against Shomolu warehouse with no recorded intake.
- Root cause: when the mark-delivered guard landed on 2026-05-20, I only plugged ONE of three stock-decrement paths. `create_stock_transfer` (source side) and `create_stock_adjustment` (loss/theft/damaged) remained unguarded. Admins were issuing warehouse_issue transfers from a warehouse with zero stock — warehouse went deeper negative each time, agents got phantom stock, agents then passed the mark-delivered guard and the loop closed. Net: warehouse permanently underwater, books never reflected reality, sync queue piled with `insufficient_stock` errors from real deliveries trying to mark against the depleted state.
- **Fix** ([scripts/bulk-correct-and-tighten-stock-guards.sql](scripts/bulk-correct-and-tighten-stock-guards.sql), single paste-able transaction):
  1. Bulk-corrects all 67 negative pairs to 0 via `correction` adjustments (audit-logged batch, idempotent client_uuid `bulk-neg-correction:<agent>:<product>:2026-05-24`). Signs in as the Reda System admin user via `set_config('request.jwt.claims', ...)` so the security-definer RPCs see a real `auth.uid()`.
  2. `create_stock_transfer` now requires `current_stock(from_user, product) >= quantity`. Skipped when `from_user.is_active = false` so the deactivation-flow stock handoff isn't deadlocked by demanding the books be accurate.
  3. `create_stock_adjustment` now requires `current_stock(user, product) >= |quantity_delta|` for `loss` / `theft` / `damaged`. `correction` stays unguarded — the explicit "books were wrong" escape hatch. Positive reasons (`found`, `bulk_intake`) need no check.
- All three guards raise the same error: `insufficient_stock: <source> has X units, <op> needs Y`, errcode `P0001`, hint JSON containing `code` / `on_hand` / `needed`. Mobile UI parsers for `insufficient_stock` already work — no client changes.
- **Tech-debt audit**: no new error shapes, no new tables, no new RPCs. Removes the inconsistency where one of three decrement paths was guarded and two weren't. Same `current_stock` view used by every guard, so adding/removing intake reasons in the future doesn't require touching the guards. `correction` becoming the single negative-producing path means `notify_negative_stock` triggers become rare + meaningful again (instead of firing constantly).
- **Doc updates**: [reda_prd.md §5.10](reda_prd.md) edge-cases block rewritten — old "negative allowed, notify fires" wording removed, new three-guard policy documented with `correction` carved out as the explicit escape hatch.
- **Pre-flight verified**: 67 negative pairs to clean; 12 agents affected; 27 products affected; 478 open deliveries blocked. After the paste those numbers should all drop near-zero (the 478 unblocks because agents' balances are no longer negative).

**Rules-of-Hooks fix in delivery detail (2026-05-23)**
- Uzo reported "Something went wrong · Rendered more hooks than during the previous render" on every order he opened, post the 2026-05-22 ship. The ErrorBoundary added the day before was correctly catching the failure — but the underlying bug was pre-existing and load-bearing latent.
- Root cause: [mobile/src/screens/deliveries/Detail.tsx](mobile/src/screens/deliveries/Detail.tsx) declared `useCallback(callTeammate, ...)` AFTER the loading/error early returns. First render (loading=true) called N hooks; second render (data loaded, no early return) called N+1 hooks. Classic Rules of Hooks violation. The original "blank screen / freeze" report on 2026-05-22 was almost certainly this same bug — adding the ErrorBoundary just surfaced it loudly instead of failing silently.
- My 2026-05-22 additions (`useQueue` + queue-watch `useEffect`) were both placed BEFORE the early returns, so they didn't introduce the issue. But the extra hook indices likely shifted React's runtime into catching the latent violation consistently where before it slipped through intermittently.
- **Fix**: moved `useCallback(callTeammate)` above the early returns and switched the dep from `d.id` (post-guard) to `deliveryQ.data?.id` so it works pre-guard too. Hook order is now identical across every render. Audited the rest of the codebase with a precise scanner (find function-body-level `return (` then look for subsequent hook calls at the same brace depth) — Detail.tsx was the only file with this pattern. Agent variant [today/[id].tsx](mobile/app/(agent)/today/%5Bid%5D.tsx) was already clean.
- **Tech-debt audit**: pre-existing latent bug, finally surfaced + fixed. No new code patterns introduced. ErrorBoundary stays — it's still the right defensive layer for any future render-throw.
- **JS-only** → ships via `npx eas update`.

**Stock transfer: shared-agent bulk mode (2026-05-22)**
- Uzo flagged ([WhatsApp 2026-05-22]) that the warehouse-issue / warehouse-return form forced him to re-pick the agent on every product row. Real workflow: an agent comes to the warehouse, collects ALL their products in one visit, leaves. Form should follow that — pick agent once, list products.
- [mobile/app/(admin)/stock/transfer.tsx](mobile/app/(admin)/stock/transfer.tsx): moved the per-row Agent picker to a shared top-level picker (sits next to the existing shared Warehouse picker). BulkRow shape dropped `agentId`; rows are now `(client, product, qty)`. Submit fans out the same way, just using `bulkAgentId` for every row's from/to. Mirrors the existing Receive-stock pattern (one destination at top, multiple product rows) — consistency win, not a new pattern.
- Button labels became action-oriented: `Issue 3 products to Nnenna` / `Collect 2 products from Audrey` (instead of the opaque "Issue 3 transfers"). Falls back to neutral phrasing until the agent is picked.
- Row label changed from "Row N" to "Product N" — matches the new mental model (the rows are products, not transactions).
- **Capability trade-off**: multi-agent-in-one-submit dropped. Per Uzo's description that pattern doesn't match the real flow anyway; the form now matches reality. If a future workflow needs multi-agent in one go, the easy path is a "Save and start another" affordance (same form, just reset agent+rows, keep warehouse).
- **Tech-debt audit**: no new components, no new fetches, no new RPCs. Server-side `create_stock_transfer` unchanged. Form state shrank (per-row agent removed). Reuses `useBulkRows`. Matches the existing Receive-stock pattern. Mobile typecheck clean.
- **JS-only** → ships via `npx eas update` together with the other 2026-05-22 changes.

**Stuck-mutation freeze + agent home cleanup (2026-05-22)**
- Three small product/safety changes shipped together as one `eas update`.
- **Auto-rollover paused**: Uzo disabled the `scheduled-eod-check` cron in the Supabase dashboard. Manual EOD ([mobile/app/(admin)/eod.tsx](mobile/app/(admin)/eod.tsx)) still works. Reversible via dashboard toggle; no repo change needed.
- **Agent home "To collect" total removed**: Uzo flagged that the running sum of cash-to-collect at the top of the agent home page is a theft risk (an agent walking around knowing the day's bag size). [mobile/app/(agent)/today/index.tsx](mobile/app/(agent)/today/index.tsx) tri-stat bar is now bi-stat (Earned today / Deliveries). Per-delivery card prices stay — agents need them to know what to ask each customer. Doc + help-content references updated ([reda_agent_guide.md](reda_agent_guide.md), [mobile/src/help/content.ts](mobile/src/help/content.ts)).
- **Stuck-mutation freeze fixed**: Mary (admin) experienced screen-blank + app-freeze when opening deliveries that had dead-lettered `change_delivery_status` mutations from Olawale (agent) on the same shared phone. Root cause: optimistic status state in [Detail.tsx](mobile/src/screens/deliveries/Detail.tsx) + [(agent)/today/[id].tsx](mobile/app/(agent)/today/%5Bid%5D.tsx) only cleared when `d.current_status === optimisticStatus` — but on permanent failure, server status never matches, so the optimistic veil persisted forever. Combined with a setState-during-render anti-pattern and no top-level error boundary, the screen was unrecoverable until force-close.
- **Fix** — three layered changes:
  1. **Queue surfaces job IDs**: [mobile/src/queue/mutations.ts](mobile/src/queue/mutations.ts) — all three enqueue hooks return the queue job ID. `MarkDeliveredSheet` and `UpdateStatusSheet` capture it and pass through `onConfirmed/onCommitted(newStatus, jobId)`. Detail screens watch the job's lifecycle via `useQueue()` and clear the optimistic veil when the job either disappears (succeeded) or transitions to `status='dead_letter'` (permanently failed). Direct-RPC paths (FlagDeliverySheet) pass `jobId: null` and rely on server-status match alone. setState-during-render block deleted from both screens.
  2. **MarkDeliveredSheet open-gate**: stock pre-fetch now keyed on `[open, delivery?.id]` instead of `[delivery]`, so a closed sheet never queries `current_stock`. Was causing redundant fetches on every parent reload.
  3. **Top-level ErrorBoundary**: new [mobile/src/components/ui/ErrorBoundary.tsx](mobile/src/components/ui/ErrorBoundary.tsx) — class component, catches render errors anywhere below `<Slot/>`, shows "Something went wrong · Try again" recovery UI, logs via existing `logError` helper. Wrapped around the app root in [_layout.tsx](mobile/app/_layout.tsx). Strict net-positive defensive add; same Empty + colors/fonts primitives, no new theming.
- **Tech-debt audit**: no new hardcoded constants, no schema changes, no new RPCs, no duplication. The `optimistic` state shape changed from `string | null` to `{ status; jobId: string | null } | null` — one consistent shape across both detail screens. setState-during-render removed (anti-pattern). MarkDeliveredSheet useEffect dep changed from `[delivery]` to `[open, delivery?.id]` — strictly tighter, no behavioral regression. ErrorBoundary reuses existing `Empty` + `colors`/`fonts`/`logError`.
- **JS-only** → ships via `npx eas update`. Mobile typecheck clean.

---

## Phase 0 — Project & schema foundation (week 0, ~3-5 days)  ✅

**Goal:** every later phase rests on this. Get it wrong and every later phase pays.

**Deliverables:**
- Monorepo or single-repo structure decided and scaffolded (Expo app + `supabase/` dir for SQL + edge functions).
- Supabase project provisioned (free tier, separate **dev** and **prod** projects from day one — never share).
- Local dev: Supabase CLI installed, `supabase start` working, migrations applied locally.
- `reda_schema.sql` translated into numbered migration files: `0001_init.sql`, `0002_rls.sql`, `0003_functions.sql`, etc. Schema applied via `supabase db push` only.
- RLS policies written and tested for **all** tables, including the deny-by-default case. Margin columns covered.
- `audit_log` insert helper function + trigger pattern decided (trigger vs. explicit insert in each function — pick one and stick to it).
- `current_stock` view created and tested with seed data.
- TypeScript types generated and committed: `supabase/types.gen.ts`.
- Expo project initialized with: TypeScript strict mode, ESLint, Prettier, absolute imports, `app.json` configured for Android+iOS.
- Supabase JS client wired into the app with anon key from `.env`. **No service role key ever in the app or repo.**
- `.env.example`, `.env.local`, `.env.production` discipline established. Secrets in Supabase dashboard / EAS secrets, never in git.
- CI: GitHub Actions running `tsc --noEmit`, lint, and `supabase db diff` on PRs.
- Sentry (or equivalent) DSN plumbed into Expo, even if events are silenced. **Adding crash reporting after release is 3× the work.**
- A single seed script that produces: 1 admin, 1 dispatcher, 2 agents, 1 warehouse user, 3 clients, 6 products, 5 locations, a rate card. Re-runnable.

**Tech-debt traps to avoid:**
- ❌ Using a single Supabase project for dev and prod. Once real data is in prod, you can never reset.
- ❌ Skipping RLS "for now, we'll add it later." Every query written without RLS in mind develops assumptions that break when RLS turns on.
- ❌ Hand-writing TypeScript types for DB rows. They drift within a week.
- ❌ Putting business logic in the client first "to prototype faster." It never gets moved.
- ❌ Letting the schema diverge between dev environments by editing the Supabase UI.

**Exit criteria:** A developer (or future Paschal in 3 months) can clone the repo, run two commands, and have a working local dev environment with seeded data. RLS denies a non-admin reading margin. Types regenerate on schema change.

---

## Phase 1 — Auth, roles, and the permission spine (week 1)  ✅

**Goal:** the security model works end-to-end before any feature uses it.

**Deliverables:**
- Login screen (5.1).
- Role-aware navigation skeleton: admin tabs, dispatcher tabs, agent tabs, warehouse tabs all stubbed out but routed correctly.
- A `useCurrentUser()` hook that resolves `public.users` row including role, cached for the session.
- Permission helpers: `canSeeMargin()`, `canAdjustStock()`, `canEditCatalog()`, etc. — wrappers over role, **with corresponding RLS policies that enforce the same rule on the server**. Helpers and policies must be a 1:1 mapping.
- "Account deactivated" and "Account setup incomplete" paths handled.
- Session persistence across app restart (Supabase handles this; verify it).
- A test script (manual or scripted) that logs in as each of the four roles and confirms which tabs/screens are visible and which queries succeed/fail.

**Tech-debt traps to avoid:**
- ❌ Hardcoding role checks scattered in components. Centralize in helpers from the start.
- ❌ Relying only on UI hiding for sensitive data (margin). Test with raw SQL/REST that a dispatcher token can't read margin columns.
- ❌ Skipping "deactivated user" handling. Real-world need; bolting it on later means auditing every screen.

**Exit criteria:** Each role can log in, sees the correct empty shell, and cannot — via app or direct API call — see data outside their role.

---

## Phase 2 — Catalog & user management (week 2)  ✅

**Goal:** admin can set up the world. Soft-delete and rate-card-versioning patterns established here will be reused everywhere.

**Deliverables:**
- 5.2 User & agent management.
- 5.3 Clients, products, locations, rate card.
- Soft-delete pattern: every list query filters `deleted_at IS NULL` by default. Build a reusable hook or query helper so this is not forgotten in any future list.
- Rate card edits create a new row + close the previous (`effective_until`). Test that historical lookups via `effective_at` return the correct rate.
- Stock disposition prompt skeleton when deactivating an agent (the real flow lands in Phase 4 with stock; here, just the prompt + branch).
- Every catalog mutation writes to `audit_log` inside the same transaction.

**Tech-debt traps to avoid:**
- ❌ Hard deletes anywhere. Even in admin tools. Foreign key references will rot.
- ❌ Mutating rate card rows in place. Once you do this once, historical snapshots become unreproducible and reconciliation breaks.
- ❌ Skipping audit log on "boring" catalog edits. The day Uzo says "who changed the Lekki rate?" you'll wish you had it.
- ❌ Letting `notes` on clients become a junk drawer with no rendering rules — agree on Markdown vs. plain text now (PRD says free-form text; lock to plain text for v1, escape on render).

**Exit criteria:** Admin can create the full Reda world from scratch. Reactivating, renaming, and rate-changing all leave a clean audit trail. Soft-deleted entities never appear in non-admin lists.

---

## Phase 3 — Delivery: manual creation, list, detail, status state machine (week 3-4)  ✅

**Goal:** the core lifecycle works end-to-end **before** the bot or AI complicate it.

**Deliverables:**
- 5.4 Manual delivery creation with rate-snapshot logic.
- 5.8 Delivery list (role-filtered) + detail.
- 5.9 Status updates and state machine, enforced by a Postgres function: `change_delivery_status(...)` (PRD 5.15). The function:
  - Validates the transition against an in-DB state machine table or check constraint
  - Writes to `delivery_status_history`
  - Updates `current_status`
  - Performs delivery-completion side effects (sets quantity_delivered/paid/payment_method)
  - Writes to `audit_log`
  - Accepts `client_uuid` and is idempotent on retry
  - All in one transaction with `security definer`
- `create_delivery(...)` Postgres function (PRD 5.15) doing the analogous job for creation — snapshotting rates, inserting history's initial row, writing audit_log.
- A small TypeScript module wrapping each Postgres function with typed args + return.
- Status state machine encoded **once** (in SQL) and read by the client to populate the "valid next status" modal — not re-encoded in TypeScript.

**Tech-debt traps to avoid:**
- ❌ Implementing the state machine in the React component. It will get out of sync with what the server allows the day a dispatcher uses a different version of the app.
- ❌ Multi-step writes from the client (insert history, then update delivery, then write audit). Race conditions and partial failures will haunt you. Always one function call, one transaction.
- ❌ Skipping `client_uuid` here because "we don't have offline yet." Adding idempotency later requires deleting accumulated duplicates first.
- ❌ Letting `customer_phone` be free-form everywhere without a single render-time normalizer. Tap-to-call breaks intermittently in production.
- ❌ Building the form in a way that doesn't reuse for bot-created-needs-review correction in Phase 6.

**Exit criteria:** Admin/dispatcher can create deliveries, assign manually, walk through every status path, and the data on the server is consistent. Status transitions invalid for the role are rejected by the database, not just hidden by the UI.

---

## Phase 4 — Stock model: adjustments, current_stock, completion side effect (week 5)  ✅

**Goal:** stock can never drift. Established here before agent app depends on "my stock" view.

**Deliverables:**
- 5.10 Stock adjustments with all 9 reasons.
- Transfer logic creating two paired rows linked by `related_adjustment_id`, written via a Postgres function so a half-written transfer is impossible.
- The `current_stock` view reads delivery completions **and** adjustments — make sure delivery-completion is already wired in via the `change_delivery_status` function from Phase 3.
- Admin stock view (all agents + warehouse) + agent's "my stock" placeholder (rendered from `current_stock`, filtered by RLS).
- Negative-stock allowed-but-visually-flagged rule baked into the view layer.
- Reactivation of an agent: profile restored but stock not auto-restored (verify in code, not just spec).
- Backfill of any stock manually held in the spreadsheet at cutover: design the import path now, even if it runs in Phase 7.

**Tech-debt traps to avoid:**
- ❌ A "current_stock" column added to `agent_profiles` "for performance". Then it drifts. Don't.
- ❌ Implementing transfer as two separate inserts from the client. Use a function. Atomic or nothing.
- ❌ Forgetting that delivery completion is also a stock movement and not testing that the view reflects both sources at once.
- ❌ Treating warehouse as a "special string" instead of a real user with a real ID. It must be a user row to participate in transfers cleanly.

**Exit criteria:** Move stock in every legal way (intake, transfer, loss, correction, delivery, cancellation-of-delivered). At every step, sum of all `current_stock` rows equals expected total. Audit log shows the whole chain.

---

## Phase 5 — Agent app: own deliveries, earnings, push notifications (week 6-7)  ✅

**Goal:** prove the agent role works as a standalone experience, and prove push works on real devices, before adding bot complexity.

**Deliverables:**
- Agent home: today's assigned deliveries, sorted per PRD 5.8.
- Delivery detail (agent variant): customer info, tap-to-call, tap-to-open-address, status change, payment recording.
- 5.13 Agent earnings view.
- 5.14 Push notifications:
  - Add `expo_push_token` column to `public.users` (new migration, do not abuse `notes`).
  - Permission request on first login.
  - Token registered + updated on each login (handle token rotation).
  - Edge Function `send_assignment_push(delivery_id)` invoked from `create_delivery` and from the auto-assign path. **Pushes go through one function so logging and rate limiting live in one place.**
  - Tap-to-open routes to the right delivery detail screen via deep link.
- Test on at least two real Android devices representative of agent phones (not just emulator).

**Tech-debt traps to avoid:**
- ❌ Storing the push token in `users.notes` (PRD calls this out — add a real column).
- ❌ Sending push notifications from the client. Always server-side so the audit and retry story is one place.
- ❌ Skipping deep link testing until the end. Deep links break silently in Expo prebuild changes.
- ❌ Hardcoding "today" filters using device time instead of a timezone-aware server-side filter. Lagos is +01:00 but agents traveling, devices wrong, etc. Pick `Africa/Lagos` as the canonical timezone and centralize.
- ❌ Showing margin on the agent detail screen "behind a role check" in JSX. Don't even fetch it — the query must not select margin columns when the user is an agent.

**Exit criteria:** An agent can do a full day in the app: receive push, open delivery, call customer, mark delivered with payment, see updated stock and earnings. Push works on real low-end Android. No margin ever reaches the agent client.

---

## Phase 6 — Auto-assignment, reconciliation, end-of-day rollover (week 8)

**Goal:** Uzo's daily admin loops close. Bot can land on top of this in Phase 7 without rework.

**Deliverables:**
- 5.7 Auto-assignment as a Postgres function `auto_assign_delivery(delivery_id)`. Called from `create_delivery` when `assigned_agent_id IS NULL`.
- Algorithm encoded server-side, audit-logged with the scoring factors so "why this agent?" is answerable.
- 5.12 Reconciliation views (per-client Remit, per-agent earnings) implemented as SQL RPCs (`client_remit_summary`, `client_remit_detail`, `agent_earnings_summary`) — **not** as client-side aggregations over fetched rows. Easier to verify, easier to expose to a future export. Daily-first range with chip presets (Today / Yesterday / Last 7 days / Custom); per-client drill-down + shareable plain-text report; Summary tab with Reda's own P&L. **All money fields are per-delivery, never per-unit** (`charged_snapshot`, `agent_payment_snapshot`, `customer_price` all flat per trip — quantity tracks stock, not money).
- 5.11 End-of-day rollover with `rollover_delivery(...)` Postgres function (atomic: new delivery row + parent reference + paired stock adjustments + status change on the original).
- Decide and add a `rolled_over` status (PRD flags it as pending). Lock the decision before Phase 7.

**Tech-debt traps to avoid:**
- ❌ Auto-assignment scoring in TypeScript on the client. Different app versions = different assignments.
- ❌ Reconciliation computed by fetching all deliveries and summing in JS. Will silently break at scale and won't paginate.
- ❌ Rollover as a multi-step client flow. One function, one transaction.
- ❌ Leaving the rollover status open as "tbd". The state machine has to know about it.

**Exit criteria:** A full week of synthetic data flowing through manual creation, status changes, rollovers, and reconciliation. Numbers in the reconciliation view match raw SQL `SUM`s. End-of-day produces a clean tomorrow.

---

## Phase 7 — Cutover & parallel run (week 8.5 — runs alongside Phase 8)

**Goal:** Reda's real operation starts using the app for the manual flow, while the spreadsheet still runs as a safety net. Bot/AI not yet enabled.

**Deliverables:**
- Production Supabase project provisioned, schema deployed from migrations.
- Production seed: real clients, products, locations, rate card, real users (Uzo, agents).
- Stock backfill from current spreadsheet state via the import path designed in Phase 4.
- Uzo trained on manual delivery creation in the app; bot keeps writing to the sheet **in parallel** so nothing is lost.
- A reconciliation step at end of each day comparing app totals to sheet totals. Discrepancies investigated daily.
- Rollback playbook written: if the app needs to be paused, what does Uzo do? (Answer: keep using sheet; we already are in parallel.)

**Tech-debt traps to avoid:**
- ❌ "Big bang" cutover that turns off the sheet on day one. If anything is wrong, you've lost a day of operations.
- ❌ Production debugging by editing rows in the Supabase UI. Every fix is a migration or a function call.
- ❌ No rollback plan written down. "We'll figure it out if it breaks" turns into a 6-hour outage on a bad day.

**Exit criteria:** One full week where app and sheet totals reconcile to zero or near-zero. Uzo confident enough that the sheet becomes read-only.

---

## Phase 8 — Bot ingestion + AI address normalization (week 9-10, behind feature flag)

**Goal:** automate ingestion only after the manual flow is proven. Bot writes go through the same `create_delivery` function the manual flow uses.

**Deliverables:**
- 5.5 Bot pipeline implemented as a Supabase Edge Function (or external service per existing bot architecture) that:
  - Consumes the parsing channel
  - Parses, matches client + product
  - Calls 5.6 AI address normalization pipeline (Maps → Gemini)
  - Logs every match to `address_match_log` with raw inputs and outputs
  - Calls `create_delivery` with `created_via = 'bot'` and `bot_raw_message`
- 5.6 Address normalization as a separate edge function `normalize_address(raw)` so it can be called from manual creation later too.
- Needs Review queue: a filtered view in the admin app for `location_id IS NULL` and parse errors.
- Idempotency on bot messages: hash of `raw_message + timestamp` stored to dedupe.
- Feature flag (`enable_bot_pipeline` in a `feature_flags` table or env var) controlling whether the bot writes. Default off in prod until verified.
- Confidence threshold values stored in a config table so they can be tuned without a deploy.

**Tech-debt traps to avoid:**
- ❌ Bot writing to delivery tables directly instead of through `create_delivery`. Two code paths to the same table guarantees drift in side effects.
- ❌ Hardcoding API keys for Maps/Gemini anywhere in the repo. Use Supabase secrets.
- ❌ Skipping the audit log for bot writes. The whole point of `address_match_log` is later analysis — design the schema for the queries you'll want to run (`group by confidence`, `where matched_location_id is null`, etc.).
- ❌ Prompt as a string literal scattered through the code. Single source of truth in one file, versioned. Log the prompt version with each AI call so a future regression can be traced to a prompt change.
- ❌ No fallback when Maps or Gemini is down. Needs Review queue must catch these or deliveries silently disappear.

**Exit criteria:** Bot ingests real forwarded messages from Uzo for a few days, in shadow mode (writes to a staging table, doesn't yet auto-create deliveries). Match accuracy reviewed by Uzo. Flag flipped on once accuracy + Needs-Review-rate are acceptable.

---

## Phase 9 — Online-with-resilience (week 11)

**Goal:** agents survive flaky networks. Built last because every earlier phase already added `client_uuid` and idempotent functions — so this phase is mostly client-side queue work, not server changes.

**Deliverables:**
- 5.16 Mutation queue with persistence (Expo SQLite or AsyncStorage-backed) and one queue implementation reused by status updates, payment recording, and stock adjustments (admin).
- Network-state-aware UI (online / saving / offline / sync error banners).
- Retry with backoff, dead-letter visibility ("some changes failed to sync — tap to review").
- Logout blocked when queue is non-empty (or forced flush first).
- Test scenarios: airplane mode mid-status-update, server-received-but-network-dropped, app killed before flush, two devices updating the same delivery.

**Tech-debt traps to avoid:**
- ❌ Building a separate queue for each mutation type. One queue, one drain loop.
- ❌ Forgetting that the server's `client_uuid` dedup is what makes retries safe. If any function added in earlier phases doesn't accept `client_uuid`, fix it now before adding the queue or you'll have duplicate writes.
- ❌ Showing "synced" to the user before the server confirmed. The optimistic state and the confirmed state must be distinguishable in state.
- ❌ Caching reads aggressively here and creating a stale-data problem the spec doesn't include. v1 is "online-with-resilience" — only mutations are queued; reads still require network.

**Exit criteria:** Agent in airplane mode for 10 minutes can mark 5 deliveries delivered, record payments, return online, and the server state is exactly what was intended with zero duplicates.

---

## Phase 10 — Polish, beta, ship v1 (week 12)

**Deliverables:**
- Performance pass: cold start < 3s on representative Android device; list virtualization for 100+ deliveries; image asset audit.
- Error handling pass: every screen has a defined empty state, loading state, and error state. No `undefined`-blanking.
- Accessibility pass per PRD §6: tap targets, contrast, status not relying on color alone, outdoor-readable.
- **Distribution wired (EAS + Play Internal Testing).** Android-only for v1; all staff use Android, Uzo on Samsung.
  - `eas.json` with `preview` and `production` profiles.
  - Register Google Play Developer account ($25 one-time).
  - First production build via `eas build --platform android --profile production` → upload to Play Console **Internal Testing** track.
  - Add all 16 internal staff emails as testers; share the Play install link.
  - Wire `eas update` for JS-only OTA patches (so future label/bug fixes don't require staff to reinstall).
  - Document the build + release command in the runbook.
- Beta with Uzo + one trusted agent in production for one week with bot pipeline behind flag; flip when ready.
- Sentry events flowing (turned on from silence).
- Internal docs: a one-pager for Uzo (how to do common admin tasks), a one-pager for agents (their day in the app), and a runbook for Paschal (how to deploy a migration, how to rotate Maps/Gemini keys, where to find logs, **how to ship a new build via EAS, how to push an OTA update**).
- v1 ship.

**Tech-debt traps to avoid:**
- ❌ Shipping without crash reporting actually wired. "We'll know if users complain" is not a strategy.
- ❌ Skipping the runbook. Six months later you won't remember which Supabase project is prod or how to push a migration safely.
- ❌ Treating beta as "we'll fix it after launch." Real beta means at least three days of clean operation before flipping flags or sunsetting the sheet.
- ❌ Sideloading APKs forever. The one-time $25 to get on Play Internal Testing buys you auto-updates, Play Protect, and a clean install link — pay it before launch, not after the third "the new APK won't install" Slack message.
- ❌ Putting `GEMINI_API_KEY` / `WASENDER_*` / Maps keys anywhere in the mobile bundle. Phone-side `.env` is the bundle — only `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` belong there. Everything else is Edge Function secrets.

---

## Cross-cutting tech-debt watch list

Throughout the build, these errors compound silently. Periodically audit for them.

| Trap | Detector | Fix |
|---|---|---|
| Business logic creeping into the client | Grep for math operations on money / stock fields in `.tsx` | Move to Postgres function or view |
| Duplicate components/hooks for the same job | "Why do we have two date pickers?" | Consolidate; document the chosen one in CLAUDE.md / README |
| RLS holes via new tables | New table merged without RLS in same PR | Make CI fail if a `create table` migration lacks a paired `enable row level security` |
| Untyped Supabase queries | `any` in query result types | Regenerate types; fix all the new errors |
| Schema drift between dev and prod | `supabase db diff` non-empty against migrations | Always migrate, never hand-edit |
| Audit log gaps | Function exists without `audit_log` insert | Code review checklist item |
| Push tokens leaking into logs | Sentry breadcrumb contains a token | Scrub before send, configured in Phase 5 |
| Feature flags becoming permanent | Flag older than 30 days post-rollout | Calendar reminder to remove + clean up code |
| `notes` fields becoming junk drawers | Free-form text used for structured data | When a structure emerges, migrate to columns; don't keep stuffing |

---

## Phase summary (one-line each)

| Phase | Status | Focus | Risk if skipped/rushed |
|---|---|---|---|
| 0 | ✅ | Schema, RLS, types, CI, two environments | Every later phase pays |
| 1 | ✅ | Auth + permission spine | Sensitive data leaks |
| 2 | ✅ | Catalog + soft-delete + rate versioning | Historical reconciliation breaks |
| 3 | ✅ | Manual delivery + state machine in DB | Two implementations of business rules |
| 4 | ✅ | Stock model that can't drift | Reconciliation hell |
| 5 | ✅ | Agent app + push on real devices | Late discovery of device issues |
| 6 | ✅ | Auto-assign + reconcile + EOD | Admin daily loops not yet closed |
| 7 | 🟡 | Cutover seed done · parallel-run pending | Operational risk on go-live |
| 8 | ✅ code-complete | Bot + AI behind a flag | AI errors create silent data loss |
| 9 | ✅ code-complete | Offline resilience (persistent queue + retry + dead-letter) | Field agents lose work |
| 10 | 🟡 | Dev work done · beta + ship pending | Quality regressions reach users |

---

## What's deliberately NOT in this plan

- Anything in PRD §9 (out of scope for v1). No partial implementation "to save time later" — partial features are the highest-debt form of code.
- Web admin or dashboard. Stays out until v2.
- Multi-tenancy / multi-Reda. Schema doesn't preclude it but no feature acknowledges it.
- An ORM layer on top of Supabase. Direct `supabase-js` queries + generated types are sufficient and easier to debug.
- A custom backend service. Edge Functions cover the bot and AI paths; everything else is Postgres.

---

*This plan is a living document. Revisit at the end of each phase: what assumptions held, what didn't, what debt got created anyway, what we need to repay before moving on.*
