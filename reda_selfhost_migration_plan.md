# Reda — Self-Hosted Supabase on Hetzner: Migration Plan

**Goal:** move the Reda backend off Supabase Cloud (free tier) onto a self-hosted
Supabase stack running on a Hetzner VPS, with **zero application rewrite**. Both clients —
the **mobile app** (Expo native) and the **web app** (Expo-web export deployed on **Vercel**,
how Uzo reaches Reda from any laptop) — keep using `@supabase/supabase-js`; we only repoint
their URL + anon key. The web frontend **stays on Vercel** (publicly reachable from anywhere);
only its backend env changes to the self-host API, which is itself public over HTTPS
(`reda-api.waitwithselah.com`), so "available from anywhere" is preserved. See §6 + §10.3.

**Why this is low-risk:** Supabase is open-source and ships as a Docker Compose stack.
Every piece Reda uses (Postgres, Auth/GoTrue, Realtime, PostgREST, the API gateway, the
Deno Edge Runtime) runs as a container. Reda's entire business logic lives in **portable
Postgres** (~60 RPCs, triggers, RLS, views) — a `pg_dump`/restore moves it verbatim.

> **Update (2026-06-05): we are co-hosting on an existing box, not provisioning a fresh one.**
> The Hetzner VPS that already runs the Reda WhatsApp bot (Evolution API) has the headroom to
> host Supabase alongside it. The sections below were written for a clean CX22; the
> "Current state" section that follows records what's actually there, and §1/§4 are amended for
> the co-host path. Everything else (DB migration, edge functions, auth cutover) is unchanged.

> **Update (2026-07-03): the Evolution API relay is being RETIRED — it was never the live intake.**
> A production-readiness audit + Cloud data settled a long-standing ambiguity. The box's Evolution
> "mybot" relay has fed **0 rows ever** into `mybot_inbound_messages`, its container has not logged
> since **2026-06-07**, yet **100% of live intake flows through the contractor's own bot**
> (WASender → `wasender-webhook` → `bot_inbound_messages`: 2,237 rows, 219 in the last 24 h,
> last msg today). **Reda does not run its own WhatsApp number.** So the §4/§8 claim that the
> `WEBHOOK_GLOBAL_URL` env line "*is* the cutover for intake" is **wrong for the current
> architecture** — at cutover the intake repoint is wherever the **contractor's WASender bot** posts
> (Cloud `wasender-webhook`/`inbound-message`), not Evolution.
> **Action — decommission the `evolution` + `postgres` services in `/root/evolution/docker-compose.yml`,
> KEEP `caddy`.** The Caddy container is the shared TLS edge for `redalogisticss.com` → Supabase Kong
> + the `auth-email` hook and has **no `depends_on`** the relay (verified), so it survives untouched.
> Frees ~2.2 GB (evolution image 1.37 GB + its Postgres 392 MB + a 435 MB unrotated log). Also delete
> the stale upstream clone `/root/supabase-src` (~1.4 GB — not bind-mounted by any compose; the
> running stack is `/root/supabase`). **Before removing:** repoint the UptimeRobot monitor off
> `evo.waitwithselah.com` (§10.4) to a `redalogisticss.com` health path, and drop the dead
> `evo.waitwithselah.com` block from the Caddyfile. See the production-readiness audit in §12.

---

## Current state: the target box (co-host on the WhatsApp-bot VPS)

**Inventory (read-only inspection, 2026-06-05):**

- **Host:** `whatsapp-bot`, Hetzner, `178.104.73.186`. CX22-class: **2 vCPU / 3.7 GiB RAM / 38 GB disk** (32 GB free). **Swap: 0 B** ⚠️.
- **Domain in use:** `waitwithselah.com`. Evolution is served at `evo.waitwithselah.com`.
- **Already running** (one compose project at `/root/evolution/`, network `evolution_evo-net`):

  | Container | Image | RAM | Host port | Notes |
  |---|---|---|---|---|
  | `evolution-evolution-1` | `atendai/evolution-api` | ~117 MiB | — (8080 internal) | the WhatsApp relay ("mybot") |
  | `evolution-postgres-1` | `postgres:15-alpine` | ~47 MiB | — (5432 **internal only**) | Evolution's own DB (`evolution`) |
  | `evolution-caddy-1` | `caddy:2-alpine` | ~13 MiB | **80, 443** | owns the public TLS edge |
  | **Total** | | **~176 MiB** | | **~3.0 GiB RAM free**, 32 GB disk free |

- **The Reda intake hinges on one env var** in `/root/evolution/docker-compose.yml`:
  `WEBHOOK_GLOBAL_URL=https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/evolution-webhook`.
  Evolution POSTs every inbound WhatsApp message there. Today it points at **Cloud**; at cutover
  this single line repoints to the local stack (§4/§8). That env line *is* the cutover for intake.
- **Caddyfile** (`/root/evolution/Caddyfile`) is a single block: `evo.waitwithselah.com → evolution:8080`.

**Does Supabase fit alongside Evolution?** Yes. The trimmed fleet (storage/imgproxy/analytics
dropped — §2) runs ~0.8–1.3 GiB steady-state; Evolution uses <200 MiB; the box has ~3.0 GiB free.
The genuine risk is a **transient memory spike** (Realtime under load, or the `pg_restore`) on a box
with **no swap** — an OOM event could kill an *Evolution* container too. **Mitigation: add a 2–4 GB
swapfile before bringing the stack up** (the box has 32 GB free disk; this is free insurance and
touches nothing running):

```bash
fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab     # persist across reboot
sysctl -w vm.swappiness=10                            # prefer RAM; swap only under pressure
```

**Proposed Supabase API hostname:** `reda-api.waitwithselah.com` → A record to `178.104.73.186`
(used as `API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL` and in the new Caddy block, §4).

**Co-host guardrails (so Evolution is never disturbed):**
- Supabase goes in its **own directory + compose project** (`/root/supabase/`), its **own network** —
  bringing it up never recreates or restarts anything under `/root/evolution/`.
- Supabase **must not publish** `80`/`443`/`5432` on the host. Kong stays internal (reached through the
  existing Caddy, §4); Postgres binds `127.0.0.1` only. No collision with Evolution's Caddy (80/443) or
  its internal Postgres.
- The existing Caddy is **reused**, not duplicated. Attach a shared docker network to the *running*
  `evolution-caddy-1` with `docker network connect` (zero downtime, no recreate) and add it to the
  compose file for persistence; then add the `reda-api` site block (§4).

---

## 0. What we are moving (inventory)

| Component | Used by Reda? | Self-host path |
|---|---|---|
| **Postgres** (RPCs, triggers, RLS, views, state machine) | ✅ core | `supabase/postgres` container; dump/restore |
| `pg_cron` extension (watchdogs, ringing expiry) | ✅ | bundled in the Postgres image |
| `pg_net` / `net.http` (triggers → Edge Functions) | ✅ | bundled |
| **Auth (GoTrue)** | ✅ login, reset, JWT | `supabase/gotrue` container + `auth.users` migration |
| **Realtime** | ✅ calls + list updates | `supabase/realtime` container |
| **PostgREST + Kong gateway** | ✅ (the REST/RPC surface) | `postgrest` + `kong` containers |
| **Edge Functions** (11 Deno fns) | ✅ | `supabase/edge-runtime` container |
| **Scheduled Edge Functions** (hosted nightly EOD) | ✅ | ⚠️ **no self-host equivalent** — replace with `pg_cron`+`net.http` |
| **Storage** | ❌ unused (no buckets, no uploads) | skip the container entirely |
| Push (Expo Push API) | external | unaffected |
| Voice audio (Agora SD-RTN) | external, P2P | unaffected |

The only feature gap is **Scheduled Edge Functions** (§5). Everything else is a lift-and-shift.

---

## 1. Provision the Hetzner box

> **Co-host note (2026-06-05):** this step is **already done** — we're reusing the existing
> `whatsapp-bot` box (CX22-class, see "Current state" above), not provisioning a new one. The
> box is already hardened, firewalled behind Caddy, and running Docker. The only box-level prep
> still needed is the **swapfile** (see "Current state") before standing up the stack. The sizing
> guidance below is retained for context / a future dedicated box.

