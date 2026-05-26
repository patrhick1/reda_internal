# Reda — Paschal's Runbook

How to operate Reda after v1 ships. This is the "I haven't touched it in
three months, what do I do" doc. Living document — fix it the same PR as
the code change that broke it.

---

## Project anchors

| Thing                          | Where                                                                  |
|--------------------------------|------------------------------------------------------------------------|
| Supabase project ref           | `wadjlpqfpaxycspofgrc` (treated as prod; no separate dev project)      |
| Supabase dashboard             | https://supabase.com/dashboard/project/wadjlpqfpaxycspofgrc            |
| Admin email                    | `redalogisticss@gmail.com` (Uzo) + `admin@reda.dev` (test backup)      |
| Mobile app code                | [`mobile/`](mobile/)                                                   |
| Edge functions                 | [`supabase/functions/`](supabase/functions/)                           |
| Operational scripts            | `scripts/` (gitignored — local only, contains plaintext passwords)     |
| Phase plan (north star)        | [reda_phased_plan.md](reda_phased_plan.md)                             |
| User docs                      | [reda_admin_runbook.md](reda_admin_runbook.md), [reda_agent_guide.md](reda_agent_guide.md) |

---

## Common operations

### Deploy a schema change

Reda uses the **paste-into-Supabase-SQL-editor** workflow (no Docker, no
migrations folder). When you change the schema:

1. Write the SQL in `scripts/phaseN-<topic>.sql`.
2. **Verify dependencies first** — query `pg_proc`, `pg_constraint`,
   `pg_trigger` for anything you call/reference. Don't trust the docs;
   the docs lie when the schema drifts.
3. Paste the SQL into the Supabase SQL editor. Confirm it runs.
4. From the repo root: `npm run gen:types` — regenerates
   `mobile/src/types/database.gen.ts`. Commit the changes.
5. `npm --prefix mobile run typecheck` — should pass. If it doesn't,
   either the schema is wrong, or the app code needs to catch up.
6. Smoke test against the live DB if relevant (see "Smoke tests" below).

Never edit the DB through the Supabase UI in a way you can't reproduce
from a `.sql` file. The schema must be reproducible from `main`.

### Run a smoke test against the live DB

The smoke tests are in `scripts/smoke-*.sql`. They use begin/rollback so
they leave no trace. From the repo root:

```bash
URI=$(grep -E '^SUPABASE_DB_URI' .env | sed 's/^[^=]*= *//')
"/c/Program Files/PostgreSQL/17/bin/psql" "$URI" -f scripts/smoke-phase6.sql
```

(The `SUPABASE_DB_URI` env-var is the pooler connection string — see `.env`.)

### Deploy or update an Edge Function

For Phase 8 bot pipeline functions (`wasender-webhook`, `normalize-address`,
`bot-parse-message`) and Phase 5 `send-assignment-push`:

```powershell
# From repo root.
supabase functions deploy <name>
# For wasender-webhook only:
supabase functions deploy wasender-webhook --no-verify-jwt
```

Each takes 15–30 seconds.

### Rotate API keys

The four secrets stored in Supabase: `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`,
`WASENDER_API_KEY`, `WASENDER_WEBHOOK_SECRET`. Plus Supabase's own auto-
provided service role + URL.

To rotate any:

```powershell
supabase secrets set GEMINI_API_KEY=AIza...new-key
supabase secrets list   # verify
```

You usually don't need to redeploy the function — Deno reads secrets at
request time. If a function's behaviour doesn't update, redeploy it.

If `WASENDER_WEBHOOK_SECRET` rotates: also update the same value in the
Wasender dashboard → Session → Webhook Secret. They must match exactly.

### Flip feature flags

Either from the app (**Admin → Flags** screen — hidden from tab bar, reach
via direct route) or via SQL:

```sql
update public.feature_flags
   set enabled = true, updated_at = now()
 where key = 'enable_bot_pipeline';
```

The three flags:

| Key                            | Default | Purpose                                                              |
|--------------------------------|---------|----------------------------------------------------------------------|
| `enable_bot_pipeline`          | false   | Master switch for WhatsApp ingestion.                                |
| `enable_address_normalization` | false   | If false, every bot delivery goes to *Needs Review* for manual location pick. |
| `bot_shadow_mode`              | true    | If true, bot parses + logs but does NOT create deliveries.            |

Going live is `enable_address_normalization` first → `enable_bot_pipeline` →
`bot_shadow_mode = false`. See [reda_phase8_deployment.md](reda_phase8_deployment.md)
for the full sequence.

### Where to find logs

| What you want to see                  | Where                                                                  |
|---------------------------------------|------------------------------------------------------------------------|
| Edge Function stdout/errors           | Supabase dashboard → Edge Functions → [name] → **Logs**                |
| Database Webhook fire history         | Supabase dashboard → Database → Webhooks → [hook] → **Logs**           |
| Auth (sign-in attempts, failures)     | Supabase dashboard → Authentication → **Logs**                          |
| SQL slow queries / pg errors          | Supabase dashboard → Logs → **Postgres**                                |
| Wasender webhook delivery attempts    | https://wasenderapi.com/dashboard → Sessions → [session]                |
| Mobile app crashes                    | Console logs only (Sentry was stripped for v1; restore from git for remote tracing) |

