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

## 6. Group-only intake (current behaviour)

The function only accepts messages from the configured Reda admin group chat. Direct DMs, other groups, and bot self-echoes are dropped.

**Discovery mode** — when `REDA_GROUP_JID` is unset, every group JID seen is logged with the prefix `discovery: group_jid seen`. Send a message in the Reda group, find the JID in the function logs, then pin it:

```bash
supabase secrets set \
  REDA_GROUP_JID="<the-jid-including-@g.us>" \
  --project-ref <SUPABASE_PROJECT_REF>
```

The function reloads on the next request — no redeploy needed. Anything not from that exact JID returns 200 with `group not allowed` in logs.

---

## 7. Cost — what this is costing you

- **Supabase edge function**: free tier covers ~500k invocations/month. Our function runs once per inbound WhatsApp message; even at 10k messages/day you're at ~300k/month — within free.
- **Postgres storage**: each row is a few KB; 100k rows ≈ a few hundred MB. Trivial against the existing tier.
- **No Gemini, no third-party AI calls** in this pipeline — that's the contractor's bill, not ours.

The Evolution API on your VPS is whatever you're paying for the VPS itself. Nothing about this integration adds to that cost.

---

## 8. Phase 2 — AI extraction (now shipped)

Each new row in `mybot_inbound_messages` is automatically parsed by Kimi (default `moonshotai/kimi-k2.5` via OpenRouter), product-matched against the catalog **once per line item**, and address-resolved through the Maps-backed `normalize-address` pipeline. The structured result is stored in `parse_result` on the same row. **Nothing creates deliveries.** The pipeline stops at the parsed row so we can compare extraction quality without polluting `public.deliveries`.

The prompt asks Kimi for an **array of line items**, capturing multi-product orders in full. `parse_result.extracted` now has the shape:

```jsonc
{
  "customer_name":  "...",
  "customer_phone": "...",
  "raw_address":    "...",
  "total_amount":   55000,                 // null if the message has no "Total(X)" line
  "products": [
    { "product_name": "Sp6",              "quantity": 2, "customer_price": 32000 },
    { "product_name": "Whitening strips", "quantity": 1, "customer_price": 23000 }
  ]
}
```

`parse_result.product_matches` is a parallel array — one entry per line item — each holding `{ line, match, candidates }` (same disambiguation rules as the old single-product matcher, just applied per line). `parse_result.client_id_conflict` flags rows where line items resolved to different `client_id`s — should always be `false` since one forward = one Reda client; a `true` is a signal to investigate the row.

**Prompt divergence note**: the contractor's `bot-parse-message` still asks for a single product and silently drops extras. Mybot now asks for an array. That means two axes vary between the streams (LLM choice AND prompt), not one — the headline study metric is no longer "diff the parsed shape" but **"how many products did mybot extract vs the contractor's 1"**. The query below makes that explicit.

### Deploy Phase 2

**Step 1 — Add the columns and trigger** (Supabase SQL editor):

Paste [`scripts/mybot-parse-trigger.sql`](scripts/mybot-parse-trigger.sql). The sanity SELECTs at the bottom should show four new columns (`parse_status`, `parse_result`, `processed_at`, `error_text`) and one new trigger (`mybot_parse_on_insert`).