**Sizing.** At ~100 deliveries/day the working set is tiny; the constraint is RAM for the
container fleet (Postgres + GoTrue + Realtime + PostgREST + Kong + edge-runtime + Studio).

- **Recommended:** CX22 (2 vCPU / 4 GB / 40 GB NVMe, ~€4.5/mo) — comfortable headroom. *(The current box is this class; co-hosting Evolution + trimmed Supabase fits with ~3 GiB free, given swap.)*
- **Floor:** CX11/CAX11 (2 GB) works but leaves little slack for Studio + Realtime; not advised for production.
- Add a **Hetzner Volume** (10–20 GB) mounted for the Postgres data dir + backups, so you can resize/snapshot independently of the OS disk. *(Not yet present on the current box — its 32 GB free OS disk is enough for v1; revisit if data or backups grow.)*

**OS & base hardening (Ubuntu 24.04 LTS):** *(already applied on the current box; kept for reference / a fresh box.)*
```bash
# as root on the fresh box
adduser reda && usermod -aG sudo reda
# SSH: key-only, no root login, no password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
# firewall: only SSH + HTTPS reach the world; everything else is internal to docker
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 443/tcp && ufw allow 80/tcp
ufw enable
# docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker reda
```

> **Critical:** the default Supabase compose exposes Postgres on `5432` and Studio on
> `3000`/`8000`. **Do not** open those in `ufw`. Postgres stays bound to the Docker network
> (or `127.0.0.1`); Studio is reached only via SSH tunnel. The single public door is the
> API gateway behind TLS (§4).

---

## 2. Stand up the self-hosted Supabase stack

```bash
sudo -iu reda
git clone --depth 1 https://github.com/supabase/supabase
cp -r supabase/docker ~/reda-backend && cd ~/reda-backend
cp .env.example .env
```

**Generate fresh secrets** into `.env` (do **not** reuse the example values):

- `POSTGRES_PASSWORD` — strong random.
- `JWT_SECRET` — 40+ char random. **This is the pivot of the whole migration** (see §6).
- `ANON_KEY` and `SERVICE_ROLE_KEY` — JWTs signed with the new `JWT_SECRET`. Mint them with the project's JWT generator (Supabase docs → Self-Hosting → "Generate API keys") or any HS256 signer using the standard `role: anon` / `role: service_role` payloads.
- `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` — Studio basic-auth.
- `SITE_URL` — your app's deep-link base; `API_EXTERNAL_URL` / `SUPABASE_PUBLIC_URL` — `https://api.reda.<yourdomain>`.
- SMTP block (`SMTP_HOST/PORT/USER/PASS/SENDER`) — **required** for GoTrue password-reset emails. Cloud gave you a built-in sender; self-hosted does not. Use a transactional provider (Resend / SES / Postmark / Brevo). Without this, "forgot password" silently fails.

**Trim the stack:** since Storage is unused, you can drop the `storage` and `imgproxy`
services from `docker-compose.yml` (and the `storage` route from Kong) to save RAM. Keep
`db`, `auth`, `rest`, `realtime`, `kong`, `functions` (edge-runtime), `studio`, `meta`,
`vector`/`analytics` (optional — drop to save more RAM).

```bash
docker compose up -d
docker compose ps        # all healthy?
```

---

## 3. Migrate the database (the heavy, safe part)

**3a. Dump from Cloud.** Use the Cloud project's connection string (Dashboard → Settings → Database):

```bash
# roles + schema + data, but EXCLUDE Supabase-managed internal schemas you don't own
pg_dump "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres" \
  --no-owner --no-privileges \
  --schema=public \
  -Fc -f reda_public.dump

# auth.users separately — we need the identities to carry over (see §6)
pg_dump "postgresql://...supabase.co:5432/postgres" \
  --data-only --schema=auth -Fc -f reda_auth.dump
```

> Don't try to move the entire `supabase_*`/`storage`/`realtime` internal schemas — the
> self-hosted images create their own. Move **`public`** (all your tables/RPCs/triggers/views/RLS)
> and the **`auth.users`/`auth.identities`** data only.

**3b. Confirm extensions exist on the target** before restore. Connect to the self-hosted DB
(via SSH tunnel, §7) and:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pg_trgm;     -- used by the typo-drift sibling matcher
create extension if not exists "uuid-ossp"; -- if any RPC calls uuid_generate_*
```

**3c. Restore:**
```bash
pg_restore --no-owner --no-privileges -d "$SELFHOST_DB_URL" reda_public.dump
pg_restore --no-owner --no-privileges --data-only -d "$SELFHOST_DB_URL" reda_auth.dump
```

**3d. Recreate the system user.** The nightly EOD signs in as `system@reda.local`
(role=admin). Re-run [scripts/system-user-setup.sql](scripts/system-user-setup.sql) (or
re-create that auth user) so its credentials match the new `SYSTEM_USER_EMAIL/PASSWORD`
secrets you'll set in §5.

**3e. Verify RLS + RPCs.** Spot-check the security model survived:
```sql
-- policies present?
select schemaname, tablename, policyname from pg_policies where schemaname='public' order by 1,2;
-- the brain is present?
select proname from pg_proc where pronamespace='public'::regnamespace
  and proname in ('create_delivery','bot_create_delivery','change_delivery_status',
                  'run_eod_rollover','run_eod_rollover_all_stuck','bulk_assign_deliveries',
                  'effective_rate','current_stock');