### Add or deactivate a user

#### Via the app
Admin → Catalog → Users → **+** (or tap existing user → Deactivate). The
existing `create_app_user` + `deactivate_user` RPCs handle the underlying
auth + stock disposition atomically.

#### Via SQL (if app is broken or for batch ops)

```sql
select public.create_app_user(
  p_email := 'newagent@reda.dev',
  p_password := '...',
  p_role := 'agent',
  p_display_name := 'New Agent',
  p_phone := '+234...'
);
```

For deactivation with a stock disposition:

```sql
select public.deactivate_user(
  p_id := '<uuid>',
  p_reason := 'left the company',
  p_stock_disposition := 'warehouse'  -- or 'transfer:<other-uuid>' or 'loss'
);
```

---

## When things go wrong

### Mobile app: agent's tap doesn't seem to do anything

1. Have them pull down to refresh. The mutation might be queued offline.
2. Have them check the yellow strip above the bottom tabs. If it says
   "Offline · N queued", they're offline. Wait for the network.
3. If the strip says "N failed — tap to review", open it. They (or you)
   can retry or discard each.
4. If still stuck, sign out and back in — the queue persists in
   AsyncStorage, so the changes don't get lost.

### "Webhook fires but bot doesn't create deliveries"

In order:

1. Check `bot_shadow_mode` is `false`. If true, parsing happens but no
   delivery row.
2. Check `enable_bot_pipeline` is `true`. If false, the parser
   short-circuits.
3. Check Edge Function logs for `bot-parse-message`. Look for the most
   recent invocation.
4. Check `public.bot_inbound_messages` for the recent rows — their `status`
   tells you where the pipeline stopped (`needs_review`, `error`, etc.).

### Stock numbers look wrong

`current_stock` is a VIEW computed from `stock_adjustments` + delivered
deliveries. It can't go wrong on its own — if it's wrong, the underlying
data is wrong. Steps:

1. Pick a problem (agent, product) pair.
2. ```sql
   select sa.created_at, sa.quantity_delta, sa.reason, sa.notes
     from public.stock_adjustments sa
    where sa.agent_id = '<uuid>' and sa.product_catalog_id = '<uuid>'
    order by sa.created_at;
   ```
3. Compare to delivered deliveries:
   ```sql
   select scheduled_date, quantity_delivered, current_status
     from public.deliveries
    where assigned_agent_id = '<uuid>'
      and product_catalog_id = '<uuid>'
      and current_status = 'delivered'
    order by scheduled_date;
   ```
4. Find the missing or extra row. Fix via `create_stock_adjustment` with
   reason='correction' and a clear note. **Never** delete adjustments —
   the `client_uuid` dedup index relies on the row staying.

### Database Webhook stopped firing

1. Supabase dashboard → Database → Webhooks → click the webhook.
2. **Logs** tab — recent attempts and their HTTP status.
3. Common causes: Authorization header mismatch (used the anon key
   instead of service_role), function deployed without `--no-verify-jwt`
   on a route that doesn't speak JWT, function URL changed.

### "I need to restore an accidentally deactivated user"

```sql
select public.reactivate_user('<uuid>');
```

The user can sign in again but their stock is **not** auto-restored if
the original deactivation included a stock disposition. If you need their
stock back, run another `create_stock_adjustment` with reason='correction'
and a note describing why.

---

## Backups + disaster recovery

Supabase managed Postgres has automated nightly backups (free tier =
7 days retention). To restore in catastrophe:

1. Supabase dashboard → Database → Backups.
2. Pick a backup, click **Restore**.
3. This creates a NEW project; you'd then point the app at it by changing
   `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` in
   `mobile/.env` and rebuilding the app.

Realistically, for v1 the recovery plan for "Supabase ate the data" is:

1. Restore from backup (lose ≤24h of data).
2. Re-enter the lost day from the Google Sheet (Make.com is still writing
   to it during the cutover window — that's the entire reason we kept it
   running for a month after cutover).

---

## "What's the source of truth?"

For each thing, this is the canonical answer:

| Concept                  | Source of truth                                       |
|--------------------------|-------------------------------------------------------|
| Current stock per agent  | `public.current_stock` (view of `stock_adjustments`)  |
| Delivery state           | `public.deliveries.current_status`                    |
| History of changes       | `public.delivery_status_history` (immutable; never delete) |
| Money math (rate at time of delivery) | `deliveries.charged_snapshot` / `agent_payment_snapshot` (frozen at create time) |
| Active client/product/loc | `is_active = true` on each table                     |
| Rate-card history        | `rate_card` rows with `effective_from` / `effective_until` |
| Call state               | `public.calls.status` (`ringing/accepted/declined/cancelled/missed/completed/failed`) |
| Call audit trail         | `audit_log` rows where `entity_type='call'` (per-field diffs) |

