// Edge Function: bot-parse-message
// Fired by Supabase Database Webhook on INSERT into bot_inbound_messages
// (or invoked directly with `{ inbound_message_id }` for replay).
//
// Pipeline per row:
//   1. Skip if status != 'queued' (idempotency).
//   2. Use the contractor's pre-parse for whichever fields it populated. For
//      any of {product_name, raw_address, customer_phone} the contractor
//      left empty, call OpenRouter (openai/gpt-4.1-mini) and MERGE — the
//      contractor's good fields stay, the LLM only fills the gaps. We never
//      discard a contractor field to recover a missing one (e.g. their
//      product_name="Perfume" survives even when their raw_address is
//      empty and the LLM has to extract the address from raw_text).
//   3. Match product via match_products_by_text RPC → resolves client_id.
//   4. Call normalize-address → location_id + confidence.
//   5. Decide outcome based on flags:
//        - enable_bot_pipeline=false OR bot_shadow_mode=true → 'shadow_only'
//        - fully resolved → bot_create_delivery → 'created_delivery'
//        - anything missing → 'needs_review'
//   6. mark_inbound_processed updates the row atomically.
//
// Deploy:  supabase functions deploy bot-parse-message
// Secrets: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          (also GOOGLE_MAPS_API_KEY + GEMINI_API_KEY for normalize-address —
//           set there; the bot-parse-message extractor itself no longer uses
//           Gemini.)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { denyIfNotInternal } from '../_shared/internal-auth.ts';
import {
  PRODUCT_EXTRACTION_SCHEMA,
  PRODUCT_EXTRACTION_PROMPT,
  coerceExtractedProducts,
  expandKnownCombos,
  extractTrailingRep,
  stripJsonFences as stripFencesShared,
  pickMatch,
  type ExtractedProducts,
  type LineItem,
  type ProductMatch,
} from '../_shared/product-extract.ts';

const EXTRACTION_PROMPT_VERSION = 'bot-parse-v5-client-rep-gpt-4.1-mini';
const EXTRACTION_MODEL          = 'openai/gpt-4.1-mini';

// Hard cap on the OpenRouter request so a hung inference can't park a row in
// status='queued' forever. gpt-4.1-mini typically returns in <5s; 30s leaves
// generous headroom while guaranteeing we always reach the error path.
const REQUEST_TIMEOUT_MS = 30_000;

// OpenAI-strict-style JSON schema for the extraction output. OpenRouter passes
// this through to providers that support strict structured outputs (no markdown
// wrapping, no extra keys, type-checked). Mirrors the Extracted type below.
const EXTRACTION_SCHEMA = {
  name:   'bot_extraction',
  strict: true,
  schema: {
    type:                 'object',
    additionalProperties: false,
    required: ['customer_name', 'customer_phone', 'customer_phone_alt', 'raw_address', 'product_name', 'quantity', 'customer_price'],
    properties: {
      customer_name:      { type: ['string',  'null'] },
      customer_phone:     { type: ['string',  'null'] },
      customer_phone_alt: { type: ['string',  'null'] },
      raw_address:        { type: ['string',  'null'] },
      product_name:       { type: ['string',  'null'] },
      quantity:           { type: ['integer', 'null'] },
      customer_price:     { type: ['number',  'null'] },
    },
  },
};

const EXTRACTION_PROMPT = `You are extracting a single delivery order from a WhatsApp message that a Reda client forwarded.

Return strict JSON with these fields (use null when missing):
  customer_name    : string  — the recipient's name. If the message has no name, use the customer_phone digits as the customer_name instead of returning null. Only return null if BOTH a name and a phone are missing.
  customer_phone   : string  — Nigerian phone, keep digits and optional leading 0/+234
  customer_phone_alt : string — a SECOND, distinct customer phone if the message lists one (e.g. "or call 0…", a second contact line). Phone numbers only — NEVER a bank/transfer/account number. null if there is only one number.
  raw_address      : string  — the delivery address, free-form, as-is from the message
  product_name     : string  — the product the customer ordered (one product per order)
  quantity         : integer — quantity ordered, default 1 if implied
  customer_price   : number  — the amount the customer is paying (₦), digits only

Message:
"""
{{TEXT}}
"""`;

type Extracted = {
  customer_name:      string | null;
  customer_phone:     string | null;
  customer_phone_alt: string | null;
  raw_address:        string | null;
  product_name:       string | null;
  quantity:           number | null;
  customer_price:     number | null;
};

