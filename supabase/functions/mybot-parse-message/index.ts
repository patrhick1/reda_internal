// Edge Function: mybot-parse-message
// Fired by Supabase Database Webhook on INSERT into mybot_inbound_messages.
// Can also be invoked directly with { inbound_message_id } for replay.
//
// Pipeline per row — observe-only, no delivery creation:
//   1. Skip if parse_status != 'pending' (idempotency).
//   2. Kimi (moonshotai/kimi-k2.5) structured extraction via OpenRouter.
//      Same prompt as the contractor's bot-parse-message so the streams
//      are directly comparable — only the LLM differs. The contractor
//      pipeline runs Gemini; this one runs Kimi. That's the A/B.
//   3. Product match via match_products_by_text RPC → resolves client_id.
//   4. Address normalize via normalize-address edge function → location_id
//      + confidence. Reuses the existing Maps + Gemini disambiguation
//      pipeline the contractor side uses; the address layer is shared on
//      purpose so the only varying axis is the extraction LLM.
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
// Secrets: OPENROUTER_API_KEY (Kimi via OpenRouter; obtain from
//            openrouter.ai → API keys),
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          (normalize-address has its own GOOGLE_MAPS_API_KEY +
//           GEMINI_API_KEY, separate; those stay as-is.)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const EXTRACTION_PROMPT_VERSION = 'mybot-parse-v2-openrouter';
const DEFAULT_EXTRACTION_MODEL = 'moonshotai/kimi-k2.5';

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

// OpenRouter (OpenAI-compatible chat-completions) doesn't enforce a typed
// schema the way Gemini's responseSchema does — it can promise valid JSON
// via response_format, but the field types come from the model's own
// best-effort. Kimi at temperature=0 is usually well-behaved, but we still
// coerce defensively so a "55,000" string for customer_price or a "2"
// string for quantity doesn't poison the downstream comparison data.
function coerceExtracted(obj: any): Extracted | null {
  if (!obj || typeof obj !== 'object') return null;
  const toStr = (v: any): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    return String(v);
  };
  const toNum = (v: any): number | null => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const cleaned = v.replace(/[,_₦\s]/g, '');
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const toInt = (v: any): number | null => {
    const n = toNum(v);
    return n === null ? null : Math.round(n);
  };
  return {
    customer_name:  toStr(obj.customer_name),
    customer_phone: toStr(obj.customer_phone),
    raw_address:    toStr(obj.raw_address),
    product_name:   toStr(obj.product_name),
    quantity:       toInt(obj.quantity),
    customer_price: toNum(obj.customer_price),
  };
}

async function openrouterExtract(
  text: string,
  model: string,
  apiKey: string,
): Promise<{ parsed: Extracted | null; raw: any }> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const prompt = EXTRACTION_PROMPT.replace('{{TEXT}}', text);
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_object' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // Optional but encouraged by OpenRouter — surfaces this app in their
      // dashboards and helps with rate-limit prioritisation.
      'HTTP-Referer':  'https://reda.app',
      'X-Title':       'Reda mybot parse',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('openrouter extract error', res.status, errText);
    return { parsed: null, raw: { error: errText, status: res.status, model } };
  }
  const json = await res.json();
  const textOut = json?.choices?.[0]?.message?.content;
  let parsed: Extracted | null = null;
  if (typeof textOut === 'string' && textOut.length > 0) {
    try {
      const obj = JSON.parse(textOut);
      parsed = coerceExtracted(obj);
    } catch {
      // fall through — parsed stays null, marked as error upstream
    }
  }
  return { parsed, raw: { ...json, _prompt_version: EXTRACTION_PROMPT_VERSION, _model: model } };
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

  // 2. OpenRouter / Kimi extraction. Model is configurable via the
  // existing ai_config table (key 'openrouter_model'); falls back to the
  // default we ship with so this works out of the box.
  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) {
    await markError(supabase, inboundId, 'OPENROUTER_API_KEY not configured');
    return new Response('OPENROUTER_API_KEY missing', { status: 500 });
  }
  const { data: modelCfg } = await supabase.rpc('get_ai_config', { p_key: 'openrouter_model' });
  const model = typeof modelCfg === 'string' && modelCfg.length > 0 ? modelCfg : DEFAULT_EXTRACTION_MODEL;
  const { parsed, raw: extractionRaw } = await openrouterExtract(row.raw_text, model, apiKey);
  if (!parsed) {
    await markError(supabase, inboundId, 'openrouter extraction failed', {
      extraction_raw:      extractionRaw,
      extraction_provider: 'openrouter',
      extraction_model:    model,
    });
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
    extraction_raw:      extractionRaw,
    extraction_provider: 'openrouter',
    extraction_model:    model,
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