**Step 2 — Set the OpenRouter key**. Sign up at [openrouter.ai](https://openrouter.ai) → API keys → create one for this project. Top up enough credit for the rough study volume (Kimi via OpenRouter is ~$0.30 / 1M input tokens, ~$2.50 / 1M output — pennies at study scale).

```bash
supabase secrets set OPENROUTER_API_KEY=<your-openrouter-key> \
  --project-ref <SUPABASE_PROJECT_REF>
```

The contractor's `bot-parse-message` keeps using `GEMINI_API_KEY` — leave that secret alone. The two functions read separate env vars.

**Optional — override the model without redeploying**: insert a row into `ai_config` and the function picks it up on its next invocation. Useful for swapping Kimi for a different OpenRouter slug mid-study. The value column is `jsonb`, so wrap the slug as a JSON string.

```sql
-- pick any OpenRouter-supported slug; default is moonshotai/kimi-k2.5
INSERT INTO public.ai_config (key, value)
VALUES ('openrouter_model', '"moonshotai/kimi-k2.5"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

**Step 3 — Deploy the parser**:

```bash
supabase functions deploy mybot-parse-message \
  --project-ref <SUPABASE_PROJECT_REF>
```

(Note: no `--no-verify-jwt` — this function is called by the DB trigger with the service-role JWT, which Supabase's gateway needs to verify.)

**Step 4 — Backfill existing rows** (the trigger only fires on INSERT going forward):

```sql
-- Force-parse the rows that landed before the trigger was installed.
-- Run once after Step 3.
SELECT net.http_post(
  url    := 'https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/mybot-parse-message',
  headers:= '{"Content-Type":"application/json","Authorization":"Bearer <service-role-jwt>"}'::jsonb,
  body   := jsonb_build_object('inbound_message_id', id)
)
  FROM public.mybot_inbound_messages
 WHERE parse_status = 'pending';
```

The service-role JWT is the same one used by the `mybot_parse_on_insert` trigger — copy it from there.

### Multi-product visibility — the headline study metric

How many parsed rows had more than one product? The gap vs the contractor's stream is, by construction, the silent data loss on production today:

```sql
-- mybot rows by line-item count
SELECT jsonb_array_length(parse_result->'extracted'->'products') AS line_items,
       count(*)                                                  AS rows
  FROM public.mybot_inbound_messages
 WHERE parse_status = 'parsed'
 GROUP BY line_items
 ORDER BY line_items;
```

### Side-by-side: mybot vs contractor on the same source message

The contractor pipeline stores its parsed result in `bot_inbound_messages.parse_result`. Match rows on `raw_text` within a 30-second `received_at` window, then surface the product-count gap plus the per-line names:

```sql
SELECT m.message_id  AS mybot_id,
       b.wasender_message_id AS contractor_id,
       jsonb_array_length(m.parse_result->'extracted'->'products') AS mybot_product_count,
       1                                                            AS contractor_product_count,
       m.parse_result->'extracted'->'products'                      AS mybot_products,
       b.parse_result->'product'->>'product_name'                   AS contractor_product,
       m.parse_result->'extracted'->>'total_amount'                 AS mybot_total,
       m.parse_result->'address'->>'confidence'                     AS mybot_loc_conf,
       b.parse_result->'address'->>'confidence'                     AS contractor_loc_conf,
       coalesce((m.parse_result->>'client_id_conflict')::boolean, false) AS mybot_client_conflict
  FROM public.mybot_inbound_messages m
  JOIN public.bot_inbound_messages   b
    ON abs(extract(epoch from (b.received_at - m.received_at))) < 30
   AND b.raw_text = m.raw_text
 WHERE m.parse_status = 'parsed'
   AND b.status IN ('parsed','created_delivery','needs_review','shadow_only')
 ORDER BY mybot_product_count DESC, m.received_at DESC
 LIMIT 50;
```

Rows where `mybot_product_count > 1` are the cases the contractor's stream silently truncated. Cross-check the names in `mybot_products` against the raw text to confirm Kimi got them right — that's the per-line accuracy spot-check.

## 9. Phase 3 — Cut the contractor (later)

When the in-house bot proves itself:

1. Wire the parser to call `bot_create_delivery` when all fields resolve.
2. Disable the contractor's webhook on the Evolution side (or rotate the bearer secret).
3. Tag deliveries with their origin so post-cutover audits stay clean.

Not started — separate ship when we're confident.

---

## 10. Files touched

| Path | What it is |
|---|---|
| [`scripts/mybot-inbound-table.sql`](scripts/mybot-inbound-table.sql) | Postgres schema for `mybot_inbound_messages`. Paste once. |
| [`scripts/mybot-parse-trigger.sql`](scripts/mybot-parse-trigger.sql) | Phase 2 columns + trigger. Paste after the parser is deployed. |
| [`supabase/functions/evolution-webhook/index.ts`](supabase/functions/evolution-webhook/index.ts) | Webhook receiver. Deployed via `supabase functions deploy`. |
| [`supabase/functions/mybot-parse-message/index.ts`](supabase/functions/mybot-parse-message/index.ts) | Phase 2 parser. Deployed via `supabase functions deploy`. |
| [`reda_evolution_bot_setup.md`](reda_evolution_bot_setup.md) | This file. |

Nothing else in the repo was modified for this work.
