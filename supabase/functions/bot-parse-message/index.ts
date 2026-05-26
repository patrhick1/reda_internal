// Edge Function: bot-parse-message
// Fired by Supabase Database Webhook on INSERT into bot_inbound_messages
// (or invoked directly with `{ inbound_message_id }` for replay).
//
// Pipeline per row:
//   1. Skip if status != 'queued' (idempotency).
//   2. Gemini 2.5-flash structured extraction → { customer_name, customer_phone,
//      raw_address, product_name, quantity, customer_price }.
//   3. Match product via match_products_by_text RPC → resolves client_id.
//   4. Call normalize-address → location_id + confidence.
//   5. Decide outcome based on flags:
//        - enable_bot_pipeline=false OR bot_shadow_mode=true → 'shadow_only'
//        - fully resolved → bot_create_delivery → 'created_delivery'
//        - anything missing → 'needs_review'
//   6. mark_inbound_processed updates the row atomically.
//
// Deploy:  supabase functions deploy bot-parse-message
// Secrets: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//          (also GOOGLE_MAPS_API_KEY for normalize-address — set there)

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const EXTRACTION_PROMPT_VERSION = 'bot-parse-v1';

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

// Read a pre-parsed delivery from the inbound row's raw_payload, if the
// upstream bot included one. Shape matches what Gemini would emit so the
// downstream code can treat both sources uniformly. Returns null if no
// usable parse is present (missing block, wrong types, or empty).
function extractContractorParse(raw_payload: any): Extracted | null {
  const p = raw_payload?.parsed;
  if (!p || typeof p !== 'object') return null;
  const name  = typeof p.customer_name  === 'string' ? p.customer_name  : null;
  const phone = typeof p.customer_phone === 'string' ? p.customer_phone : null;
  const addr  = typeof p.raw_address    === 'string' ? p.raw_address    : null;
  const prod  = typeof p.product_name   === 'string' ? p.product_name   : null;
  const qty   = typeof p.quantity       === 'number' ? p.quantity       : null;
  const price = typeof p.customer_price === 'number' ? p.customer_price : null;
  // Need at minimum a product name to be useful. If nothing meaningful is
  // present, fall through to Gemini rather than half-trust their parse.
  if (!prod) return null;
  return {
    customer_name:  name,
    customer_phone: phone,
    raw_address:    addr,
    product_name:   prod,
    quantity:       qty,
    customer_price: price,
  };
}

async function geminiExtract(text: string, model: string, apiKey: string): Promise<{ parsed: Extracted | null; raw: any }> {
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
          customer_name:  { type: 'STRING', nullable: true },
          customer_phone: { type: 'STRING', nullable: true },
          raw_address:    { type: 'STRING', nullable: true },
          product_name:   { type: 'STRING', nullable: true },
          quantity:       { type: 'INTEGER', nullable: true },
          customer_price: { type: 'NUMBER', nullable: true },
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

  // 2a. If the contractor pre-parsed the message, trust their fields and skip
  //     Gemini entirely. Saves an API call + 1-2s of latency per message.
  //     We still run product + location matching against our own tables — the
  //     contractor doesn't have our UUIDs.
  const contractorParsed = extractContractorParse(row.raw_payload);
  let parsed: Extracted | null = null;
  let geminiRaw: any = null;
  let source: 'contractor' | 'gemini' = 'gemini';

  if (contractorParsed) {
    parsed = contractorParsed;
    source = 'contractor';
  } else {
    // Gemini model name.
    const { data: modelCfg } = await supabase.rpc('get_ai_config', { p_key: 'gemini_model' });
    const model = typeof modelCfg === 'string' ? modelCfg : 'gemini-2.5-flash';

    // 2b. Gemini extraction (fallback when no contractor parse).
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id:  inboundId,
        p_status:      'error',
        p_parse:       null,
        p_delivery_id: null,
        p_error:       'GEMINI_API_KEY not configured',
      });
      return new Response('GEMINI_API_KEY missing', { status: 500 });
    }
    const out = await geminiExtract(row.raw_text, model, geminiKey);
    parsed    = out.parsed;
    geminiRaw = out.raw;
    if (!parsed) {
      await supabase.rpc('mark_inbound_processed', {
        p_inbound_id:  inboundId,
        p_status:      'error',
        p_parse:       { gemini: geminiRaw },
        p_delivery_id: null,
        p_error:       'gemini extraction failed',
      });
      return new Response('extraction failed', { status: 200 });
    }
  }

  // At this point `parsed` is guaranteed non-null — either from contractor or
  // from Gemini (Gemini path returns early on null above).
  const p = parsed!;
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
    source,                  // "contractor" | "gemini" — which pipeline produced `extracted`
    client_hint:   clientHint,    // null if contractor didn't supply one
    location_hint: locationHint,  // null if contractor didn't supply one
    agent_hint:    agentHintRaw,  // raw string from contractor, null if none
    agent_resolution: agentResolution, // { agent_id, reason } — for visibility in admin
    gemini_extraction_raw: geminiRaw, // null on the contractor path
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
