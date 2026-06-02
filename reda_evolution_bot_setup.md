# Evolution Bot — Setup & Operating Guide

End-to-end instructions for running the in-house Evolution-API WhatsApp bot in **study mode** alongside the contractor's bot. Nothing in this pipeline creates deliveries — it only lands incoming WhatsApp messages in a new table so we can compare parse quality against the contractor's stream and prepare to cut over later.

---

## 1. What we built and why

### Architecture (one line)

```
Uzo's WhatsApp → Evolution API (your VPS) → evolution-webhook (Supabase edge fn) → mybot_inbound_messages (Postgres)
```

### Components

| Piece | Where it lives | What it does |
|---|---|---|
| Evolution API | Your VPS | Connects to a WhatsApp number via QR code, receives messages, POSTs them to a configurable webhook URL. |
| `evolution-webhook` | `supabase/functions/evolution-webhook/index.ts` | Receives Evolution's POSTs, authenticates, filters out noise, extracts the message text, and lands a row. |
| `mybot_inbound_messages` | Supabase Postgres (`public`) | Landing table. Stores `raw_text`, full Evolution payload, sender phone, and a stable `message_id` for dedupe. |

### Boundary: what's deliberately NOT in this pipeline

- **No Gemini call** — we don't parse the message into structured fields yet.
- **No `bot_create_delivery` call** — no row in `public.deliveries` is ever created from this pipeline.
- **No effect on the contractor's stream** — the contractor's pipeline (`bot_inbound_messages` → `bot-parse-message` → `bot_create_delivery`) is completely untouched.

If the in-house bot misfires for any reason, the contractor's bot keeps running normally. That's the whole point of the study phase.

---

## 2. Pre-requisites

Gather these before you start. None of the steps below will work without them.

| Variable | Where to get it | Example |
|---|---|---|
| `<SUPABASE_PROJECT_REF>` | Supabase dashboard URL: `https://supabase.com/dashboard/project/<ref>` | `wadjlpqfpaxycspofgrc` |
| `<EVOLUTION_WEBHOOK_SECRET>` | **You generate it** — any strong random string ≥32 chars. The same value goes on both Supabase and Evolution sides. | `5f8a9c2d8b1e3f4a6b7c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a` |
| `<EVO_URL>` | The base URL of your Evolution API instance on your VPS. | `https://evo.your-vps.com` or `http://your-vps-ip:8080` |
| `<EVO_GLOBAL_APIKEY>` | Evolution's global API key — set in Evolution's `.env` as `AUTHENTICATION_API_KEY` when you installed it. | (whatever you set) |
| `<INSTANCE_NAME>` | The Evolution instance you created and connected via QR code. | `reda-bot` |

---

## 3. Step-by-step deploy

### Step 1 — Create the landing table

Open the Supabase SQL editor for the **Reda prod project**. Paste the contents of [scripts/mybot-inbound-table.sql](scripts/mybot-inbound-table.sql) and run it.

Sanity check at the bottom of the script returns:

```
row_count | policy_count
----------+--------------
        0 |            1
```

If you see anything other than 1 policy, re-run the policy block at the bottom of the SQL.

### Step 2 — Store the webhook secret on Supabase

The edge function reads `EVOLUTION_WEBHOOK_SECRET` from Supabase's secret store.

```bash
supabase secrets set EVOLUTION_WEBHOOK_SECRET=<your-secret> \
  --project-ref <SUPABASE_PROJECT_REF>
```

(Run from the repo root. Supabase CLI must be logged in: `supabase login` once.)

### Step 3 — Deploy the edge function

```bash
supabase functions deploy evolution-webhook --no-verify-jwt \
  --project-ref <SUPABASE_PROJECT_REF>
```

`--no-verify-jwt` is correct — we authenticate via the `apikey` / `Authorization` header in code, not Supabase's JWT layer.

**Verify it's live:**

```bash
curl -I https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/evolution-webhook
```

Expect `HTTP/1.1 405 Method Not Allowed` (the function only accepts POST). If you see `404`, the deploy didn't take.

The full URL is now:

