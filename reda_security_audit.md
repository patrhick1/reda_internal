# Reda — Security Audit (2026-06-12)

**Scope:** Live Supabase Postgres (RLS, grants, policies, views, SECURITY DEFINER
functions — verified against the production DB via `psql`), all Edge Functions
(`supabase/functions/*`), the WhatsApp bot intake chain, and the Expo/React Native
mobile client (incl. the Vercel web build). Docs (PRD §6, system design §2/§14)
used as the intended-posture spec.

**Method:** Ground truth is the live DB and source, not the docs. Every DB claim
below was confirmed by running probes as the `anon` / `authenticated` roles.

**Threat model:** The Supabase **anon key ships inside the public app bundle**
(APK + Vercel web JS), so it is effectively public. "Anon" below = *anyone on the
internet*, no login. "Authenticated agent" = a real but low-privilege account.

---

## Overall posture

**Solid foundations (verified):**
- RLS is **enabled on every `public` table** (0 tables with RLS off).
- Agent isolation holds: `deliveries` SELECT is row-scoped
  (`is_admin_or_dispatcher() OR assigned_agent_id = auth.uid()`); UPDATE/DELETE are
  `is_manager()`/`is_admin()`. An agent cannot read or edit another agent's rows.
- Direct base-table writes on `deliveries` + `delivery_status_history` are revoked
  from anon/authenticated (the earlier lockdown holds) — writes go through gated RPCs.
- The `deliveries_admin` / `deliveries_safe` / `available_orders_safe` views, although
  they run as owner, **bake the auth predicate into their `WHERE`** — anon gets 0 rows.
- 96 / 103 SECURITY DEFINER functions pin `search_path`.
- Mobile bundle has **no hardcoded service-role or third-party secrets** (only the
  expected `EXPO_PUBLIC_` anon key). Sign-out releases the push token; offline queue
  is per-user keyed.
- Vendor/client names are correctly hidden from agents (RLS on `clients`, and the
  agent views omit client name).

The gaps are concentrated in **(a) the pre-auth anon surface** and **(b) edge
functions that don't authenticate** (a known consequence of `--no-verify-jwt`).

---

## Findings (ranked)

### 🔴 CRITICAL

#### C-1. `public.users` is readable by anyone with the anon key
- **Evidence (live):** policy `users_select_all = USING (true)` to `{public}` + `SELECT`
  granted to `anon`. Probe as `anon`: **33 rows**, all 33 with `email`, 3 with
  `expo_push_token`, 2 admins — full read.
- **Exposed columns:** `id, email, phone, display_name, role, is_active,
  deactivated_at, notes, expo_push_token, agent_payment_bonus, parent_agent_id,
  warehouse_id`.
- **Impact:** Anyone on the internet (the anon key is in the shipped app) can dump the
  **entire staff/agent roster** — names, emails, roles, who's admin, team structure
  (`parent_agent_id`), pay bonuses (`agent_payment_bonus`), and **Expo push tokens**.
  Emails → targeted phishing/credential-stuffing of ops staff. Push tokens → an
  attacker can send push notifications directly via Expo's public push API
  (compounds C-2).
- **Fix:** Replace the blanket policy with a scoped one. Realistic shape:
  ```sql
  drop policy users_select_all on public.users;
  -- everyone authenticated may read the minimal directory the app needs
  create policy users_select_directory on public.users
    for select to authenticated
    using (true);   -- if the app genuinely needs the roster post-login
  -- ...but stop column leakage by exposing a VIEW with only id/display_name/role/
  --    is_active and pointing the app at it; keep email/phone/push_token/bonus
  --    readable only to is_admin_or_dispatcher() (or self).
  ```
  Minimum viable fix: (1) **revoke SELECT on `users` from `anon`** so a login is
  required; (2) move `email`, `phone`, `expo_push_token`, `agent_payment_bonus`,
  `notes` behind `is_admin_or_dispatcher() OR id = auth.uid()` (column-split via a
  `users_public` view the app reads for the roster). Confirm what the app actually
  needs first (it joins `users` for `display_name/role` in stock + reconcile screens).

#### C-2. `send-notification` edge function has no authentication
- **Evidence:** `supabase/functions/send-notification/index.ts` — no JWT/secret check;
  accepts any POST and resolves `audience` from the body. Deployed `--no-verify-jwt`,
  so it's internet-reachable at `/functions/v1/send-notification`.
- **Impact:** Anyone can broadcast arbitrary push notifications to **all admins**
  (`{audience:'admins'}`), all admins+dispatchers, a **specific user** by id, or any
  delivery's assigned agent / warehouse staff. Notification spam, social-engineering
  ("sign out now"), operational disruption. With C-1 leaking push tokens, also
  directly targetable.
- **Fix:** Require a caller identity and authorize the audience:
  - For app-originated calls: verify the Bearer JWT (`supabase.auth.getUser`) and
    enforce that only admins may target `admins*`, an agent may only target their own
    delivery, etc.
  - For trigger/internal callers: require a shared `X-Internal-Secret` header (same
    pattern the webhooks already use) and call it only from DB triggers/other functions.