// Read a pre-parsed delivery from the inbound row's raw_payload, if the
// upstream bot included one. Returns ONLY the fields the contractor
// actually populated (omitted fields are absent from `fields`, NOT set to
// null) plus a `needsLlm` flag: true when any of the three load-bearing
// fields (product_name, raw_address, customer_phone) is missing.
//
// The caller uses `needsLlm` to decide whether to call OpenRouter, then
// merges contractor's values OVER the LLM's — so the contractor's good
// fields are never discarded just to recover one empty one. This matters
// because the contractor's parse has client-side context the LLM doesn't:
// e.g. they correctly parse product_name="Perfume" from a "OUD AL LAYL
// BROWN SINGLE WITH OIL 2515-U" SKU header the LLM would take literally.
type PartialExtracted = { fields: Partial<Extracted>; needsLlm: boolean };

function extractContractorParse(raw_payload: any): PartialExtracted {
  const p = raw_payload?.parsed;
  if (!p || typeof p !== 'object') return { fields: {}, needsLlm: true };

  const fields: Partial<Extracted> = {};
  if (typeof p.customer_name  === 'string' && p.customer_name.trim())  fields.customer_name  = p.customer_name.trim();
  if (normalizePhone(p.customer_phone))                                 fields.customer_phone = p.customer_phone;
  // Not load-bearing — deliberately excluded from `needsLlm` below.
  if (normalizePhone(p.customer_phone_alt))                             fields.customer_phone_alt = p.customer_phone_alt;
  if (typeof p.raw_address    === 'string' && p.raw_address.trim())     fields.raw_address    = p.raw_address.trim();
  if (typeof p.product_name   === 'string' && p.product_name.trim())    fields.product_name   = p.product_name.trim();
  if (typeof p.quantity       === 'number' && p.quantity > 0)           fields.quantity       = p.quantity;
  if (typeof p.customer_price === 'number' && p.customer_price >= 0)    fields.customer_price = p.customer_price;

  const needsLlm = !fields.product_name || !fields.raw_address || !fields.customer_phone;
  return { fields, needsLlm };
}

// Defensive coercion: even with response_format=json_schema, providers may
// emit "55,000" as a string or wrap output in markdown fences. Coerce so a
// degraded response doesn't poison downstream consumers.
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
function coerceExtracted(obj: any): Extracted | null {
  if (!obj || typeof obj !== 'object') return null;
  return {
    customer_name:      toStr(obj.customer_name),
    customer_phone:     toStr(obj.customer_phone),
    customer_phone_alt: toStr(obj.customer_phone_alt),
    raw_address:        toStr(obj.raw_address),
    product_name:       toStr(obj.product_name),
    quantity:           toInt(obj.quantity),
    customer_price:     toNum(obj.customer_price),
  };
}

function stripJsonFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json|jsonc)?\s*\n?/i, '');
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