```

---

## 4. Public entry, TLS, and the WhatsApp webhooks

Reda has **inbound** traffic from outside that must reach Edge Functions:
`evolution-webhook`, `wasender-webhook`, `inbound-message` (the WhatsApp relays POST to
these). So the box needs a real domain + HTTPS terminating in front of Kong.

> **Co-host path (2026-06-05): reuse the existing Caddy — do not run a second one.**
> `evolution-caddy-1` already owns 80/443 and auto-issues Let's Encrypt certs. We add a site
> block to `/root/evolution/Caddyfile` and give that Caddy a route to Supabase's Kong over a
> shared docker network.

- Point **`reda-api.waitwithselah.com`** (A record) at `178.104.73.186`.
- Attach a shared network so the existing Caddy can resolve `kong` by name, then add the block:
  ```bash
  # zero-downtime: connect the shared net to the *running* caddy + kong, then reload Caddy
  docker network create reda-edge 2>/dev/null || true
  docker network connect reda-edge evolution-caddy-1
  docker network connect reda-edge supabase-kong          # (also declare reda-edge in both compose files for persistence)
  ```
  ```
  # appended to /root/evolution/Caddyfile (existing evo.waitwithselah.com block stays)
  reda-api.waitwithselah.com {
      reverse_proxy kong:8000          # Kong, reached over the shared reda-edge network
  }
  ```
  Caddy hot-reloads the new block; the existing `evo.waitwithselah.com` route is unaffected.
- **The actual webhook repoint** is one env line in `/root/evolution/docker-compose.yml`
  (this is a **cutover** action, §8 — not done during the parallel build):
  ```
  # from:
  WEBHOOK_GLOBAL_URL=https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/evolution-webhook
  # to (local stack):
  WEBHOOK_GLOBAL_URL=https://reda-api.waitwithselah.com/functions/v1/evolution-webhook
  #   (or, fully internal, http://kong:8000/functions/v1/evolution-webhook over reda-edge)
  ```
  then `docker compose up -d evolution` to restart only the relay. *(Evolution's WhatsApp link is
  an outbound Baileys socket, so this restart does not drop the WhatsApp session beyond a brief
  reconnect.)* The `wasender-webhook` / `inbound-message` functions exist in the codebase but are
  **not currently wired** on this box (only `WEBHOOK_GLOBAL_URL` → `evolution-webhook` is active);
  repoint them too only if/when they're in use.
- Keep the shared-secret env values (`EVOLUTION_WEBHOOK_SECRET`, `WASENDER_WEBHOOK_SECRET`,
  `BOT_INBOUND_SECRET`) identical so signature checks keep passing — or rotate them on both
  ends together.

---

## 5. Edge Functions + replacing Scheduled Edge Functions

**5a. Deploy the functions.** In self-host, the `functions` (edge-runtime) container serves
everything under `./volumes/functions/`. Copy each function from
[supabase/functions/](supabase/functions/) into that directory. They run unchanged (same
Deno, same `Deno.env.get`).

**5b. Set every secret** the functions read (collected from the code):

```
SUPABASE_URL=https://api.reda.<domain>
SUPABASE_ANON_KEY=<new anon>
SUPABASE_SERVICE_ROLE_KEY=<new service_role>
SYSTEM_USER_EMAIL=system@reda.local
SYSTEM_USER_PASSWORD=<the system user's password>
OPENROUTER_API_KEY=...          # gpt-4.1-mini extraction + gemini address pick
GOOGLE_MAPS_API_KEY=...         # geocode step
GEMINI_API_KEY=...              # (legacy/direct path; keep if still referenced)
AGORA_APP_ID=...                # public
AGORA_APP_CERT=...              # SERVER-SIDE ONLY — never ships to the app
EVOLUTION_WEBHOOK_SECRET=...
WASENDER_WEBHOOK_SECRET=...
BOT_INBOUND_SECRET=...
REDA_GROUP_JID=...              # the single parsing channel JID
```
On self-host these go in the edge-runtime service's env (compose `environment:` or an env
file mounted to the container) — there's no `supabase secrets set` against Cloud anymore.

> **Note on the `--no-verify-jwt` habit:** your deploy memory (every `functions deploy`
> needs `--no-verify-jwt` so internal `functions.invoke` calls don't 401) is a *Cloud CLI*
> concern. Self-hosted, JWT verification per-function is controlled by the edge-runtime
> config / per-function `verify_jwt` setting and the Kong route. Make sure the
> trigger-invoked functions (`send-notification`, `send-assignment-push`) and the webhook
> functions are reachable **without** a user JWT — they authenticate via service-role or
> their own shared secret, exactly as today.

**5c. Replace the nightly EOD (the one true feature gap).**
Cloud "Scheduled Edge Functions" don't exist self-hosted. You already use `pg_cron` + `pg_net`
elsewhere, so reuse that pattern — have Postgres call the function over HTTP on schedule:

```sql
-- run the EOD check on the SAME schedule production uses today.
-- (Rollover is designed to fire 23:59 Africa/Lagos — schedule in UTC accordingly,
--  e.g. 22:59 UTC. Confirm against the current production cron before cutover.)
select cron.schedule(
  'nightly-eod-check',
  '59 22 * * *',                       -- 23:59 Lagos == 22:59 UTC (no DST in Nigeria)
  $$
  select net.http_post(
    url     := 'https://api.reda.<domain>/functions/v1/scheduled-eod-check',
    headers := jsonb_build_object(
                 'Content-Type','application/json',
                 'Authorization','Bearer ' || current_setting('app.service_role_key', true))
  );
  $$
);
```
Alternative if you'd rather not put the key in a GUC: a root **system crontab** entry that
`curl`s the function URL with the service-role bearer. Either works; `pg_cron` keeps it
co-located with the other jobs.

Also re-create the **other** cron jobs that lived in the DB (they migrate with the dump, but
verify): the ringing-call expiry and `mybot-pending-watchdog`. Confirm:
```sql
select jobname, schedule, active from cron.job order by jobname;
```

---

## 6. Auth cutover — the one user-visible event

The new stack signs JWTs with a **new `JWT_SECRET`**. Consequences:

- Existing app sessions become invalid → **every user logs in once** after cutover. Acceptable; communicate it.
- `auth.users` rows migrated in §3 carry the **bcrypt password hashes**, so users log in with
  their **existing passwords** — no forced reset. (This is why we dump `auth` data rather
  than recreating users.)
- Verify GoTrue env matches behavior you rely on: `enable_confirmations=false` (the app
  doesn't do email confirmation today — see `config.toml [auth.email]`), `JWT_EXPIRY=3600`,
  refresh-token rotation on.
- Password reset + email change now route through **your SMTP** — send a test reset before
  cutover and confirm the email lands.

**App change (the entire client-side diff) — TWO clients to repoint.** Both read the same two
vars ([mobile/src/lib/supabase.ts:6-7](mobile/src/lib/supabase.ts#L6)); no code change needed:
```
EXPO_PUBLIC_SUPABASE_URL=https://reda-api.waitwithselah.com
EXPO_PUBLIC_SUPABASE_ANON_KEY=<new anon key>
```
1. **Mobile** (`mobile/.env.local` / EAS secrets) → ship an OTA update (`expo-updates`) or a build.
2. **Web on Vercel** → set those two as **Vercel env vars** and **redeploy**. The web build is a
   static export (`mobile/vercel.json`: `npx expo export -p web` → `dist/`), so `EXPO_PUBLIC_*`
   are **inlined at build time** — changing the backend requires a redeploy, not a runtime toggle.

Realtime (`wss://reda-api.waitwithselah.com/realtime/v1`) and `functions.invoke('issue-agora-token')`
follow the same URL automatically on both clients. **CORS is non-blocking** — the self-host returns
`access-control-allow-origin: *` (verified 2026-06-05), so the browser-based web app is accepted
from the Vercel origin. **Rollback** = revert both clients' env to Cloud.

> **Web email flows need `SITE_URL` + SMTP.** Plain password login works without them, but the web
> app's password-reset / magic-link redirects use GoTrue's `SITE_URL` / `ADDITIONAL_REDIRECT_URLS`
> (currently a placeholder) + SMTP (currently unset — §10.1). Before cutover, set `SITE_URL` /
> `ADDITIONAL_REDIRECT_URLS` to include the **web origin** (the Vercel domain) and wire SMTP.

---

## 7. Operations you now own (the real cost of self-hosting)

Cloud did these for you; on the VPS they're yours:

- **Backups.** Nightly `pg_dump` to the mounted volume **and** off-box (Hetzner Storage Box
  or S3). Cron example:
  ```bash
  0 3 * * * docker exec supabase-db pg_dump -U postgres -Fc postgres \
    | gzip > /mnt/backups/reda-$(date +\%F).dump.gz && find /mnt/backups -mtime +14 -delete
  ```
  Then push to off-box storage. **Test a restore** before you trust it. (Cloud's PITR is gone
  — nightly dumps are coarser; if you need finer RPO, configure WAL archiving / a logical
  replica later.)
- **Admin access.** Studio only via SSH tunnel — never public:
  `ssh -L 8000:localhost:8000 reda@<ip>` then open `http://localhost:8000`.
- **Updates.** Periodically bump the Supabase images (`docker compose pull && up -d`); read
  the self-hosting changelog for breaking GoTrue/Realtime changes. Patch the OS (`unattended-upgrades`).
- **Monitoring + uptime.** A simple uptime check on `https://api.reda.<domain>/auth/v1/health`
  and a disk-space alert. This is a live logistics system — if the box is down, deliveries
  stop and there's no support line. Consider a Hetzner snapshot schedule as a coarse safety net.
- **Single point of failure.** One box = one failure domain. For higher resilience later: a
  standby replica or a second region. Not needed for v1, but know the tradeoff you're taking
  vs. managed.

---

## 8. Cutover runbook (minimize downtime)

> **Co-host note (2026-06-05):** on this box the `reda-api.waitwithselah.com` DNS + TLS cert
> already exist from the build phase (Caddy needs them to dry-run), so the cutover is **not** a
> DNS flip. It's two env changes + the app: (a) `WEBHOOK_GLOBAL_URL` in Evolution's compose →
> local stack (§4); (b) `EXPO_PUBLIC_SUPABASE_URL` / `ANON_KEY` in the app (§6). Both revert by
> editing the same values back to Cloud — that's the rollback.


1. **Dry run on the VPS** with a throwaway dump days ahead. Exercise: login, create delivery
   (manual + bot webhook), status change, EOD rollover, a voice call (Agora token mint),
   push notification. Fix issues with no clock pressure.
2. **Freeze window** (pick a low-traffic slot, e.g. late night after EOD): stop the WhatsApp
   relay from posting, or accept that in-flight webhooks during the window may need replay.
3. **Final dump → restore** to capture last-minute data.
4. **Flip DNS / relay webhook URLs** to the VPS; ship the app env update (OTA).
5. **Smoke test on production data**: §3e queries + a real login + one bot order end-to-end +
   confirm `cron.job` is scheduled.
