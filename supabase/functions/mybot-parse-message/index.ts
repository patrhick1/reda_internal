// Edge Function: mybot-parse-message
// Fired by Supabase Database Webhook on INSERT into mybot_inbound_messages.
// Can also be invoked directly with { inbound_message_id } for replay.
//
// Pipeline per row — observe-only, no delivery creation:
//   1. Skip if parse_status != 'pending' (idempotency).
//   2. Kimi (moonshotai/kimi-k2.5) structured extraction via OpenRouter.
//      The prompt asks for an ARRAY of line items so multi-product orders
//      get captured in full. The contractor's bot-parse-message still
//      asks for a single product and silently drops extras — this is the
//      headline divergence between the two streams. Mybot also varies
//      the LLM (Kimi vs Gemini), so post-this-change the comparison is
//      no longer an LLM-only A/B; see reda_evolution_bot_setup.md §8.
//   3. Per-line product match via match_products_by_text RPC → one
//      candidate set per line item. Cross-line consistency check flags
//      rows where line items resolved to different client_ids (should
//      not happen — one forward = one client by scope assumption).
//   4. Address normalize via normalize-address edge function → location_id
//      + confidence. Reuses the existing Maps + Gemini disambiguation
//      pipeline the contractor side uses; address is message-level (one
//      per row), not per-line, so it's called once.
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

const EXTRACTION_PROMPT_VERSION = 'mybot-parse-v4-jsonschema';
const DEFAULT_EXTRACTION_MODEL = 'moonshotai/kimi-k2.5';

// OpenAI-strict-style JSON schema for the extraction output. OpenRouter
// passes this through to providers that support strict structured outputs
// (no markdown wrapping, no extra keys, type-checked). For providers that
// don't support it, OpenRouter quietly degrades to plain json_object
// behaviour — so we still have stripJsonFences() as a safety net below.
//
// OpenAI strict-mode rules followed here:
//   - Every property listed in `properties` is also in `required`.
//   - `additionalProperties: false` on every object.
//   - Nullable fields use the `[T, "null"]` type union, not `nullable: true`.
const EXTRACTION_SCHEMA = {
  name:   'mybot_extraction',
  strict: true,
  schema: {
    type:                 'object',
    additionalProperties: false,
    required: ['customer_name', 'customer_phone', 'raw_address', 'total_amount', 'products'],
    properties: {
      customer_name:  { type: ['string',  'null'] },
      customer_phone: { type: ['string',  'null'] },
      raw_address:    { type: ['string',  'null'] },
      total_amount:   { type: ['number',  'null'] },
      products: {
        type:  'array',
        items: {
          type:                 'object',
          additionalProperties: false,
          required: ['product_name', 'quantity', 'customer_price'],
          properties: {
            product_name:   { type: ['string',  'null'] },
            quantity:       { type: ['integer', 'null'] },
            customer_price: { type: ['number',  'null'] },
          },
        },
      },
    },
  },
};

// Deliberate divergence from the contractor's bot-parse-message: the
// contractor still asks for "one product per order" and silently drops
// extra lines. This prompt asks for an ARRAY so we can measure how often
// multi-product orders occur and how accurately Kimi captures them.
// Once the study window closes we'll know whether to invest in production
// fan-out (one delivery row per line item).
const EXTRACTION_PROMPT = `You are extracting a delivery order from a WhatsApp message that a Reda client forwarded.

A message contains one customer with one delivery address, but may contain multiple products (typically one per line, sometimes with a Total line at the bottom).

Return strict JSON with these fields (use null when missing):
  customer_name    : string  — the recipient's name
  customer_phone   : string  — Nigerian phone, keep digits and optional leading 0/+234
  raw_address      : string  — the delivery address, free-form, as-is from the message
  total_amount     : number  — the "Total(X)" amount if present in the message, otherwise null
  products         : array   — one entry per product line, in the order they appear:
    {
      product_name   : string  — the product name as written
      quantity       : integer — units of this product, default 1 if implied
      customer_price : number  — the subtotal for this product line (the parenthesized amount), null if missing
    }

Do NOT include the Total line as a product. Do NOT invent products that aren't in the message.

Message:
"""
{{TEXT}}
"""`;

type LineItem = {
  product_name:   string | null;
  quantity:       number | null;
  customer_price: number | null;
};

type Extracted = {
  customer_name:  string | null;
  customer_phone: string | null;
  raw_address:    string | null;
  total_amount:   number | null;
  products:       LineItem[];
};