### 🟠 HIGH

#### H-1. `recent_edge_function_failures` view leaks internal HTTP responses to anon
- **Evidence:** view selects `substring(content,1,200)` from `net._http_response` where
  `status_code >= 400`, **no auth predicate**, granted to anon. Probe as `anon`: **44 rows**.
- **Impact:** Anyone can read recent edge-function failure bodies — may contain payload
  fragments, upstream provider errors (OpenRouter/Maps/Expo), IDs, partial PII.
- **Fix:** Add `security_invoker=on` won't help (base table is `net`); instead gate the
  view body with `WHERE is_admin_or_dispatcher()` (like the deliveries views) and
  `revoke select ... from anon`.

#### H-2. Unauthenticated parsing / address / enumeration functions
- **Evidence:** `bot-parse-message`, `mybot-parse-message`, `normalize-address`,
  `enumerate-corridor-aliases` — none authenticate the caller; all reachable via
  `--no-verify-jwt`. `normalize-address` also trusts a caller-supplied `delivery_id`
  and writes it into `address_match_log`.
- **Impact:**
  - **Cost attack / billing abuse:** each call fans out to OpenRouter + Google Maps;
    an attacker can run up the bill at will.
  - **Audit-log poisoning:** `normalize-address` lets an attacker attach fabricated
    address matches to *any* `delivery_id`.
  - `bot-parse-message` direct-invocation can re-process queued inbound rows (delivery
    creation is gated behind the `enable_bot_pipeline` flag + shadow mode, which
    limits but doesn't eliminate this).
- **Fix:** Require the internal shared-secret header on all four (they're only ever
  called by webhooks/triggers/other functions, never by end users). Validate
  `delivery_id` ownership/existence in `normalize-address` before logging.

#### H-3. `send-assignment-push` unauthenticated
- **Evidence:** no auth check; accepts `delivery_id` and pushes to the assigned agent.
- **Impact:** Targeted push spam to agents. Lower blast radius than C-2 but same class.
- **Fix:** Internal shared-secret header (trigger-only).

### 🟡 MEDIUM

#### M-1. Session tokens stored in unencrypted `AsyncStorage`
- **Evidence:** `mobile/src/lib/supabase.ts` — `auth.storage: AsyncStorage`.
- **Impact:** On a rooted/jailbroken or backed-up device, the refresh token can be
  lifted and replayed to impersonate the user until expiry/revocation. Matters more
  here because actions are financial (mark-delivered, cash amounts).
- **Fix:** Use `expo-secure-store` (Keychain/Keystore) as the Supabase auth storage
  adapter.

#### M-2. Deactivated user's offline queue can still drain
- **Evidence:** `mobile/src/queue/QueueProvider.tsx` — drain guards on
  `enqueuedByUserId === owner`, not on `is_active`. Comment confirms deactivated users
  "keep ownership of their unsynced work."
- **Impact:** An agent deactivated by admin can still flush queued mutations (e.g.
  mark-delivered) on reconnect. **Server RPCs do re-check `is_manager()` etc.**, so the
  damage is bounded to actions the *role* still allows — but deactivation isn't honored
  for queued work.
- **Fix:** On boot / auth refresh, if `account.kind` is deactivated, clear the queue;
  and/or have the RPCs reject when the caller's `users.is_active = false`.

#### M-3. `tg_notify_*` SECURITY DEFINER triggers don't pin `search_path`
- **Evidence:** 7 functions (`tg_notify_assignment_push`, `tg_notify_bot_error`,
  `tg_notify_bot_review`, `tg_notify_delivery_status_change`, `tg_notify_negative_stock`,
  `tg_notify_pickup_needed`, `tg_notify_warehouse_pickup`) are `prosecdef` with no
  `search_path` in `proconfig`.
- **Impact:** Definer functions with a mutable `search_path` are a privilege-escalation
  vector if an attacker can influence `search_path` at execution time. Exploitability
  here is low (they fire from triggers on RLS-gated writes), but it's an easy hardening.
- **Fix:** `alter function ... set search_path = public, net, pg_temp;` on each.

#### M-4. Webhook intake secrets are the single barrier — assume contractor exposure
- **Evidence:** `wasender-webhook` / `inbound-message` / `evolution-webhook` correctly
  verify a shared secret (timing-safe). But the whole delivery-creation chain hinges on
  those secrets, which are shared with the external contractor.
- **Impact:** If `WASENDER_WEBHOOK_SECRET` / `BOT_INBOUND_SECRET` leak, an attacker can
  inject fake orders end-to-end.
- **Fix:** Rotate both secrets now (contractor changed recently); add IP allowlisting
  if the provider has stable egress IPs; alert on bursts of 401s.

#### M-5. Weak password policy for admin-created users
- **Evidence:** `mobile/app/(admin)/catalog/users/new.tsx` — only `length >= 8`, no
  complexity; Supabase Auth default min is also low.
- **Impact:** Weak initial credentials for ops/agent accounts.
- **Fix:** Enforce complexity (or generate a strong random password and display once);
  raise Supabase Auth's minimum.

### 🟢 LOW / hardening

- **L-1. Anon-readable reference + roster-adjacent tables:** `agent_profiles` (21 rows:
  `delivery_capacity`, `notes`), `agent_location_preferences`, `locations` (63),
  `product_catalog` (128, incl. `client_id` → vendor↔product mapping). Mostly low
  sensitivity, but tighten to `authenticated` at least (revoke anon SELECT) so business
  data isn't enumerable pre-login. `product_catalog.client_id` is the most sensitive
  (anti-poaching adjacency).
- **L-2. Broad write GRANTs to anon/authenticated on most tables** (INSERT/UPDATE/DELETE
  granted; only RLS `WITH CHECK` stops them). RLS currently holds, but this is
  defense-in-depth debt — a single mis-scoped future policy = a write hole. Consider
  `REVOKE`ing writes broadly and granting per-table only where a direct-write policy
  truly exists (`stock_adjustments` warehouse-self, `push_tokens`, etc.).
- **L-3. `stock_adjustments` direct-insert policy** (`stock_adj_insert_warehouse_self`)
  lets a warehouse user insert ledger rows directly, bypassing `create_stock_adjustment`'s
  reason/quantity validation. Constrained to their own books + role, so low — but prefer
  funneling through the RPC.
- **L-4. Web build route structure** is visible in URLs; the `AuthGate` redirect is the
  guard and RLS is the real gate, so this is informational. Keep route guards tested on web.
- **L-5. Sentry currently disabled** (console-only). If re-enabled, expand the PII scrub
  list (`email`, `raw_address`, `address`, `name`) before shipping.

### Reconciled / NOT findings (checked, dismissed)
- Agent reading `customer_phone` / `raw_address` for **their own** assigned deliveries
  (`deliveries_safe`, `findSimilarOpenDeliveries`) is **by design** — they must contact
  and locate the customer. RLS scopes it to their rows; no client/vendor name is exposed.
- `deliveries_admin/safe/available_orders_safe` running as owner is **safe** — the auth
  predicate is in the view `WHERE` (anon = 0 rows, confirmed).
- No hardcoded secrets in the mobile bundle (confirmed).

---

## Remediation plan

**P0 — this week (close the internet-facing holes):**
1. **C-1:** revoke `anon` SELECT on `users`; column-split email/phone/push_token/bonus
   behind admin-or-self; point the app's roster reads at a minimal `users_public` view.
2. **C-2:** add auth to `send-notification` (JWT + audience authorization, or internal
   secret for trigger calls).
3. **H-1:** gate `recent_edge_function_failures` to `is_admin_or_dispatcher()`, revoke anon.
4. **M-4:** rotate `WASENDER_WEBHOOK_SECRET` + `BOT_INBOUND_SECRET`.

**P1 — next (auth the internal functions, harden client):**
5. **H-2 / H-3:** require an internal shared-secret header on `bot-parse-message`,
   `mybot-parse-message`, `normalize-address`, `enumerate-corridor-aliases`,
   `send-assignment-push`; validate `delivery_id` in `normalize-address`.
6. **M-1:** move token storage to `expo-secure-store`.
7. **M-2:** clear the offline queue on deactivation (and/or `is_active` check in RPCs).
8. **L-1:** revoke anon SELECT on `agent_profiles`, `agent_location_preferences`,
   `locations`, `product_catalog` (require login).

**P2 — hardening:**
9. **M-3:** pin `search_path` on the 7 `tg_notify_*` functions.
10. **M-5:** password complexity / generated passwords.
11. **L-2:** trim base-table write GRANTs to match actual direct-write policies.
12. Add a `SECURITY.md` documenting which functions are public vs internal, and add a
    cron/CI probe that fails if `anon` can read `users` or any function answers 200
    without auth.

## How to verify each fix
- **C-1 / H-1 / L-1:** `set local role anon; select count(*) from public.<t>;` → expect
  `0` (or permission denied) after the change. Re-run the P0 probes in this audit.
- **C-2 / H-2 / H-3:** `curl -XPOST https://<proj>.supabase.co/functions/v1/<fn>` with no
  auth → expect `401`. With a non-admin JWT to `send-notification {audience:'admins'}` →
  expect `403`.
- **M-1:** kill+reopen app, confirm session persists from SecureStore; inspect that
  AsyncStorage no longer holds the refresh token.
- **M-2:** deactivate a test agent with a queued job offline → reconnect → job is dropped.
- **M-3:** `select proname, proconfig from pg_proc where proname like 'tg_notify_%';` →
  each shows `search_path=...`.

All P0/P1 DB changes follow the usual workflow (SQL pasted into the Supabase editor,
smoke-tested as anon/authenticated in a `BEGIN…ROLLBACK`).
