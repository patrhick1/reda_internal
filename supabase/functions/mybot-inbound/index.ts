// Edge Function: mybot-inbound
// Parallel intake for the in-house WhatsApp bot we're developing alongside
// the contractor's. Pure observation: lands the message in
// `public.mybot_inbound_messages` and stops. No Gemini call, no delivery
// creation, no trigger fan-out. We study the rows offline and compare
// against the contractor stream until the in-house bot is good enough to
// take over.
//
// Contract:
//   POST /functions/v1/mybot-inbound
//   Authorization: Bearer <MYBOT_INBOUND_SECRET>
//   Content-Type: application/json
//   {
//     "message_id":  string  (optional — see dedupe note),
//     "from_phone":  string  (required, stored verbatim),
//     "text":        string  (required, the WhatsApp message body),
//     "received_at": string  (optional, ISO 8601; defaults to now())
//   }
//
// Dedupe:
//   If `message_id` is provided we dedupe on it (idempotent retries).
//   If absent we derive one server-side as 'mybot-<sha256-first-32-hex>'
//   over (received_at||'')+from_phone+text. The 'mybot-' prefix is
//   deliberate — it makes the source unambiguous when an operator scans
//   the table.
//
// Response:
//   200 ok           — accepted (or already seen; idempotent)
//   400 invalid…     — payload shape problem
//   401 invalid…     — bad/missing Bearer secret
//   500 …            — server error (secret/service-role not configured)
//
// Deploy:  supabase functions deploy mybot-inbound --no-verify-jwt
// Secrets: MYBOT_INBOUND_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function deriveMessageId(receivedAt: string | null, fromPhone: string, text: string): Promise<string> {
  const seed = `${receivedAt ?? ''}|${fromPhone}|${text}`;
  const data = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `mybot-${hex.slice(0, 32)}`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const secret = Deno.env.get('MYBOT_INBOUND_SECRET');
  if (!secret) {
    console.error('MYBOT_INBOUND_SECRET not configured');
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
    message_id:  messageId,
    from_phone:  fromPhone,
    raw_text:    text,
    raw_payload: body,
  };
  if (receivedAt) row.received_at = receivedAt;

  const { error } = await supabase
    .from('mybot_inbound_messages')
    .upsert(row, { onConflict: 'message_id', ignoreDuplicates: true });

  if (error) {
    console.error('insert failed', error);
    return new Response('insert failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});
