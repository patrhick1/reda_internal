// Edge Function: mybot-parse-message
// Fired by Supabase Database Webhook on INSERT into mybot_inbound_messages.
// Can also be invoked directly with { inbound_message_id } for replay.
//
// Pipeline per row — observe-only, no delivery creation:
//   1. Skip if parse_status != 'pending' (idempotency).
//   2. Gemini 2.5-flash structured extraction (same prompt as the
//      contractor's bot-parse-message so the two are directly comparable).
//   3. Product match via match_products_by_text RPC → resolves client_id.
//   4. Address normalize via normalize-address edge function → location_id
//      + confidence. Same Google Maps + Gemini pipeline the contractor
//      side uses.
//   5. Write parse_result + parse_status='parsed' (or 'error') back to the
//      row.
//
// What we DON'T do here:
//   - Agent resolution. The in-house bot will eventually own assignment,
//     but for now we accept that we may not know who delivers and defer.
//   - bot_create_delivery. The whole point of this pipeline is to study
//     extraction quality WITHOUT polluting the deliveries table.
//
// Deploy:  supabase functions deploy mybot-parse-message
// Secrets: GEMINI_API_KEY (same value as the bot-parse-message function),
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          (normalize-address has its own GOOGLE_MAPS_API_KEY, separate.)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const EXTRACTION_PROMPT_VERSION = 'mybot-parse-v1';

// Verbatim copy of the contractor pipeline's prompt so the extractions
// are directly comparable across the two streams. If you change one,
// change both — drift defeats the entire comparison exercise.
const EXTRACTION_PROMPT = `You are extracting a single delivery order from a WhatsApp message that a Reda client forwarded.

Return strict JSON with these fields (use null when missing):
  customer_name    : string  — the recipient's name
  customer_phone   : string  — Nigerian phone, keep digits and optional leading 0/+234
  raw_address      : string  — the delivery address, free-form, as-is from the message
  product_name     : string  — the product the customer ordered (one product per order)
  quantity         : integer — quantity ordered, default 1 if implied
  customer_price   : number  — the amount the customer is paying (₦), digits only

Message:
"""
{{TEXT}}
"""`;

type Extracted = {
  customer_name:  string | null;
  customer_phone: string | null;
  raw_address:    string | null;
  product_name:   string | null;
  quantity:       number | null;
  customer_price: number | null;
};

async function geminiExtract(
  text: string,
  model: string,
  apiKey: string,
): Promise<{ parsed: Extracted | null; raw: any }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = EXTRACTION_PROMPT.replace('{{TEXT}}', text);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          customer_name:  { type: 'STRING',  nullable: true },
          customer_phone: { type: 'STRING',  nullable: true },
          raw_address:    { type: 'STRING',  nullable: true },
          product_name:   { type: 'STRING',  nullable: true },
          quantity:       { type: 'INTEGER', nullable: true },
          customer_price: { type: 'NUMBER',  nullable: true },
        },
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('gemini extract error', res.status, errText);
    return { parsed: null, raw: { error: errText, status: res.status } };
  }
  const json = await res.json();
  const textOut = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: Extracted | null = null;
  if (textOut) {
    try { parsed = JSON.parse(textOut) as Extracted; } catch { /* fall through */ }
  }
  return { parsed, raw: { ...json, _prompt_version: EXTRACTION_PROMPT_VERSION } };
}

function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits.length >= 10 ? digits : null;
}

function resolveInboundId(body: any): string | null {
  if (typeof body?.inbound_message_id === 'string') return body.inbound_message_id;
  if (typeof body?.record?.id === 'string') return body.record.id;
  return null;
}