6. **Watch for 24h** (covers one nightly EOD cycle) before decommissioning the Cloud project.
   Keep the Cloud project paused-but-alive for a week as rollback.

**Rollback:** revert app env + webhook URLs to Cloud. Because you kept the Cloud project,
this is a DNS/secret flip, not a rebuild. (Caveat: any writes that landed on the VPS after
cutover would need reconciling — hence the freeze window.)

---

## 9. Effort & cost summary

| Item | Estimate |
|---|---|
| DB dump/restore + verify | ~half a day (mostly verification) |
| Stack stand-up + TLS + secrets | ~half a day |
| Edge fns + cron replacement | ~half a day |
| Auth cutover + app env + dry runs | ~half a day |
| **Total** | **~2 focused days**, dominated by testing/verification not code |
| **Running cost** | ~€4.5/mo (CX22) + volume, vs. Cloud free-tier limits / Pro $25/mo |
| **Ongoing** | backups, patching, monitoring — recurring ops you don't have today |

**Net:** technically straightforward because the logic is portable Postgres + containerized
services; the only real engineering task is replacing Scheduled Edge Functions with
`pg_cron`+`net.http` (§5c). The genuine "cost" is operational ownership (§7), not migration
difficulty.

---

## 10. As-built status — rehearsal on the `whatsapp-bot` box (2026-06-05)

Phases 0–4 (parallel build through the dry run) were executed on the existing Hetzner box,
co-hosted next to the live Evolution bot with **zero impact on Cloud or the bot** (Cloud's only
involvement was a read-only `pg_dump`; nothing was repointed). Cutover (§6/§8) is **not** done.

**Phase 0 — swap.** Added a 3 GB swapfile (`/swapfile`, in `/etc/fstab`, `vm.swappiness=10`).
Box was at 0 swap; now 3 GB. Evolution untouched.

