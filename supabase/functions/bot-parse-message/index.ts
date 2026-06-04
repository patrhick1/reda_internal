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

const EXTRACTION_PROMPT_VERSION = 'bot-parse-v3-gpt-4.1-mini';
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
    required: ['customer_name', 'customer_phone', 'raw_address', 'product_name', 'quantity', 'customer_price'],
    properties: {
      customer_name:  { type: ['string',  'null'] },
      customer_phone: { type: ['string',  'null'] },
      raw_address:    { type: ['string',  'null'] },
      product_name:   { type: ['string',  'null'] },
      quantity:       { type: ['integer', 'null'] },
      customer_price: { type: ['number',  'null'] },
    },
  },
};

const EXTRACTION_PROMPT = `You are extracting a single delivery order from a WhatsApp message that a Reda client forwarded.

Return strict JSON with these fields (use null when missing):
  customer_name    : string  — the recipient's name. If the message has no name, use the customer_phone digits as the customer_name instead of returning null. Only return null if BOTH a name and a phone are missing.
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
    customer_name:  toStr(obj.customer_name),
    customer_phone: toStr(obj.customer_phone),
    raw_address:    toStr(obj.raw_address),
    product_name:   toStr(obj.product_name),
    quantity:       toInt(obj.quantity),
    customer_price: toNum(obj.customer_price),
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

function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits.length >= 10 ? digits : null;
}

async function resolveInboundId(body: any, supabase: any): Promise<string | null> {
  if (typeof body?.inbound_message_id === 'string') return body.inbound_message_id;
  if (body?.record?.id && typeof body.record.id === 'string') return body.record.id;
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

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

  // 2a. Read whatever the contractor's bot pre-parsed. If they populated all
  //     three load-bearing fields (product_name, raw_address, customer_phone)
  //     we skip the LLM entirely. Otherwise we call OpenRouter and MERGE —
  //     contractor's fields stay, LLM fills only the gaps. Product + location
  //     matching still run against our own tables — the contractor doesn't
  //     have our UUIDs.
  const { fields: contractorFields, needsLlm } = extractContractorParse(row.raw_payload);
  let parsed: Extracted;
  let extractionRaw: any = null;
  let source: 'contractor' | 'contractor+openrouter' | 'openrouter';

  if (!needsLlm) {
    // All load-bearing fields present in contractor's parse — trust it.
    parsed = contractorFields as Extracted;
    source = 'contractor';
  } else {
    // 2b. Fall through to OpenRouter / openai/gpt-4.1-mini. The merge below
    //     takes contractor's value when present, LLM's otherwise.
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id:  inboundId,
        p_status:      'error',
        p_parse:       null,
        p_delivery_id: null,
        p_error:       'OPENROUTER_API_KEY not configured',
      });
      return new Response('OPENROUTER_API_KEY missing', { status: 500 });
    }
    const out = await openrouterExtract(row.raw_text, EXTRACTION_MODEL, apiKey);
    extractionRaw = out.raw;
    if (!out.parsed) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id:  inboundId,
        p_status:      'error',
        p_parse:       { extraction_raw: extractionRaw, extraction_model: EXTRACTION_MODEL, contractor_fields: contractorFields },
        p_delivery_id: null,
        p_error:       'openrouter extraction failed',
      });
      return new Response('extraction failed', { status: 200 });
    }
    // Merge: contractor's value wins where present, LLM fills the rest.
    parsed = {
      customer_name:  contractorFields.customer_name  ?? out.parsed.customer_name,
      customer_phone: contractorFields.customer_phone ?? out.parsed.customer_phone,
      raw_address:    contractorFields.raw_address    ?? out.parsed.raw_address,
      product_name:   contractorFields.product_name   ?? out.parsed.product_name,
      quantity:       contractorFields.quantity       ?? out.parsed.quantity,
      customer_price: contractorFields.customer_price ?? out.parsed.customer_price,
    };
    source = Object.keys(contractorFields).length > 0 ? 'contractor+openrouter' : 'openrouter';
  }

  // `parsed` is now fully populated (contractor-only, merged, or LLM-only).
  // The OpenRouter branch returned early on extraction failure.
  const p = parsed;
  const customerName  = p.customer_name?.trim() || null;
  const customerPhone = normalizePhone(p.customer_phone);
  const rawAddress    = p.raw_address?.trim() || null;
  const productName   = p.product_name?.trim() || null;
  const quantity      = p.quantity && p.quantity > 0 ? p.quantity : 1;
  const customerPrice = p.customer_price && p.customer_price >= 0 ? p.customer_price : null;

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

  // 3. Product match → client_id.
  let productMatch: { id: string; client_id: string; client_name: string; product_name: string; score: number } | null = null;
  let productCandidates: any[] = [];
  if (productName) {
    const { data: matches } = await supabase.rpc('match_products_by_text', {
      p_text: productName,
      p_min_similarity: 0.4,
    });
    productCandidates = matches ?? [];

    // If the contractor supplied a client hint, filter candidates to that
    // client only. Lets one client win when two clients share a product name.
    let pool = productCandidates;
    if (clientHint) {
      const hinted = productCandidates.filter(
        (m) => typeof m.client_name === 'string' && m.client_name.trim().toLowerCase() === clientHint,
      );
      if (hinted.length > 0) pool = hinted;
    }

    if (pool.length === 1) {
      productMatch = pool[0];
    } else if (pool.length > 1) {
      // Multiple matches. If top score dominates AND all top matches are the same client_id, take it.
      const top = pool[0];
      const sameClient = pool.every((m) => m.client_id === top.client_id);
      if (sameClient) {
        // Same client, multiple product spellings — take the top.
        productMatch = top;
      } else if ((pool[1]?.score ?? 0) + 0.15 <= top.score) {
        // Clear winner across clients.
        productMatch = top;
      }
      // else: ambiguous, leave for review.
    }
  }

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
    extracted: parsed,
    product:   productMatch,
    product_candidates: productCandidates,
    address,
    source,                  // "contractor" | "contractor+openrouter" | "openrouter" — which pipeline produced `extracted`
    client_hint:   clientHint,    // null if contractor didn't supply one
    location_hint: locationHint,  // null if contractor didn't supply one
    agent_hint:    agentHintRaw,  // raw string from contractor, null if none
    agent_resolution: agentResolution, // { agent_id, reason } — for visibility in admin
    extraction_raw:   extractionRaw,                                  // null when source='contractor', LLM response body otherwise
    extraction_model: source === 'contractor' ? null : EXTRACTION_MODEL,
  };

  const haveAllFields =
    !!customerName && !!customerPhone && !!rawAddress &&
    !!productMatch && customerPrice !== null && quantity > 0 &&
    !!address.matched_location_id;

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
    p_client_id:          productMatch!.client_id,
    p_product_catalog_id: productMatch!.id,
    p_customer_name:      customerName,
    p_customer_phone:     customerPhone,
    p_raw_address:        rawAddress,
    p_quantity_ordered:   quantity,
    p_customer_price:     customerPrice,
    p_location_id:        address.matched_location_id,
    p_scheduled_date:     new Date().toISOString().slice(0, 10),
    p_bot_raw_message:    row.raw_text,
    p_assigned_agent_id:  agentResolution.agent_id,
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