async function markError(
  supabase: any,
  inboundId: string,
  errorText: string,
  parseResult: any = null,
): Promise<void> {
  await supabase
    .from('mybot_inbound_messages')
    .update({
      parse_status: 'error',
      parse_result: parseResult,
      processed_at: new Date().toISOString(),
      error_text:   errorText,
    })
    .eq('id', inboundId);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('server misconfigured', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const inboundId = resolveInboundId(body);
  if (!inboundId) {
    return new Response('inbound_message_id required', { status: 400 });
  }

  // 1. Load + idempotency.
  const { data: row, error: loadErr } = await supabase
    .from('mybot_inbound_messages')
    .select('id, raw_text, parse_status')
    .eq('id', inboundId)
    .maybeSingle();
  if (loadErr || !row) {
    console.error('load failed', loadErr);
    return new Response('row not found', { status: 404 });
  }
  if (row.parse_status !== 'pending') {
    return new Response(`already processed: ${row.parse_status}`, { status: 200 });
  }
  if (!row.raw_text || row.raw_text.trim().length === 0) {
    await markError(supabase, inboundId, 'empty raw_text');
    return new Response('empty raw_text', { status: 200 });
  }

  // 2. Gemini extraction.
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    await markError(supabase, inboundId, 'GEMINI_API_KEY not configured');
    return new Response('GEMINI_API_KEY missing', { status: 500 });
  }
  const { data: modelCfg } = await supabase.rpc('get_ai_config', { p_key: 'gemini_model' });
  const model = typeof modelCfg === 'string' ? modelCfg : 'gemini-2.5-flash';
  const { parsed, raw: geminiRaw } = await geminiExtract(row.raw_text, model, geminiKey);
  if (!parsed) {
    await markError(supabase, inboundId, 'gemini extraction failed', { gemini_extraction_raw: geminiRaw });
    return new Response('extraction failed', { status: 200 });
  }

  const customerName  = parsed.customer_name?.trim() || null;
  const customerPhone = normalizePhone(parsed.customer_phone);
  const rawAddress    = parsed.raw_address?.trim() || null;
  const productName   = parsed.product_name?.trim() || null;
  const quantity      = parsed.quantity && parsed.quantity > 0 ? parsed.quantity : 1;
  const customerPrice = parsed.customer_price && parsed.customer_price >= 0 ? parsed.customer_price : null;

  // 3. Product match → client_id. Same disambiguation rules as the
  // contractor's pipeline: single hit wins, multiple-same-client wins
  // top, otherwise require a 0.15 score gap, otherwise leave for review.
  let productMatch: any = null;
  let productCandidates: any[] = [];
  if (productName) {
    const { data: matches } = await supabase.rpc('match_products_by_text', {
      p_text: productName,
      p_min_similarity: 0.4,
    });
    productCandidates = matches ?? [];
    if (productCandidates.length === 1) {
      productMatch = productCandidates[0];
    } else if (productCandidates.length > 1) {
      const top = productCandidates[0];
      const sameClient = productCandidates.every(
        (m: any) => m.client_id === top.client_id,
      );
      if (sameClient) {
        productMatch = top;
      } else if ((productCandidates[1]?.score ?? 0) + 0.15 <= top.score) {
        productMatch = top;
      }
      // else: ambiguous — leave productMatch null, study row marked needs-review.
    }
  }

  // 4. Address normalize → location_id. Reuses the existing
  // normalize-address edge function so the resolution rules — Maps +
  // Gemini disambiguation — are shared with the contractor pipeline.
  // If the function fails for any reason we still parse the rest;
  // location resolution is informational at this stage.
  let address: {
    match_log_id:        string | null;
    matched_location_id: string | null;
    confidence:          string;
  } = { match_log_id: null, matched_location_id: null, confidence: 'none' };

  if (rawAddress) {
    const { data: addrData, error: addrErr } = await supabase.functions.invoke('normalize-address', {
      body: { raw_address: rawAddress },
    });
    if (addrErr) {
      console.error('normalize-address invoke error', addrErr);
    } else if (addrData) {
      address = {
        match_log_id:        addrData.match_log_id ?? null,
        matched_location_id: addrData.matched_location_id ?? null,
        confidence:          addrData.confidence ?? 'none',
      };
    }
  }

  // 5. Persist.
  const parseResult = {
    extracted: {
      customer_name:  customerName,
      customer_phone: customerPhone,
      raw_address:    rawAddress,
      product_name:   productName,
      quantity,
      customer_price: customerPrice,
    },
    product:            productMatch,
    product_candidates: productCandidates,
    address,
    gemini_extraction_raw: geminiRaw,
  };

  const { error: updateErr } = await supabase
    .from('mybot_inbound_messages')
    .update({
      parse_status: 'parsed',
      parse_result: parseResult,
      processed_at: new Date().toISOString(),
    })
    .eq('id', inboundId);

  if (updateErr) {
    console.error('final update failed', updateErr, 'id', inboundId);
    return new Response('persist failed (logged)', { status: 200 });
  }

  return new Response('parsed', { status: 200 });
});