**Phase 1 — stack at `/root/supabase`.** Cloned the upstream `supabase/docker` stack.
- Postgres pinned to **17.6.1.084** via `docker-compose.pg17.yml` (matches Cloud's PG 17).
- Secrets generated with the repo's `utils/generate-keys.sh --update-env` → **legacy HS256**
  `JWT_SECRET` + `ANON_KEY` + `SERVICE_ROLE_KEY` (app-compatible; the stack runs legacy-only —
  `GOTRUE_JWT_KEYS` is commented out and `PGRST_JWT_SECRET` falls back to `${JWT_SECRET}`).
- URLs set to `https://reda-api.waitwithselah.com`; `POOLER_TENANT_ID=reda`.
- **Kong (8000/8443) and the pooler (5432/6543) bound to `127.0.0.1`** — nothing world-exposed.
- This newer stack does **not** ship `analytics`/`vector`/`logflare` in the base compose (they
  moved to `docker-compose.logs.yml`), so it's leaner than §2 assumed. Running set: db, auth,
  rest, realtime, kong, pooler(supavisor), meta, studio, storage, imgproxy, functions.
- **Footprint:** Supabase ~1.8 GB used, ~1.9 GB free + 3 GB swap; Evolution still <200 MB.
  (storage + imgproxy ≈ 400 MB are unused — a future trim if RAM ever tightens.)

**Phase 2 — database.** Dumped from Cloud via the **session pooler** using the db container's
v17 `pg_dump` (`--schema=public` schema+data; `auth.users`+`auth.identities` data-only).
Auth column layout was confirmed **identical** Cloud-vs-local before loading (no GoTrue drift).
Restored FK-safe (public pre-data → public data → auth data → public post-data). Pre-created
`pg_trgm` **in `public`** and `pg_net` to match Cloud placement; `pg_cron` created cleanly
(already in `shared_preload_libraries`). **Verified — local counts == Cloud exactly:**
25 tables, 136 functions, 48 RLS policies, 4 views, 32 users, 32 identities; all 25 tables
RLS-enabled; **all 32 users carry bcrypt password hashes** (existing passwords work, no reset).
Only restore "error" was the benign `CREATE SCHEMA public … already exists`.

**Phase 3 — functions, cron, public entry.**
- All **11 edge functions** copied to `volumes/functions/` (the `main` router dispatches by path;
  imports are full URLs / `npm:` specifiers, so no import map needed).
- Secrets wired via `env_file` split into **two files** (clean ownership, no clobber):
  - `reda-secrets.box.env` — recovered/generated on-box: `EVOLUTION_WEBHOOK_SECRET`
    (= Evolution's own `AUTHENTICATION_API_KEY`, read from `/root/evolution/docker-compose.yml`),
    `WASENDER_WEBHOOK_SECRET` + `BOT_INBOUND_SECRET` (generated), `SYSTEM_USER_EMAIL`,
    `SYSTEM_USER_PASSWORD` (generated **and** reset on the `system@reda.local` auth row via
    `pgcrypto crypt()/gen_salt('bf')`), `REDA_GROUP_JID` (empty/optional).
  - `reda-secrets.user.env` — provided by operator from provider consoles: `OPENROUTER_API_KEY`,
    `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY` (Geocoding API — `maps/api/geocode/json`),
    `AGORA_APP_ID`, `AGORA_APP_CERT`.
  - Self-referential `SUPABASE_URL`(=`http://kong:8000`)/`ANON_KEY`/`SERVICE_ROLE_KEY`/`JWT_SECRET`
    are injected by the compose `environment:` block, not the secrets files.
  - *(Recovery note: Cloud never returns secret plaintext — only digests. None of the values
    needed to come from Cloud: external keys come from their provider consoles, webhook secrets
    are regenerated on both ends, the system password is reset.)*
- **Cron (`pg_cron`)** — recreated (cron jobs live in the `cron` schema, so they did NOT migrate
  with the `public` dump). All call the **internal** `http://kong:8000/...` with **no embedded
  credentials** (the functions self-authenticate via their own env; Kong requires no key on
  `/functions/v1`):
  - `scheduled-eod-check` — `59 22 * * *` (22:59 UTC = 23:59 Lagos), 120 s timeout
  - `mybot-pending-watchdog` — `*/5 * * * *`
  - `internal-calls-expire-ringing` — `* * * * *` → `select public.expire_ringing_calls()`
  - `pg_net → kong` reachability proven (test POST returned 200).
- **Public entry** — reused the existing Evolution Caddy (no second proxy). Created a shared
  docker network **`reda-edge`**, attached it to the running `evolution-caddy-1` and
  `supabase-kong` containers (zero-downtime, no recreate), and added the site block
  `reda-api.waitwithselah.com → reverse_proxy supabase-kong:8000`. **Valid Let's Encrypt cert
  issued**; `https://reda-api.waitwithselah.com/functions/v1/hello` → 200; the live
  `evo.waitwithselah.com` route stayed 200 throughout.

**Phase 4 — dry run (core flows proven on migrated data, no outward side-effects).**
- Verified the **only** outward-calling triggers are on `bot_inbound_messages` /
  `mybot_inbound_messages` (the parse path); deliveries/status tables have none — so the rollover
  RPC pushes nothing. The only outward channel in the functions is **Expo push** (`exp.host`);
  there is **no WhatsApp-send-out** path.
- **Login** as `system@reda.local` → JWT issued, `iss=https://reda-api.waitwithselah.com/auth/v1`
  (proves GoTrue + the reset password + new HS256 signing).
- **PostgREST + RLS read** of `deliveries` with the user JWT → HTTP 200, real rows.
- **EOD rollover** via `POST /rest/v1/rpc/run_eod_rollover_all_stuck` with admin auth → HTTP 200,
  **113 stuck deliveries rolled over** (no push). The dry-run DB is now intentionally mutated;
  the cutover's fresh final dump overwrites it.
- **Bot-webhook intake — passed end-to-end (2026-06-06).** Synthetic order POSTed to
  `inbound-message` (auth via `BOT_INBOUND_SECRET`) → HTTP 200, row landed → `bot_parse_on_insert`
  trigger fired → `bot-parse-message` ran (~3s) → **real OpenRouter call** to
  `openai/gpt-4.1-mini` (cost $0.0002 — confirms the AI key works on the box) → address matched a
  **migrated location** (`confidence: high`) → product matched the **migrated catalog**
  ("Perfume" / client "Original Buy", score 0.44). Outcome: **`needs_review`, no delivery
  auto-created** — correct, because the synthetic `from_phone` mapped to no agent group
  (`agent_resolution: "no_hint"`) and the product score was low. A real order arrives via an
  agent's WhatsApp group (which *is* the attribution) and would resolve an agent + likely
  auto-create. This proves the full production intake path on migrated data: auth → edge fn →
  trigger → edge fn → OpenRouter → migrated locations + catalog → correct routing. (A
  `needs_review` push reached a real admin device via Expo — see the push-isolation note below;
  the synthetic row was deleted afterward.)
- **App-level acceptance test — passed (web, 2026-06-05, §10.3):** Vercel build pointed at the
  self-host → login succeeded from the browser.
- *Push isolation, learned during the intake test:* the self-host isolates the **DB/API/auth**,
  but **not** outbound Expo push. Expo push tokens are tied to the **device + Expo projectId**,
  not to the EAS channel or backend URL, so the migrated `push_tokens` are the *same real tokens*
  production uses — a push dispatched from the self-host reaches the real phone regardless of which
  channel that phone's app is on. To rehearse intake without paging admins, temporarily disable the
  `notify_bot_review` / `notify_bot_error` triggers on `bot_inbound_messages` (reversible). At
  cutover these pushes *should* fire — that's correct behavior then.
- **Manual create + status change + Agora — passed end-to-end (2026-06-06).** Authenticated as the
  migrated **admin** system user (`system@reda.local`) via GoTrue and exercised the real
  RLS/role-gated RPC paths through internal Kong (notify triggers temporarily disabled for the run,
  re-enabled + verified `O` after; Test Agent has 0 push tokens so nothing reached a real device
  regardless):
  - `create_stock_adjustment` (+1 unit) → 200; and `change_delivery_status`→`delivered` correctly
    **blocked with `insufficient_stock`** before stock existed (guard works).
  - `create_delivery` (manual, assigned) → new row at `pending`.
  - `change_delivery_status` `pending`→`delivered` (qty 1, paid 10000, transfer) → **HTTP 204**.
    Verified snapshot: `charged_snapshot = 5500.00` (Reda charge from the **Ejigbo location rate,
    per-delivery** — matches the per-delivery fee rule), `cash_pos_fee_snapshot = 0` (transfer, so
    no cash-POS fee), `quantity_delivered/paid/payment_method` set, and `delivery_status_history`
    holds both `→pending` (create) and `pending→delivered` rows, both by the system user.
  - **Agora token mint:** synthetic `ringing` call → `issue-agora-token` returned a real RTC token
    (223-char), `app_id 2b3061dc…`, `channel call-<uuid>`, deterministic `uid`, 300s TTL — proving
    `AGORA_APP_ID`/`AGORA_APP_CERT` work on the box.
  - Cleanup: synthetic call deleted, test delivery soft-deleted (`deleted_at`), agent stock net 0
    (+1 intake, −1 on delivered). Orchestration script: `/tmp/selfhost-drytest.sh` on the box.
- *Not yet exercised:* **mobile dev-build login** — can't be driven from here (needs a physical
  device / EAS build). Backend is proven ready: it's the same GoTrue/PostgREST the web app already
  logs into, and admin RPCs were just exercised as a real user. Remaining = a client-side config +
  device action (point a dev build's `EXPO_PUBLIC_*` at the self-host and log in).

### 10.1 Security hardening — REQUIRED before cutover

The rehearsal config favors getting-it-working; tighten these before flipping production:

1. **Edge functions publicly callable — ✅ RESOLVED (2026-06-06, Caddy allow-list).**
   `FUNCTIONS_VERIFY_JWT=false` and Kong has no key-auth on `/functions/v1/*`, so originally
   anyone reaching the URL could invoke any function (e.g. trigger an EOD rollover) — *more open
   than Cloud*. **Fix:** a deny-by-default allow-list in the `reda-api` block of
   `/root/evolution/Caddyfile`. Only the data-plane + self-protecting/externally-invoked functions
   are proxied to Kong from the public edge:
   `@public path /auth/v1/* /rest/v1/* /graphql/v1* /realtime/v1/* /storage/v1/* /.well-known/*`
   `/sso/saml/* /functions/v1/{issue-agora-token,inbound-message,evolution-webhook,wasender-webhook}`
   — wrapped in a `handle @public { reverse_proxy supabase-kong:8000 }` + `handle { respond 404 }`
   pair. **handle blocks (not a bare `respond`) are required** — a bare `respond` is reordered
   ahead of `reverse_proxy` by Caddy's directive ordering and 404s *everything* (observed; the
   data-plane briefly went down until switched to handle blocks). The internal-only functions
   (`scheduled-eod-check`, `send-notification`, `send-assignment-push`, `normalize-address`,
   `enumerate-corridor-aliases`, `bot-parse-message`, `mybot-parse-message`) + Studio now return
   **404 publicly**, while internal callers (cron, DB triggers, `send_edge_notification`) reach
   them via `http://kong:8000` *inside the docker network*, bypassing Caddy. **Verified:** public
   `scheduled-eod-check`/`send-notification`/`bot-parse-message`/`/`(Studio) → 404;
   `issue-agora-token`/`inbound-message` → 401 (reachable, self-protect); `/rest/v1/` +
   `/auth/v1/settings` → 200; internal `kong:8000/functions/v1/normalize-address` → 400
   (reachable). Apply via `docker exec evolution-caddy-1 caddy reload --config /etc/caddy/Caddyfile`
   (graceful; bad config keeps the running one). Pre-change backup: `Caddyfile.bak.preharden`.
2. **Studio public exposure — ✅ RESOLVED (2026-06-06).** Folded into the item-1 allow-list:
   Studio is the Kong `/` catch-all, which is no longer in `@public`, so
   `https://reda-api.waitwithselah.com/` now returns 404. (The old `DASHBOARD_USERNAME` basic-auth
   is moot at the edge now.) Admin access remains the SSH tunnel below.
   - *Admin-access note (as-built):* Kong's basic-auth popup is unreliable in Chrome (it renders
     the `401` body instead of prompting), and an SSH tunnel **to Kong** hits the same gate. So
     Studio was also published **directly** at `127.0.0.1:3001` (→ container `:3000`, localhost-only)
     in `/root/supabase/docker-compose.yml`. Reach it with `ssh -L 3001:127.0.0.1:3001 <box>` →
     `http://localhost:3001` — **no basic-auth, not public** (tunnel is gated by your SSH key).
     This is the recommended admin path; it supersedes the §7 `8000` tunnel.
3. **`reda-edge` network attachments — ✅ RESOLVED (2026-06-06, compose-declared).** Previously
   runtime-only (`docker network connect`) and lost on reboot. Now declared as an **external**
   network in both compose files: added `reda-edge: {}` to the `kong` service + a top-level
   `networks: { reda-edge: { external: true } }` in `/root/supabase/docker-compose.yml`, and
   `reda-edge` to the `caddy` service + top-level external in `/root/evolution/docker-compose.yml`.
   Recreated `kong` (`sh run.sh recreate kong`) then `caddy`
   (`docker compose up -d --force-recreate --no-deps caddy`). With `restart: unless-stopped` on
   both, a reboot brings them back already attached — no manual reconnect. **Verified:** network
   inspect lists both containers; data-plane 200, allow-list intact, evo bot 200 post-recreate.
   Compose backups: `docker-compose.yml.bak.reda-edge` in each dir. (Note: the supabase stack is
   layered via `COMPOSE_FILE=docker-compose.yml:docker-compose.pg17.yml`; pg17 overrides only
   `db`, so the base-file network edit is authoritative.)
4. **SMTP unset** — GoTrue password-reset/email-change will silently fail until an SMTP block is
   configured (§2). **Deferred; provider chosen: Resend** (need its SMTP host/port/user/pass +
   from-address, then set `SITE_URL`/redirect URLs for the web origin and confirm a test reset).
   Login itself does not need SMTP, so this is safe to defer past the rehearsal.
5. **`REDA_GROUP_JID` empty** — fine for the dry run (all groups processed), but set it to the
   real group JID to lock down intake before/at cutover.
6. **Production-data copies on the box** — `/root/migrate/reda_public.dump` (~10 MB) +
   `reda_auth.dump` hold real customer PII. Delete after the rehearsal (the live restored DB
   remains); a fresh dump is taken at cutover anyway.

