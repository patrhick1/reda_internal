# Phase 8 — Bot Pipeline Deployment Guide

**Goal:** take the Phase 8 code (already written, schema already applied) and
make it live, so a WhatsApp message forwarded to the Reda Wasender session ends
up parsed and visible in the Admin → Review tab. Everything stays in **shadow
mode** by default — the bot will not create real deliveries until you flip the
flag.

This doc is a step-by-step setup, not a design doc. Read it once end-to-end
first, then work top to bottom.

---

## What's already done (don't redo)

- ✅ Schema: `feature_flags`, `ai_config`, `bot_inbound_messages` tables,
  `address_match_log.delivery_id` nullable. All applied via
  [scripts/phase8-schema.sql](scripts/phase8-schema.sql).
- ✅ RPCs: `bot_create_delivery`, `match_products_by_text`,
  `mark_inbound_processed`, `set_feature_flag`, `get_flag`, `get_ai_config`.
  Applied via [scripts/phase8-bot-rpcs.sql](scripts/phase8-bot-rpcs.sql).
- ✅ Edge Function source files in [supabase/functions/](supabase/functions/):
  `wasender-webhook`, `normalize-address`, `bot-parse-message`.
- ✅ Admin UI: [mobile/app/(admin)/needs-review.tsx](mobile/app/(admin)/needs-review.tsx)
  and [mobile/app/(admin)/flags.tsx](mobile/app/(admin)/flags.tsx).
- ✅ **Initial** flag state on the DB: `enable_bot_pipeline=false`,
  `enable_address_normalization=false`, `bot_shadow_mode=true`. **Safe.**

> **Update (2026-05-15) — bot is now live.** After verifying a complete
> contractor payload (`Gina` / `Gbagada` / `Queen Favour`) ran cleanly
> through the shadow pipeline end-to-end, the flags were flipped to
> `enable_bot_pipeline=true`, `enable_address_normalization=true`,
> `bot_shadow_mode=false`. Real deliveries now flow from the external
> WhatsApp specialist's webhook. The "Going from shadow → live" section
> below still applies as the **rollback** procedure if anything regresses
> — flipping `bot_shadow_mode` back to `true` immediately reverts the
> pipeline to parse-but-don't-create.

## What this guide covers

1. Get the 3 third-party API keys.
2. Set them as Supabase Function secrets.
3. Deploy the 3 edge functions.
4. Reconnect the Wasender WhatsApp session and wire the webhook URL + secret.
5. Wire the Supabase Database Webhook that fires the parser.
6. Smoke test: send a WhatsApp message, see a row appear.
7. Flag-flip schedule for going from shadow → live.

Total time: **45–90 minutes**, most of it waiting on Google's "enable this
API" pages.

---

## Pre-flight checklist

Open these tabs now; you'll bounce between them:

