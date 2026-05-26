# Reda — Inbound Message Intake Contract

This document is the integration contract for any external WhatsApp/SMS
automation provider that needs to forward customer messages to Reda for
parsing and downstream delivery creation.

You will **not** be writing into our `deliveries` table directly. The contract
is intentionally narrow:

> POST one HTTPS request per inbound WhatsApp message. We handle the rest.

After we receive your POST we do the AI extraction (Gemini), product matching
against our catalog, address geocoding (Google Maps), and conditional delivery
creation behind feature flags. None of that is your concern.

---

## Endpoint

```
POST https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/inbound-message
```

Headers:

```
Authorization: Bearer <BOT_INBOUND_SECRET>
Content-Type:  application/json
```

`BOT_INBOUND_SECRET` is a single shared secret string we will hand you out of
band (signal, password manager — not over email/chat). If we rotate it, you'll
get a new one the same way and you flip your env var.

## Request body

Minimal (we run our own AI to parse):

```json
{
  "from_phone":  "+2348012345678",
  "text":        "Hi pls deliver 2 Toothpaste to Mr Adeyemi 08012345678, 14 Allen Avenue Ikeja, ₦5000",
  "received_at": "2026-05-14T09:31:22Z"
}
```

Full (you've already parsed it — we skip our AI call, trust your fields):

```json
{
  "from_phone":  "+2348018941678",
  "text":        "Hi pls deliver 2 Toothpaste to Mr Adeyemi 08012345678, 14 Allen Avenue Ikeja, ₦5000",
  "received_at": "2026-05-14T09:31:22Z",

  "parsed": {
    "customer_name":   "Mr Adeyemi",
    "customer_phone":  "+2348012345678",
    "raw_address":     "14 Allen Avenue, Ikeja, Lagos",
    "location":        "Ikeja",
    "product_name":    "Toothpaste",
    "quantity":        2,
    "customer_price":  5000,
    "assigned_agent":  "Audrey"
  },

  "client_hint": "Dentora",
  "message_id":  "wamid.HBgL2348012345678VAgARgg5xxxx"
}
```

### Required fields

| Field          | Type                  | Notes                                                                   |
|----------------|-----------------------|-------------------------------------------------------------------------|
| `from_phone`   | string                | The **WhatsApp sender's** phone — i.e. whoever's number appears in the inbound WhatsApp metadata. In Reda's flow this is usually Uzo or a forwarding client, **not** the end customer. The customer's phone lives inside the message body and is extracted into `parsed.customer_phone`. E.164 preferred (`+2348012345678`). Stored verbatim. |
| `text`         | string                | The raw message body. Plain text, no markdown / no media — if the customer sent an image with a caption, send us the caption. If they sent only an image with no text, skip the message (we can't parse images yet). |

### Optional fields

| Field          | Type                  | Notes                                                                   |
|----------------|-----------------------|-------------------------------------------------------------------------|
| `message_id`   | string                | Globally unique per inbound WhatsApp message. Used for dedupe — sending the same id twice is a no-op, not an error. If your provider exposes one (e.g. `wamid.…`), pass it. **If you don't have one, omit the field**: we'll derive a deterministic dedupe key as `sha256(received_at + from_phone + text)`, so identical retries still dedupe automatically; only meaningfully different payloads will land new rows. |
| `received_at`  | string (ISO 8601 UTC) | When the customer sent it. Defaults to "now" if omitted. Including it is strongly preferred — it's an input to the dedupe hash when `message_id` is absent, and retries shouldn't skew the stored timestamp. |
| `parsed`       | object                | Your pre-parsed structured fields (see schema below). If present and contains at least `product_name`, **we skip our own Gemini extraction** and use your values directly. If absent or unusable, we fall back to our own AI. |
| `client_hint`  | string                | Best guess at which Reda client this delivery is for (e.g. `"Dentora"`, `"Gizmomart"`). Used to disambiguate products that exist under multiple clients. Case-insensitive. Ignored if no client by that name exists. |

### `parsed` schema

| Field             | Type             | Notes                                                                |
|-------------------|------------------|----------------------------------------------------------------------|
| `customer_name`   | string \| null   | Recipient's name.                                                    |
| `customer_phone`  | string \| null   | Recipient's phone. Any format; we normalise.                         |
| `raw_address`     | string \| null   | Delivery address, free-form (e.g. street + landmark). Stored on the delivery for the field agent to read. |
| `location`        | string \| null   | The Reda neighbourhood/district this address falls under (e.g. `"Ikeja"`, `"Surulere"`, `"Lekki Phase 1"`). If you provide this and the value matches an active row in our `locations` table (by name or alias, case-insensitive), **we skip the Maps + Gemini address-resolution step entirely** and use your match at `'high'` confidence. If the value doesn't match anything we know, we fall back to our own pipeline (which geocodes `raw_address`). One Lagos neighbourhood per delivery. |
| `product_name`    | string           | The product the customer is ordering. **Required if `parsed` is present** — without it we fall back to AI. We do trigram matching against Reda's `product_catalog` to find the canonical row. |
| `quantity`        | number \| null   | Integer ≥ 1. Defaults to 1 if missing. |
| `customer_price`  | number \| null   | Naira amount, digits only. |
| `assigned_agent`  | string \| null   | Pre-assign the delivery to a specific Reda agent. Accepts display name (case-insensitive), email, or phone — we'll resolve to the matching active agent. **Only honored if it resolves to exactly one agent**; ambiguous or unknown values are silently ignored and the delivery goes to auto-assignment as usual. The raw value and resolution outcome (`resolved` / `no_match` / `ambiguous`) are stored in `bot_inbound_messages.parse_result` for visibility. |

Everything else you send (provider name, raw envelope, media URLs, your parser version string, etc) we ignore at the application layer — but the whole body is stored in our `raw_payload` jsonb column, so feel free to include anything you want preserved for debugging.

## Responses

| Status              | Meaning                                                                                  | What you do                            |
|---------------------|------------------------------------------------------------------------------------------|----------------------------------------|
| `200 ok`            | Accepted. Either inserted or already-seen (idempotent on `message_id`). Don't retry.     | Mark message as forwarded. Done.       |
| `400 invalid json`  | Body didn't parse as JSON.                                                               | Bug on your end. Don't retry blindly. |
| `400 missing …`     | Required field missing or wrong type.                                                    | Bug on your end.                       |
| `401 invalid signature` | Wrong/missing `Authorization: Bearer …`.                                            | Check your secret env var.             |
| `500 …`             | Our side is broken.                                                                      | Retry with exponential backoff (1s → 5s → 30s, then give up + alert). |

There's no signature verification (no HMAC) — just the shared secret in the
Authorization header. We use TLS for transport security and timing-safe
comparison server-side.

## What happens after your POST

For your visibility (not anything you need to act on):

1. We insert a row into `public.bot_inbound_messages` with `status='queued'`.
2. A Postgres trigger fires our `bot-parse-message` Edge Function.
3. That function calls **Gemini 2.5-flash** to extract: customer name, phone,
   raw address, product name, quantity, customer price.
4. We fuzzy-match the product name against our `product_catalog` using pg_trgm.
5. We fuzzy-match + Maps-geocode the address against our active `locations`.
6. If feature flag `bot_shadow_mode` is **on** (the safe default), we stop here
   — the parse result is visible in our admin app's "Review" tab. No delivery
   is created.
7. If `bot_shadow_mode` is **off** and the parse meets our confidence floors,
   we call `bot_create_delivery` to insert a real row into `public.deliveries`.

Typical end-to-end latency from your POST to step 7: **2–5 seconds.**

## Sample cURL

```bash
curl -X POST https://wadjlpqfpaxycspofgrc.supabase.co/functions/v1/inbound-message \
  -H "Authorization: Bearer $BOT_INBOUND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "from_phone":  "+2348012345678",
    "text":        "Hi pls deliver 2 Toothpaste to Mr Adeyemi 08012345678, 14 Allen Avenue Ikeja, ₦5000",
    "received_at": "2026-05-14T09:31:22Z"
  }'
```

Expected: `200 ok` (empty body). Re-send the exact same payload: still
`200 ok`, but no duplicate row created — the auto-derived dedupe hash
catches the retry.

## Operational expectations

- **Don't replay messages aggressively.** We dedupe (either on your `message_id`
  if supplied, or on `sha256(received_at + from_phone + text)` if not), but
  retries waste your bandwidth and our compute. Retry only on `5xx` or network
  timeout, with exponential backoff.
- **Order doesn't matter.** Out-of-order arrivals are fine — we don't assume
  monotonic ordering.
- **Volume.** Reda processes maybe 50–200 messages/day at present, peaks ~500.
  No rate limiting on our side at this scale; please don't burst >10 req/s
  sustained.
- **Privacy.** Customer phone numbers and addresses are PII. Don't log
  `text` or `from_phone` in any shared system; we already log them inside our
  own audit trail.

## For Reda admins reading this

Reference of the deliveries schema (what our pipeline writes to **after**
your message lands and parses):

| Column                  | Type      | Origin                                       |
|-------------------------|-----------|----------------------------------------------|
| id                      | uuid      | auto                                         |
| client_id               | uuid      | resolved from product match                  |
| product_catalog_id      | uuid      | resolved from product match (Gemini → pg_trgm) |
| location_id             | uuid      | resolved from address match (Gemini + Maps)  |
| customer_name           | text      | Gemini extract                               |
| customer_phone          | text      | Gemini extract                               |
| raw_address             | text      | Gemini extract                               |
| quantity_ordered        | integer   | Gemini extract                               |
| customer_price          | numeric   | Gemini extract                               |
| current_status          | text      | defaults to `'pending'`                      |
| scheduled_date          | date      | defaults to today (Lagos)                    |
| created_via             | text      | always `'bot'` for this path                 |
| bot_raw_message         | text      | full original `text` field, for traceability |
| charged_snapshot        | numeric   | computed from `current_rate_for_location()`  |
| agent_payment_snapshot  | numeric   | computed from `current_rate_for_location()`  |
| assigned_agent_id       | uuid?     | null until auto-assign / manual assign runs  |
| created_at / updated_at | timestamptz | auto                                       |

Created via SQL function `public.bot_create_delivery(...)` — admin only, called
from the parser Edge Function under feature-flag control.