### 10.2 Remaining before cutover

- [x] Bot-webhook intake dry run — **passed** (2026-06-06; full parse path on migrated data, §10).
- [x] Web app acceptance test — **passed** (2026-06-05, Vercel → self-host login, §10.3).
- [x] Manual create + status change (delivered, fee snapshot) + Agora token mint — **passed**
      (2026-06-06, §10). Bonus: stock adjustment + `insufficient_stock` guard verified.
- [ ] **Mobile dev-build login** — only remaining dry-run item; needs a physical device (backend
      proven ready). Point a dev build's `EXPO_PUBLIC_SUPABASE_URL`/`_ANON_KEY` at the self-host.
- [x] §10.1 function exposure + Studio lockdown — **done** (Caddy allow-list, 2026-06-06).
- [x] §10.1 persist `reda-edge` across reboot — **done** (compose external network, 2026-06-06).
- [ ] Remaining §10.1 hardening: SMTP via **Resend** + `SITE_URL`/redirect URLs (deferred),
      delete `/root/migrate/*.dump` PII copies.
- [x] **Local nightly DB backups — done** (2026-06-06). `/root/backups/reda-db-backup.sh`:
      `pg_dump -Fc` of `supabase-db` (all schemas) + `pg_dumpall --globals-only`, 14-day rotation,
      logs to `backup.log`, disk-guard >85%, optional healthcheck-ping hook. Cron `0 2 * * *`
      (02:00 UTC = 03:00 Lagos, clear of the 22:59 UTC rollover). Verified: 11 MB dump, valid TOC.
      Restore: `cat reda-db-<ts>.dump | docker exec -i supabase-db pg_restore -U postgres -d postgres --clean --if-exists`.
- [x] **Off-box backup shipping — DONE (2026-07-03).** Hetzner **Storage Box BX11** (1 TB, ~€3.20/mo,
      `u626739@u626739.your-storagebox.de:23`, SSH+External-Reachability on; SMB/WebDAV off). A dedicated
      VPS keypair (`/root/.ssh/id_storagebox`) is authorised on the box. Nightly cron `30 2 * * *`
      (`/root/backups/reda-offsite-borg.sh`, 30 min after the 02:00 DB dump) pushes `/root/backups` to an
      **encrypted** borg repo (`repokey-blake2`, `.../reda-borg`), prunes 7d/4w/6m, compacts. Verified:
      byte-for-byte test restore matched source md5; borg dedup → repo ~99 MB. **DR keys** live root-only
      in `/root/.borg/` (`passphrase`, exported `reda-borg.key`) — these MUST also be copied OFF the box
      (password manager), else a box loss makes the encrypted offsite copy unrecoverable. Optional TODO:
      set `BORG_HEALTHCHECK_URL` (healthchecks.io dead-man switch) for the offsite job.
- [x] **Monitoring/alerting — done** (2026-06-06). **healthchecks.io** wired into the backup
      script's `HEALTHCHECK_URL` and verified green (ping HTTP 200); dead-man-switch armed if a
      nightly backup is missed. **UptimeRobot** monitor set up by the user. (Details: §10.4.)
- [ ] Image updates (§7).
- [ ] Cutover (§8): freeze window → final dump/restore → flip `WEBHOOK_GLOBAL_URL` **+ mobile env
      (OTA/build) + Vercel env (redeploy)** → smoke test on both clients → 24 h watch with Cloud
      paused-but-alive as rollback.

### 10.3 Clients & web access (Vercel) — verified 2026-06-05

Reda has **two** frontends, both `@supabase/supabase-js` reading `EXPO_PUBLIC_SUPABASE_URL` +
`EXPO_PUBLIC_SUPABASE_ANON_KEY`:

- **Mobile** — Expo native (EAS builds / Expo Go). No CORS (native HTTP).
- **Web** — Expo-web static export on **Vercel** (`mobile/vercel.json` → `npx expo export -p web`
  → `dist/`, SPA catch-all rewrite). **This is how Uzo uses Reda from any laptop.** The frontend
  stays hosted on Vercel; only its backend env changes. Because `EXPO_PUBLIC_*` is inlined at
  build time, repointing the backend = update Vercel env vars + **redeploy**.

**"Available from anywhere" is preserved.** The self-host API (`reda-api.waitwithselah.com`) is
public over HTTPS with a valid LE cert, and the Vercel frontend remains globally hosted — so the
web app keeps working from any network. Nothing about self-hosting the backend forces the web app
onto a VPN or the LAN.

