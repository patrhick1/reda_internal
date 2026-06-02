// Edge Function: evolution-webhook
// Direct webhook receiver for our in-house WhatsApp bot. The bot itself
// runs on an Evolution API instance on a VPS; that instance is configured
// to POST messages.upsert events here. We filter, extract text, and land
// the result in public.mybot_inbound_messages for offline study.
//
// Strictly observe-only: no Gemini call, no delivery creation. The whole
// purpose right now is to compare what our bot receives against the
// contractor's stream (public.bot_inbound_messages) on the same source
// WhatsApp messages. Once parsing quality is good enough we'll cut over.
//
// Contract:
//   POST /functions/v1/evolution-webhook
//   apikey: <EVOLUTION_WEBHOOK_SECRET>           (Evolution's default)
//   — or —
//   Authorization: Bearer <EVOLUTION_WEBHOOK_SECRET>
//   Content-Type: application/json
//   { ...Evolution messages.upsert payload... }
//
// Filtering, in order — anything dropped returns 200 so Evolution doesn't
// queue retries against a permanent skip:
//   1. event !== 'messages.upsert'                 → ignored
//   2. data.key.fromMe === true                    → ignored
//   3. remoteJid ends with '@g.us' (group chat)    → ignored
//   4. allow-list configured AND sender not on it  → ignored
//   5. no usable text extracted                    → ignored
//
// Dedupe: Evolution's data.key.id is per-message unique. We prefix
// 'mybot-' and use it as our message_id, so the UNIQUE constraint on the
// table makes retries idempotent.
//
// Deploy:  supabase functions deploy evolution-webhook --no-verify-jwt
// Secrets: EVOLUTION_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          EVOLUTION_ALLOWED_SENDERS (optional, comma-separated phone numbers)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Pull the bearer/apikey from either of the two headers Evolution might
// send. Returns '' when neither is present.
function readSecret(req: Request): string {
  const apikey = req.headers.get('apikey') ?? '';
  if (apikey) return apikey.trim();
  const auth = req.headers.get('authorization') ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

// Extract the order-bearing text from an Evolution `data.message` object.
// We return the caption for image/video messages (those often carry the
// order text in the caption) but skip pure audio/document since neither
// contains parseable order info. Returns '' for anything we should drop.
function extractText(message: any): string {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.conversation === 'string') return message.conversation;
  if (typeof message.extendedTextMessage?.text === 'string') return message.extendedTextMessage.text;
  if (typeof message.imageMessage?.caption === 'string')   return message.imageMessage.caption;
  if (typeof message.videoMessage?.caption === 'string')   return message.videoMessage.caption;
  // Audio / document / sticker / reaction / contact / location — none of
  // these carry order text. Drop.
  return '';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  // Auth — required. The secret is set on the Evolution instance side
  // when the webhook URL is configured.
  const expected = Deno.env.get('EVOLUTION_WEBHOOK_SECRET');
  if (!expected) {
    console.error('EVOLUTION_WEBHOOK_SECRET not configured');
    return new Response('server misconfigured', { status: 500 });
  }
  const got = readSecret(req);
  if (!got || !timingSafeEqual(got, expected)) {
    return new Response('invalid signature', { status: 401 });
  }

  // Size guard. Evolution can ship 4 MB+ payloads when media (audio,
  // images, video, history syncs) is in the event — those time the
  // function out on the body upload + JSON parse long before we get a
  // chance to filter. Drop anything obviously too big to be a plain text
  // order forward. WhatsApp message bodies are rarely above 8 KB; 64 KB
  // is generous headroom while still cheap to reject.
  const lenHeader = req.headers.get('content-length');
  const declaredLen = lenHeader ? parseInt(lenHeader, 10) : 0;
  if (Number.isFinite(declaredLen) && declaredLen > 64 * 1024) {
    console.log('payload too large, dropped', { content_length: declaredLen });
    return new Response('payload too large', { status: 200 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    // Bad JSON — don't retry. Log so we can investigate.
    console.error('invalid json from evolution');
    return new Response('invalid json', { status: 200 });
  }

  // Filter 1: only the message-arrival event matters.
  if (payload?.event !== 'messages.upsert') {
    return new Response('event ignored', { status: 200 });
  }

  const data = payload.data;
  if (!data || typeof data !== 'object') {
    return new Response('no data', { status: 200 });
  }

  // Filter 2: drop our bot's own outgoing messages.
  if (data.key?.fromMe === true) {
    return new Response('fromMe ignored', { status: 200 });
  }

  const remoteJid = typeof data.key?.remoteJid === 'string' ? data.key.remoteJid : '';
  if (!remoteJid) {
    return new Response('no remoteJid', { status: 200 });
  }

  // Filter 3: skip group chats. Order forwards are always 1:1 DMs from
  // an admin (Uzo). Anything from a @g.us JID is noise for our purposes.
  if (remoteJid.endsWith('@g.us')) {
    return new Response('group ignored', { status: 200 });
  }

  // Strip JID suffix to get a clean phone number for storage + allow-list
  // matching.
  const fromPhone = remoteJid.replace(/@s\.whatsapp\.net|@g\.us/g, '');

  // Filter 4: allow-list. Only enforced if EVOLUTION_ALLOWED_SENDERS is
  // set — leave it unset during the broad study phase, populate it later
  // when we know which admin numbers should produce real orders.
  const allowlistRaw = Deno.env.get('EVOLUTION_ALLOWED_SENDERS');
  if (allowlistRaw) {
    const allowed = new Set(
      allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean),
    );
    if (!allowed.has(fromPhone)) {
      return new Response('sender not allowed', { status: 200 });
    }
  }

  // Filter 5: extract text. Drop messages with nothing parseable.
  const text = extractText(data.message).trim();
  if (!text) {
    return new Response('no usable text', { status: 200 });
  }

  // Build received_at from Evolution's Unix-seconds timestamp; fall back
  // to now() if absent or malformed.
  let receivedAt: string | null = null;
  if (typeof data.messageTimestamp === 'number' && Number.isFinite(data.messageTimestamp)) {
    receivedAt = new Date(data.messageTimestamp * 1000).toISOString();
  }

  // Message id: Evolution's per-message id, prefixed so it's obvious in
  // the table that this row came from our pipeline. Without the prefix
  // someone reading mybot_inbound_messages can't tell at a glance which
  // ingestor produced it.
  const evoId = typeof data.key?.id === 'string' ? data.key.id : '';
  if (!evoId) {
    console.error('evolution payload missing key.id', JSON.stringify(payload).slice(0, 500));
    return new Response('no message id', { status: 200 });
  }
  const messageId = `mybot-${evoId}`;

  // Supabase service-role client. RLS bypassed; only this function writes
  // to mybot_inbound_messages.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
    return new Response('server misconfigured', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const row: Record<string, unknown> = {
    message_id:  messageId,
    from_phone:  fromPhone,
    raw_text:    text,
    raw_payload: payload,
  };
  if (receivedAt) row.received_at = receivedAt;

  const { error } = await supabase
    .from('mybot_inbound_messages')
    .upsert(row, { onConflict: 'message_id', ignoreDuplicates: true });

  if (error) {
    // Log but still return 200. Evolution would otherwise hammer retries
    // against a problem only we can diagnose. If we lose a row to a DB
    // hiccup, the contractor pipeline still has it (study phase only).
    console.error('insert failed', error, 'message_id', messageId);
    return new Response('insert failed (logged)', { status: 200 });
  }

  return new Response('ok', { status: 200 });
});