- [Supabase dashboard](https://supabase.com/dashboard) → your project
- [Google AI Studio](https://aistudio.google.com/apikey) (for Gemini key)
- [Google Cloud Console](https://console.cloud.google.com/) (for Maps key)
- [Wasender dashboard](https://wasenderapi.com/dashboard) (the one in your
  screenshot)
- A terminal in the repo root.

Confirm the Supabase CLI is logged in:

```powershell
supabase --version
supabase projects list
```

If `supabase projects list` shows nothing, run `supabase login` and paste the
token from the dashboard. The CLI is what `supabase functions deploy` uses.

---

## Step 1 — Get the three API keys

### 1a. Gemini API key (Google AI Studio)

1. Go to https://aistudio.google.com/apikey.
2. Sign in with the Google account you want Reda to bill against (probably
   the same one that owns the Reda Google Sheet — convenient but not required).
3. Click **"Create API key"** → choose **"Create API key in new project"**
   (call the project `reda-bot` so it's recognisable). Or pick an existing
   project if you have one for Reda.
4. Copy the key (starts with `AIza...`). **Treat it like a password.**

Free tier on Gemini 2.5-flash is generous (15 requests/minute, 1500/day at
time of writing) — plenty for Reda's volume. Set a budget alert in Google
Cloud later if you're worried.

### 1b. Google Maps Geocoding API key

This one is in the regular Google Cloud Console, not AI Studio. Two distinct
products — even though they're both Google.

1. https://console.cloud.google.com/ → top-bar project dropdown → **same
   project** you used for Gemini (or a new one — doesn't matter).
2. **APIs & Services → Library** → search **"Geocoding API"** → click it →
   **Enable**.
3. **APIs & Services → Credentials** → **Create credentials → API key**.
4. Copy the key (also starts with `AIza...`, different from the Gemini one).
5. Click **"Restrict key"** (recommended): under **API restrictions**, pick
   **"Restrict key"** and tick only **Geocoding API**. Save. This means if the
   key ever leaks, the attacker can only burn your geocoding quota, not your
   whole Google account.
6. Maps requires **billing enabled** on the Cloud project even for free-tier
   usage. If you haven't, **Billing → Link a billing account** and add a card.
   First $200/mo of Maps is free. Reda will not come close to that limit.

### 1c. Wasender API key & Webhook Secret

The Wasender API key is per-session, found inside your existing session.

1. In the Wasender dashboard (your screenshot), click **Sessions** in the left
   nav.
2. The session that's currently `Logged Out: 1` — click it.
3. Somewhere on the session page you'll see the **API key**. Copy it.
4. **Reconnect the session** (this is what "Logged Out" means — it's no longer
   linked to a phone): click **"Connect"** or **"Show QR"**. Scan with the
   Reda WhatsApp's "Linked devices" feature on the phone that holds the
   business WhatsApp account. The status flips to **"Connected"**.
   - If you don't reconnect, no inbound messages will reach our webhook —
     Wasender has nothing to forward.

For the **Webhook Secret**: this is a value *you* invent and paste into both
Wasender and Supabase. Generate one now:

```powershell
# Random 32-char secret. Copy the output, you'll use it in Step 2 and Step 4.
[System.Web.Security.Membership]::GeneratePassword(32, 0)
```

Or in any shell: `openssl rand -hex 32`. **Save this string somewhere safe** —
you'll paste it into Wasender (Step 4) and Supabase (Step 2). They must
match exactly.

---

## Step 2 — Set Supabase Function secrets

Three keys plus the webhook secret. From the repo root:

```powershell
supabase secrets set GEMINI_API_KEY=AIza...your-gemini-key
supabase secrets set GOOGLE_MAPS_API_KEY=AIza...your-maps-key
supabase secrets set WASENDER_API_KEY=...your-wasender-api-key
supabase secrets set WASENDER_WEBHOOK_SECRET=...the-secret-you-generated
```

Verify:

```powershell
supabase secrets list
```

You should see all four (plus the auto-provided `SUPABASE_URL` /
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL`).

> **Don't put these in `.env` or anywhere in the repo.** They live in
> Supabase's secret store and the Deno runtime reads them at request time.
> If you ever rotate one, you re-run `supabase secrets set` — never touch the
> code.

---

## Step 3 — Deploy the three Edge Functions

Order matters slightly: the parse function depends on the webhook landing
messages, and on normalize-address being callable. Deploy all three; the
order of these three deploys doesn't actually matter, but I'd do webhook
last (so accidental early traffic has nowhere to land).

```powershell
# normalize-address — called by bot-parse-message via supabase.functions.invoke
supabase functions deploy normalize-address

# bot-parse-message — called by the Supabase Database Webhook (Step 5)
supabase functions deploy bot-parse-message

# wasender-webhook — called by Wasender. The --no-verify-jwt flag is critical:
# Wasender doesn't speak Supabase JWT, so we let the request through and rely
# on our own X-Webhook-Signature check inside the function.
supabase functions deploy wasender-webhook --no-verify-jwt
```

Each command takes 15–30 seconds. On success you'll see "Deployed Function ...
on project ...".

**Quick health check** — verify each function responds:

```powershell
# Should return 405 Method not allowed (because we GET, function only takes POST)
curl -i https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/wasender-webhook

# Should return 401 invalid signature (proves the signature check runs)
curl -i -X POST `
  -H "x-webhook-signature: wrong" `
  -H "content-type: application/json" `
  -d '{"event":"messages.received"}' `
  https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/wasender-webhook
```

If you get `404 Function not found`, the deploy didn't take — try again. If
you get `500 server misconfigured`, the secrets aren't set — go back to Step 2.

---

## Step 4 — Configure the Wasender webhook

Back in https://wasenderapi.com/dashboard.

1. Click **Sessions** → click your session.
2. Find the **Webhook URL** field. Paste:
   ```
   https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/wasender-webhook
   ```
3. Find the **Webhook Secret** field. Paste the **same** random string you
   generated in Step 1c and set as `WASENDER_WEBHOOK_SECRET` in Step 2.
4. **Webhook Events** — make sure `messages.received` is enabled. Disable
   anything else you don't need (e.g. `messages.sent`, `messages.upsert`),
   our function ignores them but it saves noise.
5. **Save**.
6. If Wasender exposes a **"Test webhook"** button, click it. You should see
   a 200 response in their UI. (If not, that's fine — the smoke test in Step
   6 covers it.)

> If the session isn't **Connected** to a WhatsApp phone yet (the dashboard
> still shows "Logged Out"), no real messages will arrive. Reconnect by
> scanning the QR with WhatsApp → Linked devices on the Reda business phone.

---

## Step 5 — Wire the Supabase Database Webhook

This is the trigger that fires `bot-parse-message` whenever the webhook lands
a new row in `bot_inbound_messages`. Same mechanism as the existing
`send-assignment-push` setup from Phase 5.

In the Supabase dashboard:

1. **Database → Webhooks** in the left nav (under "Configuration").
2. **Create a new hook**.
3. Fill in:
   - **Name:** `bot_parse_on_insert`
   - **Table:** `bot_inbound_messages` (schema `public`)
   - **Events:** ✅ **Insert** only (leave Update/Delete unticked)
   - **Type:** **HTTP Request**
   - **Method:** `POST`
   - **URL:** `https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/bot-parse-message`
   - **HTTP Headers** — click **Add header** twice:
     - `Content-Type` → `application/json`
     - `Authorization` → `Bearer <SERVICE_ROLE_KEY>` (paste the actual service
       role key from **Project Settings → API → service_role**; it's a long
       JWT starting with `eyJ...`)
   - **HTTP Parameters / Body:** leave defaults (Supabase auto-sends
     `{ type, table, record, old_record, schema }`).
4. **Confirm** / **Create**.

> Why the service role key in the header? `bot-parse-message` is deployed
> *with* JWT verification on (only `wasender-webhook` skipped it). The DB
> webhook needs an Authorization that Supabase will accept. Service role is
> the right choice — it's a server-to-server call inside Supabase's own
> infrastructure.

---

## Step 6 — Smoke test

Two ways. Do at least one. Both, ideally.

### 6a. Synthetic webhook (proves the plumbing, no WhatsApp needed)

```powershell
$body = @'
{
  "event": "messages.received",
  "timestamp": 1715600000,
  "data": {
    "messages": {
      "key": {
        "id": "TEST-SMOKE-001",
        "fromMe": false,
        "remoteJid": "2348012345678@s.whatsapp.net"
      },
      "messageBody": "Hello, please deliver 2 Toothpaste to Mr Adeyemi 08012345678, 14 Allen Avenue Ikeja, ₦5000",
      "message": { "conversation": "Hello, please deliver 2 Toothpaste to Mr Adeyemi 08012345678, 14 Allen Avenue Ikeja, ₦5000" }
    }
  }
}
'@

curl -i -X POST `
  -H "x-webhook-signature: <THE-SAME-SECRET-YOU-SET>" `
  -H "content-type: application/json" `
  -d $body `
  https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/wasender-webhook
```

You should get `200 ok`. Then verify a row landed:

```powershell
node scripts/db.mjs -c "select id, status, processed_at, raw_text, error_text from public.bot_inbound_messages where wasender_message_id = 'TEST-SMOKE-001';"
```

Expected: one row, `status = 'shadow_only'` (parser ran successfully but
shadow mode prevented delivery creation), `processed_at` populated,
`parse_result` (jsonb) filled in. Look at parse_result:

```powershell
node scripts/db.mjs -c "select jsonb_pretty(parse_result) from public.bot_inbound_messages where wasender_message_id = 'TEST-SMOKE-001';"
```

You should see Gemini's extraction — customer name, phone, address, product,
quantity, price — plus the product match score and the address normalization
result.

### 6b. Real WhatsApp message (proves the full path)

1. Make sure the Wasender session is **Connected** (Step 4 caveat).
2. From any WhatsApp account that's allowed to message the Reda business
   number, forward or type a realistic delivery message.
3. Run the same select query, but for the latest row:
   ```powershell
   node scripts/db.mjs -c "select wasender_message_id, status, raw_text, error_text from public.bot_inbound_messages order by received_at desc limit 1;"
   ```

Open the **Reda app → Admin → Review tab → Shadow** sub-tab. The message
should appear in the list, expandable to show the parse breakdown.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Webhook returns `401 invalid signature` for the smoke test | The `x-webhook-signature` header doesn't match `WASENDER_WEBHOOK_SECRET` | Regenerate, re-set both, retry |
| Webhook returns `500 server misconfigured` | A secret is missing (`WASENDER_WEBHOOK_SECRET`, or `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`) | `supabase secrets list` to confirm; re-run `supabase secrets set` for the missing one |
| Row lands with `status='error'` and `error_text='GEMINI_API_KEY not configured'` | Self-explanatory | `supabase secrets set GEMINI_API_KEY=...`, then `supabase functions deploy bot-parse-message` (functions need a redeploy to pick up new secrets on some Supabase tier configurations — try invoking again first; redeploy only if it doesn't pick up) |
| Row lands with `status='error'` and Gemini complains about quota | You've hit the free-tier RPM limit | Wait 60s; or upgrade Gemini quota in AI Studio |
| Row lands with `status='error'` and `error_text` mentions Maps | Geocoding API not enabled, or billing not linked on the Google Cloud project | Re-do Step 1b. Geocoding has a quirk: the API is technically separate from the key; both must be present |
| Row lands with `status='shadow_only'` but `parse_result.product` is null | Gemini extracted the product name but our trgm match couldn't find it in `product_catalog`. Either the product name in the message doesn't resemble any catalog entry, or `product_match_min_similarity` in `ai_config` is too strict | Lower the threshold: `update public.ai_config set value='0.3'::jsonb where key='product_match_min_similarity';` (or add the missing product to the catalog) |
| Row lands with `status='shadow_only'` and `parse_result.address.matched_location_id` is null | Either `enable_address_normalization=false` (intended), or Gemini couldn't pick a location | Flip `enable_address_normalization` to `true` from the Admin → Flags tab, then send a new test |
| `bot_parse_on_insert` webhook fires but returns 401 | The Authorization header in the DB Webhook config is wrong | Re-check that it's `Bearer <service-role-key>`, not the anon key |
| Wasender's "test webhook" works but real messages don't appear | Session is still "Logged Out" | Scan the QR to reconnect |

**Where to look for logs:**

- Edge Function logs: Supabase dashboard → **Edge Functions → [function name] → Logs**.
  Each invocation is one row. Click in for stdout/stderr + the request body.
- Database Webhook firings: **Database → Webhooks → [webhook] → Logs**.
- Wasender's own delivery log: Wasender dashboard → Sessions → [session] →
  webhook attempts.

---

## Going from shadow → live

Once you've seen 20–30 real shadow-only rows and Uzo agrees the parses look
right (correct product, correct location at high confidence most of the
time), you can start flipping flags. **In this order:**

1. **Flip `enable_address_normalization` first.** This costs you Maps + Gemini
   API calls but doesn't create any deliveries yet. Watch the
   `address_match_log` table for a few days:
   ```sql
   select confidence, count(*)
     from public.address_match_log
    where matched_at > now() - interval '7 days'
    group by confidence
    order by confidence;
   ```
   You want >80% in `high` + `medium` combined. If you're seeing too much
   `none`, look at the misses — usually the fix is adding aliases to
   `locations.aliases` rather than tuning the AI.

2. **Flip `enable_bot_pipeline` while `bot_shadow_mode` is still on.** Same
   effect as before (no deliveries), but proves the master switch works.

3. **Flip `bot_shadow_mode` to false.** Now real bot deliveries get created.
   The first day, **watch Admin → Deliveries with `created_via='bot'`
   closely**:
   ```sql
   select scheduled_date, customer_name, location_id, current_status
     from public.deliveries
    where created_via = 'bot'
      and created_at > now() - interval '1 day'
    order by created_at desc;
   ```

4. **If anything looks off, flip `bot_shadow_mode` back to true** from the
   Flags tab. Bot deliveries already created stay (they're real); future
   messages go back to shadow until you fix what's wrong.

This is the same flag-flip discipline as the rest of the phased plan: ship
the safe state first, observe, flip when boring.

---

## What this guide does *not* cover (deferred)

- **One-click resolve from Needs Review into a real delivery.** The Review
  screen lets admin see what got parsed; the resolution flow (open the
  existing New Delivery form with the parse pre-filled) is a Phase 8.5b
  follow-up.
- **Wasender outbound** (sending confirmations back to the client channel).
  Helper not built. We'll add `wasender-send-message` only when there's a
  concrete use for it.
- **Prompt versioning UI.** Prompts are constants in the function source
  (search `PROMPT_VERSION` in [supabase/functions/](supabase/functions/)).
  Editing a prompt = edit the file, redeploy. Good enough for v1.
- **Rate-limiting / abuse protection on `wasender-webhook`.** Wasender
  itself doesn't replay aggressively, and the unique index on
  `wasender_message_id` dedupes anything that slips through. Add a leaky
  bucket later if it ever matters.

---

*Last updated: 2026-05-13. If something in this guide is wrong, fix it in
the same PR as the code change that broke it — operational docs rot faster
than code.*
