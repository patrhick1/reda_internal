// Edge Function: inbound-message
// Provider-agnostic intake for WhatsApp / SMS messages. Any external bot or
// automation service POSTs here with a small JSON payload and a shared secret;
// we land the message in public.bot_inbound_messages and let the existing
// DB-webhook-driven parser (bot-parse-message) handle Gemini extraction,
// product matching, location matching, and (when flags are flipped) delivery
// creation.
//
// Contract:
//   POST /functions/v1/inbound-message
//   Authorization: Bearer <BOT_INBOUND_SECRET>
//   Content-Type: application/json
//   {
//     "message_id":  string  (optional — see dedupe note below),
//     "from_phone":  string  (required, E.164 or local; stored verbatim),
//     "text":        string  (required, the WhatsApp message body),
//     "received_at": string  (optional, ISO 8601; defaults to now())
//   }
//
// Dedupe:
//   If message_id is provided, we dedupe on it (sending the same id twice is
//   a no-op — useful when the provider exposes a stable per-message wamid).
//   If message_id is absent, we derive one server-side as a sha256 hash of
//   (received_at || '') + from_phone + text. Genuine retries from the
//   contractor (same payload) will dedupe automatically; only meaningfully
//   different payloads will land new rows.
//
// Response:
//   200 ok           — accepted (or already seen; idempotent)
//   400 invalid…     — payload shape problem
//   401 invalid…     — bad/missing Bearer secret
//   500 …            — server error (secret/service-role not configured)
//
// Deploy:  supabase functions deploy inbound-message --no-verify-jwt
// Secrets: BOT_INBOUND_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Derive a stable dedupe key when the contractor didn't send one. Two
// identical (timestamp, phone, text) tuples produce the same id, so genuine
// retries land on the existing row instead of creating duplicates.
async function deriveMessageId(receivedAt: string | null, fromPhone: string, text: string): Promise<string> {
  const seed = `${receivedAt ?? ''}|${fromPhone}|${text}`;
  const data = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `auto-${hex.slice(0, 32)}`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const secret = Deno.env.get('BOT_INBOUND_SECRET');
  if (!secret) {
    console.error('BOT_INBOUND_SECRET not configured');
    return new Response('server misconfigured', { status: 500 });
  }

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!timingSafeEqual(token, secret)) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  let   messageId  = typeof body.message_id  === 'string' ? body.message_id.trim()  : '';
  const fromPhone  = typeof body.from_phone  === 'string' ? body.from_phone.trim()  : '';
  const text       = typeof body.text        === 'string' ? body.text              : '';
  const receivedAt = typeof body.received_at === 'string' ? body.received_at.trim() : null;

  if (!fromPhone || !text) {
    return new Response('missing required fields: from_phone, text', { status: 400 });
  }
  if (!messageId) {
    messageId = await deriveMessageId(receivedAt, fromPhone, text);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('server misconfigured', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const row: Record<string, unknown> = {
    wasender_message_id: messageId,  // legacy column name; holds any provider's id
    remote_jid:          fromPhone,
    raw_payload:         body,
    raw_text:            text,
    status:              'queued',
  };
  if (receivedAt) row.received_at = receivedAt;

  const { error } = await supabase
    .from('bot_inbound_messages')
    .upsert(row, { onConflict: 'wasender_message_id', ignoreDuplicates: true });

  if (error) {
    console.error('insert failed', error);
    return new Response('insert failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});