```
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/evolution-webhook
```

Write this down — you paste it into Evolution next.

### Step 4 — Tell Evolution to call that URL

Evolution needs one config update: "when a WhatsApp message arrives, POST it to my Supabase function." This is done via Evolution's admin API.

Pick the curl that matches your Evolution version. Not sure which? Hit `<EVO_URL>/manager` in a browser — v2 has a Manager UI; v1 doesn't.

**Evolution v2:**

```bash
curl -X POST "<EVO_URL>/webhook/set/<INSTANCE_NAME>" \
  -H "apikey: <EVO_GLOBAL_APIKEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/evolution-webhook",
      "byEvents": false,
      "base64": false,
      "headers": {
        "apikey": "<EVOLUTION_WEBHOOK_SECRET>",
        "Content-Type": "application/json"
      },
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

**Evolution v1:**

```bash
curl -X POST "<EVO_URL>/webhook/set/<INSTANCE_NAME>" \
  -H "apikey: <EVO_GLOBAL_APIKEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "url": "https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/evolution-webhook",
    "webhookByEvents": false,
    "events": ["messages.upsert"]
  }'
```

**Verify Evolution accepted it:**

```bash
curl "<EVO_URL>/webhook/find/<INSTANCE_NAME>" \
  -H "apikey: <EVO_GLOBAL_APIKEY>"
```

Response should show your Supabase URL and the `MESSAGES_UPSERT` event.

### Step 5 — Smoke test end-to-end

From your own phone, send a WhatsApp DM to the bot's number with text:

```
Smoke test from <your name>
```

Within a few seconds, in Supabase SQL editor:

```sql
SELECT message_id, from_phone, raw_text, received_at
  FROM public.mybot_inbound_messages
 ORDER BY received_at DESC
 LIMIT 5;
```

A row should appear with:
- `message_id` starting with `mybot-` (followed by Evolution's per-message id)
- `from_phone` = your phone number digits, no `@s.whatsapp.net` suffix
- `raw_text` = `Smoke test from <your name>`
- `received_at` = roughly now

If you see the row, the pipeline is live.

---

## 4. Troubleshooting

### Nothing lands in the table after sending a message

Check, in order:

**1. Is the edge function reachable from the internet?**

```bash
curl -I https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/evolution-webhook
```

`405` = good. `404` = function isn't deployed. `5xx` = function deployed but crashing on startup; check Supabase logs.

**2. Is Evolution actually calling it?**

On your VPS:

```bash
# pm2 install
pm2 logs evolution

# or docker
docker logs <evolution-container> --tail 100 -f
```

You should see outbound POST attempts to your Supabase URL when WhatsApp messages arrive. If Evolution isn't trying, the webhook config didn't take — re-run Step 4.

**3. Is Evolution being rejected (wrong secret)?**

Supabase dashboard → **Edge Functions** → `evolution-webhook` → **Logs**. Look for:

- `invalid signature` → `EVOLUTION_WEBHOOK_SECRET` mismatch between Supabase and Evolution config. They must be exactly equal.
- `group ignored` → you DMed from a group chat. Try a 1:1 DM.
- `fromMe ignored` → the message came from the bot's own number (Evolution echoes back). Send from a different phone.
- `no usable text` → the message had no extractable text (audio, sticker, etc). Send a plain text message.

**4. Did the row land but you don't see it?**

Check that you're querying as admin or dispatcher (the table's RLS blocks `agent` reads). If you're querying from the Supabase SQL editor, you're already on the service role and RLS doesn't apply — so the issue is elsewhere.

### "I deployed but the secret command failed"

`supabase secrets set` requires the Supabase CLI to be logged in (`supabase login`) and linked to the project (`supabase link --project-ref <ref>` once). If those are set, the command should succeed silently.

---

## 5. Useful queries while studying

**Last hour of in-house bot traffic:**

```sql
SELECT message_id, from_phone, left(raw_text, 80) AS preview, received_at
  FROM public.mybot_inbound_messages
 WHERE received_at > now() - interval '1 hour'
 ORDER BY received_at DESC;