async function openrouterExtract(text: string, model: string, apiKey: string): Promise<{ parsed: Extracted | null; raw: any }> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const prompt = EXTRACTION_PROMPT.replace('{{TEXT}}', text);
  const body = {
    model,
    messages:        [{ role: 'user', content: prompt }],
    temperature:     0,
    response_format: { type: 'json_schema', json_schema: EXTRACTION_SCHEMA },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // Optional but encouraged by OpenRouter — surfaces this app in their
        // dashboards and helps with rate-limit prioritisation.
        'HTTP-Referer':  'https://reda.app',
        'X-Title':       'Reda bot-parse-message',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.error('openrouter extract timeout', { timeout_ms: REQUEST_TIMEOUT_MS, model });
      return { parsed: null, raw: { error: 'request timeout', timeout_ms: REQUEST_TIMEOUT_MS, model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
    }
    console.error('openrouter extract network error', err, { model });
    return { parsed: null, raw: { error: String(err), model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
  }
  if (!res.ok) {
    const errText = await res.text();
    console.error('openrouter extract error', res.status, errText);
    return { parsed: null, raw: { error: errText, status: res.status, model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
  }
  const json = await res.json();
  const textOut = json?.choices?.[0]?.message?.content;
  let parsed: Extracted | null = null;
  if (typeof textOut === 'string' && textOut.length > 0) {
    try {
      const cleaned = stripJsonFences(textOut);
      parsed = coerceExtracted(JSON.parse(cleaned));
    } catch { /* fall through — parsed stays null */ }
  }
  return { parsed, raw: { ...json, _prompt_version: EXTRACTION_PROMPT_VERSION, _model: model } };
}

// [Feature A] Multi-product extraction. Same OpenRouter call as the single
// version, but uses the shared ARRAY schema/prompt so one message yields N line
// items. Envelope fields (name/phone/address) still come back too, used only to
// FILL gaps the contractor left — the contractor envelope still wins where set.
async function openrouterExtractProducts(text: string, model: string, apiKey: string): Promise<{ parsed: ExtractedProducts | null; raw: any }> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const prompt = PRODUCT_EXTRACTION_PROMPT.replace('{{TEXT}}', text);
  const body = {
    model,
    messages:        [{ role: 'user', content: prompt }],
    temperature:     0,
    response_format: { type: 'json_schema', json_schema: PRODUCT_EXTRACTION_SCHEMA },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://reda.app',
        'X-Title':       'Reda bot-parse-message (multi-product)',
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.error('openrouter products extract timeout', { timeout_ms: REQUEST_TIMEOUT_MS, model });
      return { parsed: null, raw: { error: 'request timeout', timeout_ms: REQUEST_TIMEOUT_MS, model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
    }
    console.error('openrouter products extract network error', err, { model });
    return { parsed: null, raw: { error: String(err), model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
  }
  if (!res.ok) {
    const errText = await res.text();
    console.error('openrouter products extract error', res.status, errText);
    return { parsed: null, raw: { error: errText, status: res.status, model, _prompt_version: EXTRACTION_PROMPT_VERSION } };
  }
  const json = await res.json();
  const textOut = json?.choices?.[0]?.message?.content;
  let parsed: ExtractedProducts | null = null;
  if (typeof textOut === 'string' && textOut.length > 0) {
    try {
      parsed = coerceExtractedProducts(JSON.parse(stripFencesShared(textOut)));
    } catch { /* fall through — parsed stays null */ }
  }
  return { parsed, raw: { ...json, _prompt_version: EXTRACTION_PROMPT_VERSION, _model: model } };
}

// [Feature A] Read a contractor-supplied products[] array if one is ever present
// in raw_payload.parsed.products. Today the contractor sends only a single
// product_name; this is forward-compat for when/if they emit an array.
function extractContractorProducts(raw_payload: any): LineItem[] | null {
  const arr = raw_payload?.parsed?.products;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const items: LineItem[] = [];
  for (const e of arr) {
    const name = (typeof e?.product_name === 'string' ? e.product_name.trim() : '') || null;
    if (!name) continue;
    items.push({
      product_name:   name,
      quantity:       typeof e?.quantity === 'number' && e.quantity > 0 ? Math.round(e.quantity) : null,
      customer_price: typeof e?.customer_price === 'number' && e.customer_price >= 0 ? e.customer_price : null,
      free:           e?.free === true,
    });
  }
  return items.length > 0 ? items : null;
}

function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits.length >= 10 ? digits : null;
}

// Bowan's structured template carries the real order quantity in an explicit
// column: "<product> | qty | unit_price | line_total". Returns that qty ONLY
// when the message is unmistakably Bowan's template (Order Number + Closer
// markers) AND the column arithmetic checks out (unit × qty === total), so it
// cannot fire on any other client's free-form message. Null otherwise → caller
// leaves the AI-extracted quantity untouched. See the call site for why.
function bowanColumnQuantity(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (!/order\s*number\s*:/i.test(raw) || !/closer\s*:/i.test(raw)) return null;
  const m = raw.match(/\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/);
  if (!m) return null;
  const qty = Number(m[1]);
  const unit = Number(m[2]);
  const total = Number(m[3]);
  if (!Number.isInteger(qty) || qty < 1) return null;
  if (unit * qty !== total) return null; // math guard — reject a stray pipe
  return qty;
}

async function resolveInboundId(body: any, supabase: any): Promise<string | null> {
  if (typeof body?.inbound_message_id === 'string') return body.inbound_message_id;
  if (body?.record?.id && typeof body.record.id === 'string') return body.record.id;
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Internal-only: fired by the bot_inbound_messages DB webhook / manual replay.
  const denied = denyIfNotInternal(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); } catch { return new Response('invalid json', { status: 400 }); }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return new Response('server misconfigured', { status: 500 });
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const inboundId = await resolveInboundId(body, supabase);
  if (!inboundId) return new Response('inbound_message_id required', { status: 400 });

  // 1. Load + idempotency.
  const { data: row, error: loadErr } = await supabase
    .from('bot_inbound_messages')
    .select('id, raw_text, raw_payload, status')
    .eq('id', inboundId)
    .maybeSingle();
  if (loadErr || !row) {
    console.error('load failed', loadErr);
    return new Response('row not found', { status: 404 });
  }
  if (row.status !== 'queued') {
    return new Response(`already processed: ${row.status}`, { status: 200 });
  }
  if (!row.raw_text || row.raw_text.trim().length === 0) {
    await supabase.rpc('mark_inbound_processed', {
      p_inbound_id: inboundId,
      p_status:     'error',
      p_parse:      null,
      p_delivery_id: null,
      p_error:      'empty raw_text',
    });
    return new Response('empty raw_text', { status: 200 });
  }

  // Flags.
  const [{ data: pipelineFlag }, { data: shadowFlag }] = await Promise.all([
    supabase.rpc('get_flag', { p_key: 'enable_bot_pipeline' }),
    supabase.rpc('get_flag', { p_key: 'bot_shadow_mode' }),
  ]);
  const pipelineEnabled = !!pipelineFlag?.enabled;
  const shadowMode      = !!shadowFlag?.enabled;

  // 2a. [Feature A] Read the contractor's pre-parse for the ENVELOPE
  //     (customer_name, customer_phone, raw_address — and its single
  //     product_name as a fallback hint). The envelope merge is unchanged:
  //     contractor's fields win, the LLM only fills gaps.
  //
  // 2b. [Feature A] The PRODUCT dimension is decoupled from the envelope gate:
  //     we ALWAYS extract a products[] array from raw_text (the contractor only
  //     ever sends one product, so we self-extract the full list), UNLESS the
  //     contractor already emitted a products[] array AND the envelope is
  //     complete (then no LLM call is needed at all). Each line is matched to a
  //     real SKU below; unmatched or multi-vendor → needs_review.
  const { fields: contractorFields, needsLlm: envelopeNeedsLlm } = extractContractorParse(row.raw_payload);
  const contractorProducts = extractContractorProducts(row.raw_payload);

  let extractionRaw: any = null;
  let source: 'contractor' | 'contractor+openrouter' | 'openrouter';

  // Envelope (start from contractor; LLM fills gaps below).
  let customerNameRaw     = contractorFields.customer_name      ?? null;
  let customerPhoneRaw    = contractorFields.customer_phone     ?? null;
  let customerPhoneAltRaw = contractorFields.customer_phone_alt ?? null;
  let rawAddressRaw       = contractorFields.raw_address        ?? null;
  // Delivery instructions are self-extracted from the raw message by our LLM —
  // the contractor doesn't send them, so there's no contractor field to merge.
  let deliveryInstructionsRaw: string | null = null;
  // Client's sales rep / closer named at the END of the forward. LLM-only (no
  // contractor field). Optional — null on most orders. Used at reconciliation.
  let clientRepRaw: string | null = null;
  let lineItems: LineItem[] = contractorProducts ?? [];
  let orderTotal: number | null =
    typeof contractorFields.customer_price === 'number' ? contractorFields.customer_price : null;

  // Call the LLM unless the contractor gave us BOTH a complete envelope AND a
  // products[] array. In practice (single product_name today) we always call.
  const needLlm = envelopeNeedsLlm || !contractorProducts;
  if (!needLlm) {
    source = 'contractor';
    // LLM didn't run, so the LLM-only client_rep would be lost. Recover it with a
    // tight deterministic trailing-name parse (the only signal is raw_text). We
    // do NOT run this on the LLM path — the model judges "no rep" correctly,
    // whereas a regex would invent one on the many no-rep messages.
    clientRepRaw = extractTrailingRep(row.raw_text);
  } else {
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id: inboundId, p_status: 'error', p_parse: null,
        p_delivery_id: null, p_error: 'OPENROUTER_API_KEY not configured',
      });
      return new Response('OPENROUTER_API_KEY missing', { status: 500 });
    }
    const out = await openrouterExtractProducts(row.raw_text, EXTRACTION_MODEL, apiKey);
    extractionRaw = out.raw;
    if (!out.parsed) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id: inboundId, p_status: 'error',
        p_parse: { extraction_raw: extractionRaw, extraction_model: EXTRACTION_MODEL, contractor_fields: contractorFields },
        p_delivery_id: null, p_error: 'openrouter extraction failed',
      });
      return new Response('extraction failed', { status: 200 });
    }
    // Envelope: contractor wins, LLM fills the gaps.
    customerNameRaw     = customerNameRaw     ?? out.parsed.customer_name;
    customerPhoneRaw    = customerPhoneRaw    ?? out.parsed.customer_phone;
    customerPhoneAltRaw = customerPhoneAltRaw ?? out.parsed.customer_phone_alt;
    // raw_address is the ONE envelope field where the contractor's regex is LESS
    // reliable than our LLM. Its pre-parse routinely over-captures the following
    // forwarded-message labels into the address — e.g.
    //   "Lekki phase 11. Lagos CUSTOMER PHN NUMBER: 0707... or 0707... PRODUCT"
    // which then tanks the location match (confidence "none" → needs_review).
    // Our LLM isolates the address field cleanly, so for THIS field we PREFER the
    // LLM's value and fall back to the contractor's only when the LLM didn't
    // return one. Every other envelope field keeps contractor-wins (the
    // contractor has SKU/name context the LLM lacks — see extractContractorParse).
    rawAddressRaw       = out.parsed.raw_address ?? rawAddressRaw;
    // Instructions: LLM-only (no contractor source). Best-effort, conservative
    // prompt — null on the vast majority of orders that carry no handling note.
    deliveryInstructionsRaw = out.parsed.instructions ?? null;
    // Client rep: LLM-only, the trailing closer name. null when the forward
    // doesn't end with one (most orders).
    clientRepRaw = out.parsed.client_rep ?? null;
    // Products: prefer a contractor-supplied array, else the LLM's array.
    if (lineItems.length === 0) lineItems = out.parsed.products ?? [];
    // Order total: LLM's Total line, else sum of line prices, else contractor's.
    if (orderTotal === null) {
      const lineSum = lineItems.reduce((s, li) => s + (li.customer_price ?? 0), 0);
      orderTotal = typeof out.parsed.total_amount === 'number' ? out.parsed.total_amount
                 : (lineSum > 0 ? lineSum : null);
    }
    source = Object.keys(contractorFields).length > 0 ? 'contractor+openrouter' : 'openrouter';
  }

  // Final fallback: no array surfaced but we have the contractor's single
  // product_name — wrap it into a 1-item array so a legacy single-product
  // message still flows (never silently dropped).
  if (lineItems.length === 0 && contractorFields.product_name) {
    lineItems = [{
      product_name:   contractorFields.product_name,
      quantity:       contractorFields.quantity ?? 1,
      customer_price: contractorFields.customer_price ?? null,
      free:           false,  // a contractor's single named product is never the freebie line
    }];
  }

  // ── Bowan structured template: trust the explicit | qty | column ──────────
  // Bowan forwards a fixed template ("Order Number: … Closer: … <product> | qty
  // | unit | total"). Both the LLM and the contractor mis-read the product-name
  // prefix (e.g. "3 - SUCTION SITUP-BAR" — "3 suction cups", not a count) as the
  // quantity; the real quantity is the column right after the first pipe. Read it
  // deterministically and trust neither AI for it. Gated on this client's template
  // markers + a unit×qty==total check, so it can NEVER fire on another client's
  // format. Scope = quantity of the paid product line(s) only — matching, product
  // names, free gifts and everything else are untouched. Every Bowan order to date
  // is single-line / single paid product; the regex reads the first line's qty and
  // the math guard rejects any mismatch.
  const bowanQty = bowanColumnQuantity(row.raw_text);
  if (bowanQty !== null) {
    for (const li of lineItems) {
      if ((li.customer_price ?? 0) > 0) li.quantity = bowanQty;
    }
  }

  const customerName  = customerNameRaw?.trim() || null;
  const customerPhone = normalizePhone(customerPhoneRaw);
  // Second number: only keep it if it's a real, DISTINCT phone — never store the
  // primary twice. (Any valid phone in a forward is the customer's; the prompt
  // keeps account/transfer numbers out.)
  let customerPhoneAlt = normalizePhone(customerPhoneAltRaw);
  if (customerPhoneAlt && customerPhoneAlt === customerPhone) customerPhoneAlt = null;
  const rawAddress    = rawAddressRaw?.trim() || null;
  const deliveryInstructions = deliveryInstructionsRaw?.trim() || null;
  const clientRep     = clientRepRaw?.trim() || null;
  const customerPrice = orderTotal !== null && orderTotal >= 0 ? orderTotal : null;

  // Optional client hint from contractor — disambiguates "same product name,
  // different client" cases by restricting product matching to one client.
  const clientHint = typeof (row.raw_payload as any)?.client_hint === 'string'
    ? (row.raw_payload as any).client_hint.trim().toLowerCase()
    : null;

  // Optional location hint from contractor — short-circuits the address
  // normalization pipeline when the upstream parser already picked a location.
  // Field lives inside `parsed` so it travels with the structured extraction.
  const locationHint = typeof (row.raw_payload as any)?.parsed?.location === 'string'
    ? (row.raw_payload as any).parsed.location.trim()
    : null;

  // Optional agent hint from contractor — pre-assigns the delivery to a
  // specific agent, skipping auto-assignment. Accepts a display name (case-
  // insensitive), email, or phone. Resolved against active agents only; if
  // the hint is ambiguous or doesn't match anyone, we ignore it and let
  // auto-assignment run as usual.
  const agentHintRaw = typeof (row.raw_payload as any)?.parsed?.assigned_agent === 'string'
    ? (row.raw_payload as any).parsed.assigned_agent.trim()
    : null;

  // 3. [Feature A] Per-line product match. Each extracted line resolves to a
  //    real SKU via match_products_by_text + the shared pickMatch rules. The
  //    whole order must resolve to ONE client (all matched lines agree); a
  //    bundle whose lines span clients → multi-vendor → needs_review. Any
  //    unmatched line also forces needs_review — never silently collapse.
  // [combo-split] Force known two-SKU combos ("Oratox Capsule and Powder",
  // "Clovofresh Capsule and Spray") into BOTH member SKUs, anchored on the raw
  // message so it works even when the LLM collapsed the set to one variant.
  lineItems = expandKnownCombos(lineItems, row.raw_text ?? '');

  const lineMatches: Array<{ line: LineItem; match: ProductMatch | null; candidates: any[] }> = [];
  for (const li of lineItems) {
    const name = li.product_name?.trim();
    if (!name) { lineMatches.push({ line: li, match: null, candidates: [] }); continue; }
    const { data: matches } = await supabase.rpc('match_products_by_text', {
      p_text: name,
      p_min_similarity: 0.4,
    });
    let pool: any[] = matches ?? [];
    // Contractor client hint narrows candidates so one client wins when two
    // clients share a product name (applied per line).
    if (clientHint) {
      const hinted = pool.filter(
        (m) => typeof m.client_name === 'string' && m.client_name.trim().toLowerCase() === clientHint,
      );
      if (hinted.length > 0) pool = hinted;
    }
    lineMatches.push({ line: li, match: pickMatch(pool as ProductMatch[]), candidates: pool });
  }

  const matchedLines     = lineMatches.filter((r) => r.match);
  const unmatchedLines   = lineMatches.filter((r) => !r.match);
  // [free-gift] An unmatched line the MESSAGE marked free (line.free) is a
  // promotional giveaway — "1 Free Nose Trimmer", "FREE DIGITAL BRACELET", a
  // bonus sachet — not a product the customer paid for. Drop it instead of
  // dragging the whole order to needs_review. We key off the extracted `free`
  // flag, NOT customer_price: per-line price is record-keeping only and is null
  // for most lines (clients send one total, rarely a per-product price), so
  // `=== 0` almost never fires and mis-routed real freebies to review. A genuine
  // unmatched product that ISN'T flagged free still blocks (we never silently
  // lose something the customer paid for).
  const blockingUnmatched = unmatchedLines.filter((r) => !r.line.free);
  const droppedFreeGifts  = unmatchedLines
    .filter((r) => r.line.free)
    .map((r) => r.line.product_name);
  const matchedClientIds = [...new Set(matchedLines.map((r) => r.match!.client_id))];
  const multiVendor      = matchedClientIds.length > 1;
  const orderClientId    = matchedClientIds.length === 1 ? matchedClientIds[0] : null;

  // p_items for bot_create_delivery (the RPC aggregates duplicate products).
  const resolvedItems = matchedLines.map((r) => ({
    product_catalog_id: r.match!.id,
    quantity_ordered:   r.line.quantity && r.line.quantity > 0 ? r.line.quantity : 1,
    customer_price:     r.line.customer_price ?? null,
  }));
  // Legacy single-product fields (dual-write): the first resolved line stands in.
  const primaryItem = resolvedItems[0] ?? null;

  // 4. Address normalization.
  let address: { match_log_id: string | null; matched_location_id: string | null; confidence: string } = {
    match_log_id: null,
    matched_location_id: null,
    confidence: 'none',
  };

  // 4a. If the contractor named a location, try to match it directly against
  //     our `locations` table by name or alias. Cheap, no API calls. We treat
  //     a single hit as 'high' confidence (the upstream parser asserted it).
  if (locationHint) {
    const lower = locationHint.toLowerCase();
    const { data: locs } = await supabase
      .from('locations')
      .select('id, name, aliases')
      .eq('is_active', true);
    const hits = (locs ?? []).filter((l: any) => {
      if (typeof l.name === 'string' && l.name.trim().toLowerCase() === lower) return true;
      const aliases = Array.isArray(l.aliases) ? l.aliases : [];
      return aliases.some((a: any) => typeof a === 'string' && a.trim().toLowerCase() === lower);
    });
    if (hits.length === 1) {
      address = {
        match_log_id:        null,
        matched_location_id: hits[0].id,
        confidence:          'high',
      };
    }
    // If 0 or >1 hits, leave address.matched_location_id null and fall through
    // to normalize-address below.
  }

  // 4b. Fallback: full Maps + Gemini address normalization. Runs when the
  //     contractor didn't supply a location hint or the hint didn't match
  //     uniquely. Itself gated by the `enable_address_normalization` flag.
  if (!address.matched_location_id && rawAddress) {
    const { data: addrData, error: addrErr } = await supabase.functions.invoke('normalize-address', {
      body: { raw_address: rawAddress },
      headers: { 'x-internal-secret': Deno.env.get('INTERNAL_FUNCTION_SECRET') ?? '' },
    });
    if (!addrErr && addrData) {
      address = {
        match_log_id:        addrData.match_log_id ?? null,
        matched_location_id: addrData.matched_location_id ?? null,
        confidence:          addrData.confidence ?? 'none',
      };
    }
  }

  // 4c. Resolve agent hint (parsed.assigned_agent) → user_id.
  //     Accept display_name (case-insensitive), email, or phone. We only
  //     honor a hint that resolves to exactly one active agent; anything
  //     ambiguous falls back to auto-assignment so we never silently pick
  //     the wrong rider.
  let agentResolution: { agent_id: string | null; reason: string } = { agent_id: null, reason: 'no_hint' };
  if (agentHintRaw) {
    const h = agentHintRaw.replace(/,/g, '');   // postgrest .or() uses comma as separator
    const filter = `display_name.ilike.${h},email.ilike.${h},phone.ilike.${h}`;
    const { data: agents, error: agentsErr } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'agent')
      .eq('is_active', true)
      .or(filter)
      .limit(3);
    if (agentsErr)               agentResolution = { agent_id: null, reason: `query_error: ${agentsErr.message}` };
    else if (!agents || agents.length === 0) agentResolution = { agent_id: null, reason: 'no_match' };
    else if (agents.length > 1)  agentResolution = { agent_id: null, reason: 'ambiguous' };
    else                         agentResolution = { agent_id: agents[0].id, reason: 'resolved' };
  }

  // 5. Outcome decision.
  const parseResult = {
    extracted: {
      customer_name:      customerNameRaw,
      customer_phone:     customerPhoneRaw,
      customer_phone_alt: customerPhoneAltRaw,
      raw_address:        rawAddressRaw,
      instructions:       deliveryInstructions,   // self-extracted handling note (null if none)
      client_rep:         clientRep,              // client's trailing rep/closer name (null if none)
      total_amount:       orderTotal,
      products:           lineItems,    // [Feature A] the full extracted line set
    },
    // [Feature A] per-line resolution: each line, its chosen SKU, and candidates.
    product_matches: lineMatches.map((r) => ({
      line:       r.line,
      matched:    r.match,
      candidates: r.candidates,
    })),
    items:             resolvedItems,                 // what we'll store as delivery_items
    client_id_conflict: multiVendor,                  // true → bundle spans clients
    unmatched_count:    blockingUnmatched.length,     // [free-gift] free unmatched lines don't count
    dropped_free_gifts: droppedFreeGifts,             // [free-gift] unmatched freebies we dropped
    order_client_id:    orderClientId,
    address,
    source,                  // "contractor" | "contractor+openrouter" | "openrouter"
    client_hint:   clientHint,    // null if contractor didn't supply one
    location_hint: locationHint,  // null if contractor didn't supply one
    agent_hint:    agentHintRaw,  // raw string from contractor, null if none
    agent_resolution: agentResolution, // { agent_id, reason } — for visibility in admin
    extraction_raw:   extractionRaw,                                  // null when source='contractor', LLM response body otherwise
    extraction_model: source === 'contractor' ? null : EXTRACTION_MODEL,
  };

  // Every line must match, all to ONE client, plus the usual envelope fields.
  // Unmatched line OR multi-vendor bundle → needs_review (never collapse).
  const haveAllFields =
    !!customerName && !!customerPhone && !!rawAddress &&
    !!address.matched_location_id && customerPrice !== null &&
    resolvedItems.length > 0 && blockingUnmatched.length === 0 &&
    !multiVendor && !!orderClientId;

  // Pipeline gating.
  if (!pipelineEnabled || shadowMode) {
    await supabase.rpc('mark_inbound_processed', {
      p_inbound_id:  inboundId,
      p_status:      'shadow_only',
      p_parse:       parseResult,
      p_delivery_id: null,
      p_error:       null,
    });
    return new Response('shadow_only', { status: 200 });
  }

  if (!haveAllFields) {
    await supabase.rpc('mark_inbound_processed', {
      p_inbound_id:  inboundId,
      p_status:      'needs_review',
      p_parse:       parseResult,
      p_delivery_id: null,
      p_error:       null,
    });
    return new Response('needs_review', { status: 200 });
  }

  // 6. Create delivery via bot_create_delivery RPC (impersonates an admin internally).
  const clientUuid = `bot:${inboundId}`;
  const { data: deliveryIdData, error: createErr } = await supabase.rpc('bot_create_delivery', {
    p_client_uuid:        clientUuid,
    p_client_id:          orderClientId!,
    p_product_catalog_id: primaryItem!.product_catalog_id,  // legacy primary (dual-write)
    p_customer_name:      customerName,
    p_customer_phone:     customerPhone,
    p_customer_phone_alt: customerPhoneAlt,
    p_raw_address:        rawAddress,
    p_quantity_ordered:   primaryItem!.quantity_ordered,    // legacy primary qty
    p_customer_price:     customerPrice,                    // single order total
    p_location_id:        address.matched_location_id,
    p_scheduled_date:     new Date().toISOString().slice(0, 10),
    p_bot_raw_message:    row.raw_text,
    p_assigned_agent_id:  agentResolution.agent_id,
    p_items:              resolvedItems,                    // [Feature A] line items
    p_delivery_instructions: deliveryInstructions,         // self-extracted handling note (null if none)
    p_client_rep:         clientRep,                        // client's trailing rep/closer name (null if none)
  });

  if (createErr) {
    // bot_create_delivery signals "the contractor's bot re-forwarded this
    // exact order to the same agent who already holds it" via a structured
    // P0001 with hint={kind:'duplicate_same_agent', existing_delivery_id}.
    // Don't treat it as an error — mark the inbound row as a duplicate of
    // the existing delivery. No new row, no second agent involved.
    //
    // Gate on errcode P0001 AND the JSON hint shape, so an unrelated future
    // exception path can't accidentally trigger this branch by emitting a
    // hint that JSON-parses with a matching `kind` field.
    let hint: any = null;
    const isOurSignal = (createErr as any).code === 'P0001'
                     && typeof (createErr as any).hint === 'string';
    if (isOurSignal) {
      try { hint = JSON.parse((createErr as any).hint); } catch { /* not our hint */ }
    }
    if (hint?.kind === 'duplicate_same_agent' && typeof hint.existing_delivery_id === 'string') {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id:  inboundId,
        p_status:      'duplicate',
        p_parse:       parseResult,
        p_delivery_id: hint.existing_delivery_id,
        p_error:       null,
      });
      return new Response(JSON.stringify({ delivery_id: hint.existing_delivery_id, duplicate: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    console.error('bot_create_delivery failed', createErr);
    await supabase.rpc('mark_inbound_processed', {
      p_inbound_id:  inboundId,
      p_status:      'error',
      p_parse:       parseResult,
      p_delivery_id: null,
      p_error:       createErr.message,
    });
    return new Response('create failed', { status: 200 });
  }

  const deliveryId = deliveryIdData as unknown as string;

  // Patch the address_match_log row with the new delivery_id (if we logged one).
  if (address.match_log_id) {
    await supabase
      .from('address_match_log')
      .update({ delivery_id: deliveryId })
      .eq('id', address.match_log_id);
  }

  await supabase.rpc('mark_inbound_processed', {
    p_inbound_id:  inboundId,
    p_status:      'created_delivery',
    p_parse:       parseResult,
    p_delivery_id: deliveryId,
    p_error:       null,
  });

  return new Response(JSON.stringify({ delivery_id: deliveryId }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