// We send a strict JSON schema in the request (see EXTRACTION_SCHEMA),
// but OpenRouter degrades to plain json_object behaviour when a provider
// doesn't support strict mode — and even when strict is honored, a model
// may emit a "55,000" string instead of a number. Coerce defensively so a
// degraded path doesn't poison the downstream comparison data.
function toStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return String(v);
}
function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,_₦\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toInt(v: any): number | null {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

function coerceLineItem(v: any): LineItem | null {
  if (!v || typeof v !== 'object') return null;
  const name = toStr(v.product_name)?.trim() || null;
  if (!name) return null;  // drop items without a product name — they're not useful as line items
  return {
    product_name:   name,
    quantity:       toInt(v.quantity),
    customer_price: toNum(v.customer_price),
  };
}

function coerceExtracted(obj: any): Extracted | null {
  if (!obj || typeof obj !== 'object') return null;
  const products: LineItem[] = Array.isArray(obj.products)
    ? obj.products.map(coerceLineItem).filter((li: LineItem | null): li is LineItem => li !== null)
    : [];
  return {
    customer_name:  toStr(obj.customer_name),
    customer_phone: toStr(obj.customer_phone),
    raw_address:    toStr(obj.raw_address),
    total_amount:   toNum(obj.total_amount),
    products,
  };
}

// Same disambiguation rules as today's single-product matcher: single hit
// wins, multiple-same-client wins top, otherwise a 0.15 score gap wins
// top, otherwise leave null and let the study row flag it for review.
// Factored out so it can be called per line item without duplicating the
// rules — a divergence here would silently make multi-product rows behave
// differently from single-product rows in the comparison data.
function pickMatch(candidates: any[]): any | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const top = candidates[0];
  const sameClient = candidates.every((m: any) => m.client_id === top.client_id);
  if (sameClient) return top;
  if ((candidates[1]?.score ?? 0) + 0.15 <= top.score) return top;
  return null;
}

// Defensive: even with response_format: json_schema some models still wrap
// their answer in markdown code fences — especially reasoning models that
// emit the final answer via the "content" channel after a long reasoning
// trace. JSON.parse chokes on the leading ``` and trailing ```. Strip them
// before parsing so we don't reject otherwise-valid output. No-op when the
// content is already clean JSON.
function stripJsonFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json|jsonc)?\s*\n?/i, '');
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
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
    response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA },
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
      const cleaned = stripJsonFences(textOut);
      const obj = JSON.parse(cleaned);
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
  const totalAmount   = parsed.total_amount && parsed.total_amount >= 0 ? parsed.total_amount : null;

  // Default quantity to 1 per line so the persisted "extracted" block mirrors
  // what we'd push downstream if/when fan-out lands. Null prices stay null —
  // study queries can spot lines without per-line price and decide what to do.
  const products: LineItem[] = parsed.products.map((li) => ({
    product_name:   li.product_name,
    quantity:       li.quantity && li.quantity > 0 ? li.quantity : 1,
    customer_price: li.customer_price && li.customer_price >= 0 ? li.customer_price : null,
  }));

  if (products.length === 0) {
    await markError(supabase, inboundId, 'no products extracted', {
      extraction_raw:      extractionRaw,
      extraction_provider: 'openrouter',
      extraction_model:    model,
    });
    return new Response('no products extracted', { status: 200 });
  }

  // 3. Per-line product match → client_id. Disambiguation rules live in
  // pickMatch() so the per-line behaviour is identical to the old
  // single-product path. A line that's an unambiguous miss is fine; a
  // line that's an ambiguous miss (multi-client, no winner) gets a null
  // match and stays in the candidates list for review.
  const productMatches: Array<{ line: LineItem; match: any | null; candidates: any[] }> = [];
  for (const line of products) {
    const { data: matches } = await supabase.rpc('match_products_by_text', {
      p_text:           line.product_name!,  // empty names already filtered by coerceLineItem
      p_min_similarity: 0.4,
    });
    const candidates = matches ?? [];
    productMatches.push({ line, match: pickMatch(candidates), candidates });
  }

  // Cross-line consistency: per scope, one WhatsApp forward belongs to one
  // Reda client. If line items resolve to different client_ids, either Kimi
  // mis-extracted a product name or the catalog has overlapping names — both
  // worth flagging for the study window. Nulls are excluded (catalog miss is
  // not a conflict).
  const resolvedClientIds = productMatches
    .map((pm) => pm.match?.client_id)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  const uniqueClientIds  = Array.from(new Set(resolvedClientIds));
  const clientIdConflict = uniqueClientIds.length > 1;

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
      total_amount:   totalAmount,
      products,
    },
    product_matches:     productMatches,
    resolved_client_ids: uniqueClientIds,
    client_id_conflict:  clientIdConflict,
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