```

**Pair in-house and contractor rows for the same source message** (rough — within 30 seconds, same sender):

```sql
SELECT m.message_id   AS mybot_id,
       b.wasender_message_id AS contractor_id,
       m.raw_text = b.raw_text AS text_identical,
       length(m.raw_text) AS my_len,
       length(b.raw_text) AS their_len,
       m.received_at,
       b.received_at
  FROM public.mybot_inbound_messages m
  JOIN public.bot_inbound_messages b
    ON b.remote_jid = m.from_phone
   AND abs(extract(epoch from (b.received_at - m.received_at))) < 30
 WHERE m.received_at > now() - interval '24 hours'
 ORDER BY m.received_at DESC;
```

When `text_identical = false` consistently, your bot's relay is producing different bytes from the contractor's — exactly the kind of evidence to bring up if the two streams diverge.

**Pure in-house traffic (no contractor pair):**

```sql
SELECT m.message_id, m.from_phone, m.raw_text, m.received_at
  FROM public.mybot_inbound_messages m
 WHERE NOT EXISTS (
   SELECT 1 FROM public.bot_inbound_messages b
    WHERE b.remote_jid = m.from_phone
      AND abs(extract(epoch from (b.received_at - m.received_at))) < 30
 )
 ORDER BY m.received_at DESC LIMIT 50;
```

These are messages your bot caught that the contractor didn't (or vice versa — flip the EXISTS direction).

---

## 6. Locking down senders (when ready)

During the initial study phase the function accepts messages from any non-group sender. When you want to restrict to Uzo (and any other admin) only:

```bash
supabase secrets set \
  EVOLUTION_ALLOWED_SENDERS="2348012345678,2348098765432" \
  --project-ref <SUPABASE_PROJECT_REF>
```

Comma-separated list of phone numbers, no `+`, no spaces, no `@s.whatsapp.net` suffix — just digits. The function reloads on the next request; no redeploy needed.

To remove the allow-list, unset the secret in Supabase dashboard → Settings → Edge Functions → Secrets.

---

## 7. Cost — what this is costing you

- **Supabase edge function**: free tier covers ~500k invocations/month. Our function runs once per inbound WhatsApp message; even at 10k messages/day you're at ~300k/month — within free.
- **Postgres storage**: each row is a few KB; 100k rows ≈ a few hundred MB. Trivial against the existing tier.
- **No Gemini, no third-party AI calls** in this pipeline — that's the contractor's bill, not ours.

The Evolution API on your VPS is whatever you're paying for the VPS itself. Nothing about this integration adds to that cost.

---

## 8. What comes next

Three phases beyond what we shipped today:

### Phase 2 — Add parse comparison

When you have enough sample messages and want to A/B the parse quality:

1. Add a `parse_result` jsonb column to `mybot_inbound_messages`.
2. Write a new edge function `mybot-parse-message` that reads queued rows, runs the same Gemini prompt as the contractor's pipeline, and writes the structured fields back.
3. Compare `parse_result` against the contractor's parsed fields side-by-side.

### Phase 3 — Cut the contractor

Once the in-house bot proves itself for ≥N days:

1. Adjust the in-house pipeline to call `bot_create_delivery` instead of stopping at the table.
2. Disable the contractor's webhook on the Evolution side (or rotate the bearer secret).
3. Tag deliveries with their origin (`source='mybot'` vs `source='contractor'`) so post-cutover audits stay clean.

We'll write that work up when we're closer to it. For now, the only thing to do is keep an eye on the table and check the pair query against the contractor's stream.

---

## 9. Files touched

| Path | What it is |
|---|---|
| [`scripts/mybot-inbound-table.sql`](scripts/mybot-inbound-table.sql) | Postgres schema for `mybot_inbound_messages`. Paste once. |
| [`supabase/functions/evolution-webhook/index.ts`](supabase/functions/evolution-webhook/index.ts) | The edge function. Deployed via `supabase functions deploy`. |
| [`reda_evolution_bot_setup.md`](reda_evolution_bot_setup.md) | This file. |

Nothing else in the repo was modified for this work.