If the app shows something different from what these queries return,
the app has a bug; trust the SQL.

---

## Internal voice calling

Lives in `public.calls` + 2 Edge Functions + `react-native-agora`/`react-native-callkeep` on the client. See PRD §5.17 and `reda_system_design_doc.md` §12 for the why; this section is the operational cheat sheet.

**Files / scripts:**

| Layer    | Where                                                  |
|----------|--------------------------------------------------------|
| Schema   | `scripts/internal-calls.sql` (idempotent, paste-and-run) |
| Smokes   | `scripts/smoke-internal-calls.sql` (BEGIN/ROLLBACK wrapped) |
| Token mint | `supabase/functions/issue-agora-token/index.ts` (5-min TTL) |
| Push fanout | `supabase/functions/send-notification/index.ts` (`call_invite` audience) |
| Mobile svcs | `mobile/src/services/calls.ts` |
| Mobile lib | `mobile/src/lib/calls/{agora,callkeep,coordinator,deviceUuid,permissions}.ts` |
| Mobile screens | `mobile/app/(call)/{team,history,call/[callId]}.tsx` |

**Secrets** (Supabase Dashboard → Edge Functions → Secrets):

| Name             | Source                                                                |
|------------------|-----------------------------------------------------------------------|
| `AGORA_APP_ID`   | https://console.agora.io → your project → App ID                     |
| `AGORA_APP_CERT` | Same project → Config → Primary Certificate (enable + copy)           |

If either is wrong, `issue-agora-token` returns 500 "server misconfigured (agora env)". Rotation = update secret + redeploy `issue-agora-token`; clients pick up the new cert on next mint, no app update needed.

**Free-tier usage to keep an eye on:**

| Resource | Budget | Expected usage | Where to check |
|---|---|---|---|
| Agora voice minutes | 10,000/mo free | ~1,200 at 5–10 staff calling daily | Agora console → Usage |
| Supabase Edge Function invocations | 500k/mo | ~10k (call mints + cron sweeps) | Supabase Dashboard → Edge Functions |
| Supabase Storage | 1 GB | **0 bytes** — audio is peer-to-peer | Supabase Dashboard → Storage |
| `net._http_response` table | grows unbounded if not pruned | bounded to 7 days by `internal-calls-prune-net-responses` cron | `select count(*) from net._http_response` |
| `pg_publication_tables` (supabase_realtime) | must include `calls` | confirmed | `select * from pg_publication_tables where pubname='supabase_realtime'` |

**Operational levers:**

- *Expire stale rings*: cron `internal-calls-expire-ringing` runs every 30s, sweeps `where status='ringing' and ringing_until < now()`. Disable: `select cron.unschedule('internal-calls-expire-ringing')`.
- *Prune pg_net responses*: cron `internal-calls-prune-net-responses` runs daily at 03:00 UTC. Same pattern to disable.
- *Re-apply schema*: `psql "$SUPABASE_DB_URI" -f scripts/internal-calls.sql` — fully idempotent.
- *Run smokes*: `psql "$SUPABASE_DB_URI" -f scripts/smoke-internal-calls.sql` — leaves no rows behind (BEGIN/ROLLBACK).

**Deploy edge functions:**
```
npx supabase functions deploy issue-agora-token --project-ref wadjlpqfpaxycspofgrc
npx supabase functions deploy send-notification --project-ref wadjlpqfpaxycspofgrc
```

**Push a JS-only update to existing 1.1.0+ APKs** (no rebuild):
```
cd mobile
npx eas update --branch preview --platform android --message "<what changed>"
```
Native changes (new SDK, new permission, new plugin) require a full rebuild — bump `app.json` version first.

**Common forensics queries:**

```sql
-- recent calls
select id, caller_id, callee_id, status, duration_seconds, created_at
from public.calls order by created_at desc limit 20;

-- field-by-field audit trail for one call
select changed_at, field_name, old_value, new_value, reason
from public.audit_log where entity_type='call' and entity_id=$1 order by changed_at;

-- push fanout failures (look here if calls aren't ringing)
select status_code, content, created
from public.recent_edge_function_failures order by created desc limit 20;

-- token issuance heartbeat
select id, last_token_issued_at from public.calls
where last_token_issued_at > now() - interval '1 hour' order by last_token_issued_at desc;
```

**When a teammate's phone won't ring:**

1. Are they signed in? `select * from public.push_tokens where user_id=<their id>` — non-zero rows expected.
2. Is the trigger firing? Insert a test call to them, check `recent_edge_function_failures` (status_code should be 200, not 4xx).
3. OEM battery-saver. Tecno/Infinix/Xiaomi/Realme aggressively kill background services. Walk them through: Settings → Apps → Reda → Battery: Unrestricted + Autostart + Display over other apps.
4. They denied "Allow Reda to manage calls" on first call. Fix: Android Settings → Apps → Reda → Permissions → Phone → Allow. (This is the CallKeep / ConnectionService permission, separate from Microphone.)

---

*Last updated: 2026-05-19 — added voice calling section. Anything you fix or learn while operating Reda, add it here.*