**CORS — non-blocking (verified).** A live preflight from a Vercel origin returned
`access-control-allow-origin: *` (Kong's `cors` plugin). Safe here because supabase-js
authenticates with bearer **headers**, not cookies, so wildcard origin is fine.

**Testing the web app against the self-host without touching production:**
- **Preferred — Vercel Preview deployment:** set the two `EXPO_PUBLIC_*` vars (self-host URL + new
  anon key) scoped to **Preview** / a test branch, deploy → a unique preview URL hits the self-host
  while **production stays on Cloud**. Click through login → deliveries → a call.
- **Or local web:** `npx expo start --web` from `mobile/` with the self-host values in `.env.local`
  (CORS `*` allows `localhost`).

**Cutover for web** (part of §6 / §8): set the two vars in the **Vercel production** environment and
redeploy. Pair with setting GoTrue `SITE_URL` / `ADDITIONAL_REDIRECT_URLS` to the Vercel origin +
SMTP (§10.1) so web password-reset/magic-link flows resolve. Rollback = revert Vercel env + redeploy.

### 10.4 Ops — backups & monitoring (as-built + setup guide)

**Backups (done, local) — see §10.2.** `/root/backups/reda-db-backup.sh`, cron `0 2 * * *`
(02:00 UTC / 03:00 Lagos). `pg_dump -Fc` of all schemas + `pg_dumpall --globals-only`, 14-day
rotation, logs to `/root/backups/backup.log`, disk-guard at 85%, and a `HEALTHCHECK_URL` hook
(empty until healthchecks.io is wired — see below). Restore:
`cat reda-db-<ts>.dump | docker exec -i supabase-db pg_restore -U postgres -d postgres --clean --if-exists`.

**Off-box shipping — PAUSED (cost).** See §10.2; revisit before cutover (Hetzner Storage Box or
Backblaze B2).

#### Monitoring service A — healthchecks.io (backup dead-man's switch) — *most important*

**Status: ✅ wired + verified green (2026-06-06).** `HEALTHCHECK_URL` is set in the backup script;
a manual run pinged successfully (HTTP 200).

Alerts if a nightly backup ever silently stops running (cron broke / docker down / box down /
`pg_dump` failed). The script pings the URL **only after a successful dump**; if no ping arrives
within `period + grace`, healthchecks.io emails an alert.

- **Pricing:** free tier = **20 checks, permanently free** (a standing cap, *not* a trial/expiry).
  We use **1**. Paid only if you need >20 checks or SMS/phone alerts. Email/Slack/Telegram/webhook
  alerts are free. (healthchecks.io is also open-source → self-hostable if ever needed.)
  Free-tier ping/event **history is capped** but irrelevant for a once-daily job.
- **Setup:**
  1. Sign up at https://healthchecks.io (email or Google/GitHub).
  2. Add / open a check → Edit:
     - Name: `Reda self-host nightly DB backup`
     - Schedule: **Cron** = `0 2 * * *`, Timezone **UTC**
     - Grace Time: `1 hour`
  3. Copy its **Ping URL** (`https://hc-ping.com/<uuid>`).
  4. Paste it into `HEALTHCHECK_URL` in `/root/backups/reda-db-backup.sh`, then run the script once
     → the check flips to green ("up"), confirming wiring.
  5. Confirm email is enabled under **Integrations**.
- *The ping URL is mildly sensitive (resets the timer) — keep it private.*

#### Monitoring service B — UptimeRobot (external service-down alert)

**Status: ✅ set up by user (2026-06-06).**

Pings the box from outside every 5 min; alerts if the edge stops responding.

- **Pricing:** free tier = 50 monitors, 5-min interval. Sufficient.
- **Setup:**
  1. Register at https://uptimerobot.com, verify email.
  2. **+ New monitor** → Type `HTTP(s)`, Name `Reda box (Caddy edge)`,
     URL **`https://redalogisticss.com/healthz`**, interval `5 minutes`, tick your email contact → Create.
  3. *(Optional)* Edit → enable **Keyword** = `ok`, alert when keyword **does NOT** exist.
- **URL note (updated 2026-07-03):** the old `evo.waitwithselah.com/` target died with the retired
  Evolution relay. Its replacement is **`/healthz`** — a tiny `respond "ok" 200` handle added to the
  `redalogisticss.com` Caddy block that returns a clean **200 with no auth** and no Kong hop. Same
  "is the edge alive" signal (same Caddy container / box / Docker daemon), and free UptimeRobot can
  read a 200 without an apikey. All real `reda-api` endpoints require auth (or `404` default-deny),
  which UptimeRobot can't authenticate against; DB-level health stays covered by the healthchecks.io
  dead-man's switch.

---

## 11. Re-sync runbook — refresh the (pre-cutover) box from Cloud

The box is a **rehearsal** stack (cutover never happened), so Cloud keeps drifting ahead of it.
This is the procedure to bring the box back in line with live Cloud — also the dress rehearsal
for the cutover's "final dump → restore". **Done 2026-06-23** (Cloud had moved to 29 tables /
171 functions / 51 policies / 5 views / 38 users / 5 cron jobs vs the box's 25/136/48/4/32/3).
A full re-sync is **~12 MB and a few minutes**; Evolution is never restarted.

**Strategy:** fresh `pg_dump` from Cloud (live = source of truth), **not** replaying repo `.sql`.
Drop+restore `public`, reload `auth` data, re-copy edge functions, re-create cron. All run on the
box as root over SSH (`root@178.104.73.186`).

### The five gotchas (each one will silently break things if skipped)

1. **`DROP SCHEMA public CASCADE` wipes role GRANTs *and* the default privileges.** After a
   `--no-privileges` restore the tables end up with **no grants for `anon`/`authenticated`/
   `service_role`** → every PostgREST/edge insert fails with *"permission denied for table …"*
   (caught only because the bot-intake smoke test 500'd — RPCs via `SECURITY DEFINER` still work,
   so it hides easily). **Fix — re-grant after restore:**
   ```sql
   grant usage on schema public to postgres, anon, authenticated, service_role;
   grant all on all tables    in schema public to anon, authenticated, service_role;
   grant all on all routines  in schema public to anon, authenticated, service_role;
   grant all on all sequences in schema public to anon, authenticated, service_role;
   alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
   alter default privileges for role postgres in schema public grant all on routines  to anon, authenticated, service_role;
   alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
   ```
   (The `pg_trgm` "no privileges were granted" warnings are benign — extension-owned funcs.)
2. **Cloud URLs ride along in the restored `public`.** Restoring verbatim re-points DB→edge calls
   at Cloud. Three spots, **all must be repointed to `http://kong:8000`** (sweep with
   `pg_get_functiondef`/`pg_get_triggerdef ... ilike '%supabase.co%'` until 0):
   - function **`send_edge_notification`** (hard-coded URL; keep the `x-internal-secret` header);
   - trigger **`bot_parse_on_insert`** on `bot_inbound_messages` (`supabase_functions.http_request`
     args carry the URL + `x-internal-secret`);
   - trigger **`mybot_parse_on_insert`** on `mybot_inbound_messages` (carries the URL **and a
     Cloud `service_role` JWT** — swap to `x-internal-secret` = the box's `INTERNAL_FUNCTION_SECRET`).
3. **`auth` reload overwrites the system user's password.** A full `truncate auth.users/identities
   + restore` is needed (Cloud is a superset; `public.users` FKs the new users), but it replaces
   `system@reda.local`'s hash with Cloud's → the box's `SYSTEM_USER_PASSWORD` (in
   `reda-secrets.box.env`, used by EOD/intake) no longer matches. **Re-reset it after reload:**
   `update auth.users set encrypted_password = extensions.crypt('<box pw>', extensions.gen_salt('bf')) where email='system@reda.local';`
4. **New self-gating functions need `INTERNAL_FUNCTION_SECRET` on the box.** Since the rehearsal,
   `denyIfNotInternal` (`_shared/internal-auth.ts`) gates `bot-parse-message`, `mybot-parse-message`,
   `normalize-address`, `enumerate-corridor-aliases`, `send-notification`, `send-assignment-push`.
   Set `INTERNAL_FUNCTION_SECRET` in `reda-secrets.box.env` (we use the **same value as Cloud**, so
   restored cron/trigger/`send_edge_notification` literals match verbatim). Without it the parse
   path's internal sub-calls (parse → normalize/enumerate) 401, and the watchdog crons must send the
   secret too (`x-internal-secret` header).
5. **`docker restart` does NOT re-read `env_file`.** New secrets only load on **recreate**:
   `cd /root/supabase && sh run.sh recreate functions` (force-recreate, `--no-deps`, Evolution
   untouched). `docker restart supabase-edge-functions` will leave the new env absent.

### Order of operations (what was run 2026-06-23)

1. Add `INTERNAL_FUNCTION_SECRET` to `reda-secrets.box.env` (gotcha 4).
2. `pg_dump` from Cloud **inside the db container** (v17 matches Cloud), session pooler:
   `--schema=public` (schema+data) and `--data-only -t auth.users -t auth.identities`.
3. **Backup the box first**: `bash /root/backups/reda-db-backup.sh`.
4. `drop schema public cascade; create schema public;` → re-grant usage → `create extension pg_trgm
   schema public` (only `pg_trgm` lives in `public`; `pg_net`/`pgcrypto`/`uuid-ossp` are in
   `extensions`, `pg_cron` in `pg_catalog` — all survive).
5. `truncate auth.identities, auth.users cascade` → `pg_restore -U postgres --data-only` the auth
   dump (→ 38/38).
6. `pg_restore -U postgres --no-owner --no-privileges` the public dump (the lone "schema public
   already exists" error is benign). **`-U postgres` is required** or it peer-auths as `root`.
7. Apply the **grants** block (gotcha 1).
8. Re-reset system password (gotcha 3); repoint the 3 cloud URLs (gotcha 2).
9. Re-create cron to match Cloud's 5 jobs, translated to kong + secret: `bot-pending-watchdog`,
   `internal-calls-prune-net-responses` (missing on box), and **update** `mybot-pending-watchdog`
   to send `x-internal-secret` (now that the fn self-gates). `scheduled-eod-check` /
   `internal-calls-expire-ringing` already correct.
10. `scp` repo `supabase/functions/*` (the 11 fns + `_shared`) into `volumes/functions/` (leaves the
    box-only `main` router + `hello` intact) → `sh run.sh recreate functions` (gotcha 5).
11. **Verify:** object counts == Cloud; system-user login → JWT; `rpc/is_admin` → true; gated fn
    401 without / non-401 with the secret; **intake smoke test** (notify triggers disabled →
    `POST /functions/v1/inbound-message` with `BOT_INBOUND_SECRET` → row `queued`→`needs_review`
    in ~4s → delete row → **re-enable triggers**); all 5 cron `job_run_details` = `succeeded`.
12. **Cleanup:** shred the staged Cloud URI, delete the `/tmp/*.dump` (PII) inside the container
    and the old `/root/migrate/*.dump` rehearsal copies.

> Frontend is **not** part of a box re-sync — the web app (Vercel) and mobile (EAS) only repoint
> their `EXPO_PUBLIC_SUPABASE_URL`/`_ANON_KEY` at **actual cutover** (§6). After a re-sync the
> schema they target simply matches the box again.

---

## 12. Production-readiness audit (2026-07-03)

Read-only audit of the live box (`root@178.104.73.186`) against "ready for production, 25–40
concurrent Reda users." **Box:** 2 vCPU / 3.7 GiB RAM / 38 GB disk (53% used), Ubuntu 24.04,
co-hosting the full Supabase stack + Studio + the (now-dead) Evolution relay. Load ~0.55 idle.

**What's already solid** — don't re-litigate: UFW active default-deny; only 22/80/443 public;
Postgres, pooler, Kong, Studio **all bound to `127.0.0.1`**; TLS valid + auto-renewing; **no demo/
default secrets** (all strong); restart policy `unless-stopped` (survives reboot); pooler in
transaction mode (pool 20); nightly local + encrypted offsite (borg) backups; unattended security
upgrades on. `/root/migrate/*.dump` PII copies already gone.

### 🔴 Critical — before trusting it in production
- **C1. Offsite backup unrecoverable + incomplete.** borg passphrase + exported key still live only
  in `/root/.borg/` — must be copied OFF-box (password manager), else a box loss makes the encrypted
  repo undecryptable. **And the backup scope only dumps Supabase — the contractor/bot data is now the
  live intake, but `evolution-postgres` is dead so no gap there; confirm nothing else lives outside
  `supabase-db`.** (Since intake is contractor-side WASender → Cloud, the box holds only the Supabase
  DB, which *is* dumped nightly.)
- **C2. Sizing — 4 GB is ADEQUATE; trim, don't upsize (revised 2026-07-03 against live Cloud
  metrics).** Downgraded from the initial "resize to 8 GB." The live system runs on Cloud's
  **NANO = 0.5 GB / shared CPU**, and that 0.5 GB is the **database compute ONLY** — Cloud runs
  auth/rest/realtime/kong/pooler/storage/edge-functions on *its own* platform. The self-host box runs
  all of those itself; that's where its RAM goes, **not** load. On the box `supabase-db` uses just
  **168 MB** (≈ NANO). Real load is light (Cloud: 0.221 GB data, 30 MAU, 17/200 peak realtime, 6%
  edge-invocation quota, DB memory steady ~65% of 0.5 GB). The box has **2.1 GB available now**;
  swappiness=10 parks idle pages (benign, not thrashing). **Verdict: the current 4 GB box handles
  25–40 users.** Remove the idle swap by **trimming unused services, not buying RAM**: stop
  `storage`+`imgproxy` (no buckets — §0) ≈145 MB, run Studio on-demand via SSH tunnel ≈210 MB
  (Evolution already removed ≈200 MB). 8 GB is optional insurance only; if upgrading, **more vCPU
  (2→4) helps burst CPU more than RAM** (Cloud CPU peaks to 100% on shared cores during heavy
  RPCs/EOD). **The real reason to leave Cloud free tier is egress (135% of the 5 GB cap)** —
  Hetzner's 20 TB kills that.
- **C3. No Docker log rotation.** No `/etc/docker/daemon.json` limits; the Evolution log alone hit
  435 MB. Unbounded → eventual disk-fill outage. Add `json-file` `max-size=10m`/`max-file=3` (daemon
  restart = brief live-bot-less bounce of all containers; schedule it). *(Retiring Evolution removes
  the current worst offender but the cap is still needed for the Supabase containers.)*

### 🟠 High — security hardening
- **H1. SSH accepts passwords + no fail2ban.** `PasswordAuthentication yes` and port 22 world-open
  with **fail2ban inactive**. Root is already key-only (`without-password`). Set
  `PasswordAuthentication no` (we're on keys) + install fail2ban.
- **H2. `/root/supabase/.env` is world-readable (644)** and holds `POSTGRES_PASSWORD`, `JWT_SECRET`,
  `SERVICE_ROLE_KEY`, `VAULT_ENC_KEY`, `DASHBOARD_PASSWORD`. `chmod 600`. (Box `reda-secrets.box.env`
  + `.borg/*` are correctly 600.)
- **H3. Storage Box password was exposed in chat** — reset it in the Hetzner console.

### 🟡 Medium — tuning / robustness
- **M1. Postgres near-default tuning** for the box RAM: `effective_cache_size = 128 MB` (should be
  ~2 GB — bad plans under load), `shared_buffers = 128 MB`, `work_mem = 4 MB`. Tune to final RAM.
- **M2. No app-level monitoring** beyond the backup dead-man switch — add an uptime check on
  `redalogisticss.com` + disk/mem alerts. (Repoint the existing UptimeRobot off the dying
  `evo.waitwithselah.com`.)
- **M3. Single point of failure / restore not drilled on a schedule.** One box, no failover — do one
  live restore-from-offsite drill.

### Decommission Evolution (safe — see the 2026-07-03 update block up top)
Evolution relay fed **0 rows ever**; live intake is the contractor's WASender bot. Remove the
`evolution` + `postgres` services (KEEP `caddy`), delete `/root/supabase-src` (~1.4 GB clone).
Net: ~4.2 GB disk + one-less-moving-part; does not change the C2 resize need.

### Path to "production-ready for 25–40 users"
1. ✅ **Copy borg passphrase + key off-box — DONE 2026-07-03** (passphrase + exported key stored in
   the operator's Google password manager) *(C1)*
2. ☐ Docker log rotation + truncate *(C3 — needs a brief maintenance window; daemon restart bounces
   all containers)*
3. ✅ **`chmod 600 /root/supabase/.env` — DONE 2026-07-03** *(H2)*
4. ✅ **SSH key-only (`PasswordAuthentication no`) + fail2ban — DONE 2026-07-03** *(H1)*
5. ☐ Reset Storage Box password *(H3 — operator action, Hetzner console)*
6. ☐ Tune Postgres to final RAM *(M1 — low priority given the light load)*
7. ✅ **Uptime + backup monitoring — DONE** — healthchecks.io dead-man switch (green) + UptimeRobot
   repointed to `https://redalogisticss.com/healthz` *(M2)*
8. ✅ **Trim unused services — DONE 2026-07-03** (stopped `storage`+`imgproxy` [0 buckets] + Studio
   on-demand; ~400 MB RAM freed) *(C2)*
9. ☐ One live restore drill *(M3)*
10. ✅ **Retire Evolution + delete `supabase-src` — DONE 2026-07-03** (relay fed 0 rows ever; ~4 GB
    disk + ~200 MB RAM reclaimed; Caddy untouched, data plane verified 200).

**Remaining open:** #2 (log rotation, needs a window), #5 (Storage Box pw reset — yours), #6 (Postgres
tuning, low priority), #9 (restore drill).

### 12.1 Hardening applied — 2026-07-03 (Track A, as-built)

All executed live, zero-downtime; `redalogisticss.com` data plane verified **200** before/after each.

- **H2 — `/root/supabase/.env` → `600`.** Was `644` (world-readable) with all master secrets
  (`POSTGRES_PASSWORD`, `JWT_SECRET`, `SERVICE_ROLE_KEY`, `VAULT_ENC_KEY`, `DASHBOARD_PASSWORD`).
- **H1 — SSH is now key-only + fail2ban.**
  - Drop-in `/etc/ssh/sshd_config.d/99-reda-hardening.conf` (the main `sshd_config` `Include`s that
    dir — it was empty; `yes` had been only the OpenSSH compiled default):
    `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`.
    Gated on `sshd -t` before `systemctl reload ssh`; a fresh `ssh -o BatchMode=yes` (no password
    fallback) key-only connection confirmed working → **no lockout**. Revert: delete the drop-in + reload.
  - **fail2ban** installed (`backend = systemd`; `/etc/fail2ban/jail.local` → `[sshd] enabled`,
    `maxretry 5`, `bantime 1h`). It **banned 6 active brute-force IPs on first start** — the port-22
    surface was real, not theoretical.
- **C2 trim — stopped 3 unused containers (~400 MB RAM freed: used 1.7→1.3 GiB, avail 2.1→2.4 GiB).**
  - `supabase-storage` + `supabase-imgproxy` — verified **0 buckets / 0 objects** on the box, so
    nothing uses them (`/storage/v1/*` now 502s — unused). **Revive:** `docker start supabase-storage
    supabase-imgproxy`.
  - `supabase-studio` — now **on-demand**. **Revive for admin:** `docker start supabase-studio`, then
    `ssh -L 3001:127.0.0.1:3001 root@178.104.73.186` → `http://localhost:3001`.
  - **Caveat:** a bare `docker compose up -d` in `/root/supabase` would restart all three. They stay
    down across reboot (explicit `docker stop` + `restart: unless-stopped`), and the re-sync runbook's
    targeted `sh run.sh recreate functions` does not revive them. Making the trim permanent (a
    `profiles:` guard or removing the services from compose) is deferred — `docker stop` is reversible
    and low-friction.
