// Edge Function: wasender-webhook
// Receives `messages.received` events from WasenderAPI and lands them in
// public.bot_inbound_messages for downstream parsing.
//
// This function is deliberately thin:
//   1. Verify X-Webhook-Signature header against WASENDER_WEBHOOK_SECRET.
//   2. Filter to messages.received + fromMe=false.
//   3. Dedupe on wasender_message_id (unique index does the heavy lifting).
//   4. Insert with status='queued'. Return 200 fast (< 1s).
//
// Parsing happens in `bot-parse-message`, fired by a DB trigger on insert.
//
// Deploy:  supabase functions deploy wasender-webhook --no-verify-jwt
//          (Wasender will POST without a Supabase JWT.)
// Secrets: WASENDER_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Extract the human-readable text from a Wasender message payload.
// Shape per docs: data.messages.messageBody (preferred) or .message.conversation.
function extractRawText(messages: any): string | null {
  if (!messages) return null;
  if (typeof messages.messageBody === 'string' && messages.messageBody.length > 0) {
    return messages.messageBody;
  }
  const m = messages.message ?? {};
  if (typeof m.conversation === 'string' && m.conversation.length > 0) {
    return m.conversation;
  }
  // Common media captions
  if (typeof m.imageMessage?.caption === 'string') return m.imageMessage.caption;
  if (typeof m.videoMessage?.caption === 'string') return m.videoMessage.caption;
  if (typeof m.documentMessage?.caption === 'string') return m.documentMessage.caption;
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text;
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // 1. Signature verification.
  // Wasender sends the webhook secret verbatim in X-Webhook-Signature.
  const secret = Deno.env.get('WASENDER_WEBHOOK_SECRET');
  if (!secret) {
    console.error('WASENDER_WEBHOOK_SECRET not configured');
    return new Response('server misconfigured', { status: 500 });
  }
  const sig = req.headers.get('x-webhook-signature') ?? '';
  if (!timingSafeEqual(sig, secret)) {
    return new Response('invalid signature', { status: 401 });
  }

  // 2. Parse body.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  // 3. Filter — only handle inbound messages.
  if (body.event !== 'messages.received') {
    return new Response('ignored', { status: 200 });
  }
  const messages = body?.data?.messages;
  const key = messages?.key;
  if (!key?.id || typeof key.id !== 'string') {
    return new Response('missing key.id', { status: 400 });
  }
  if (key.fromMe === true) {
    return new Response('ignored (fromMe)', { status: 200 });
  }

  // 4. Insert with on-conflict do nothing (unique index = idempotency).
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('server misconfigured', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const rawText = extractRawText(messages);
  const { error } = await supabase
    .from('bot_inbound_messages')
    .upsert(
      {
        wasender_message_id: key.id,
        remote_jid:          key.remoteJid ?? null,
        raw_payload:         body,
        raw_text:            rawText,
        status:              'queued',
      },
      { onConflict: 'wasender_message_id', ignoreDuplicates: true },
    );

  if (error) {
    console.error('insert failed', error);
    return new Response('insert failed', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});
