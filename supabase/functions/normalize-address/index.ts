// Edge Function: normalize-address
// Resolve a raw address string to a known `locations` row.
//
// Pipeline:
//   1. Read enable_address_normalization flag. If off → confidence='none'.
//   2. Trigram pre-check against locations.name + aliases. If clear winner,
//      short-circuit (no API spend).
//   3. Google Maps geocode → formatted_address + (lat,lon) for context.
//   4. Gemini 2.5-flash → pick best location from candidates, return confidence.
//   5. Always write a row to address_match_log (delivery_id may be null).
//
// Returns:
//   { match_log_id, matched_location_id, confidence, maps_response, gemini_response }
//
// Deploy:  supabase functions deploy normalize-address
// Secrets: GOOGLE_MAPS_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const PROMPT_VERSION = 'normalize-address-v1';

type Confidence = 'high' | 'medium' | 'low' | 'none';

function clampConfidence(s: string | undefined | null): Confidence {
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'none';
}

async function geocodeAddress(rawAddress: string, mapsKey: string): Promise<any | null> {
  // Lagos-biased: bounds box loosely around Lagos State.
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', rawAddress);
  url.searchParams.set('components', 'country:NG');
  url.searchParams.set('bounds', '6.39,3.13|6.70,3.55');
  url.searchParams.set('key', mapsKey);
  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const json = await res.json();
    return json;
  } catch (e) {
    console.error('geocode fetch failed', e);
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function geminiPickLocation(
  rawAddress: string,
  mapsFormatted: string | null,
  mapsLocationType: string | null,
  candidates: { id: string; name: string; aliases: string[] | null }[],
  model: string,
  apiKey: string,
): Promise<{ raw: any; pickedId: string | null; confidence: Confidence } | null> {
  const candidateLines = candidates
    .map((c) => {
      const aliases = (c.aliases ?? []).join(', ');
      return `- ${c.id}  name="${c.name}"${aliases ? `  aliases=[${aliases}]` : ''}`;
    })
    .join('\n');

  const prompt = `You are matching a free-form Lagos, Nigeria address to one of a fixed list of known delivery locations (neighborhoods / districts).

Raw address from customer:
"${rawAddress}"

${mapsFormatted ? `Google Maps formatted version:\n"${mapsFormatted}"\n` : ''}${mapsLocationType ? `Google Maps location_type: ${mapsLocationType}\n` : ''}
Candidate locations:
${candidateLines}

Pick the single best matching location.id from the list. If no candidate is clearly the right neighborhood, return location_id=null.

**Out-of-Lagos safeguard — critical.** Customers occasionally write "Lagos" in their address when the actual street/neighborhood is in another Nigerian state (Edo/Benin, Delta, Rivers/Port Harcourt, FCT/Abuja, Oyo/Ibadan, Kano, Anambra, etc.). Google Maps is biased toward Lagos and will *force-match* such addresses to a random Lagos street, which then looks legitimate. **You must override that.** If you recognize any street name, landmark, or neighborhood in the raw address as belonging to a non-Lagos state, return location_id=null with confidence='none' — regardless of what Maps returned. Use your geographic knowledge of Nigeria.

**Maps quality awareness.** The location_type tells you how precise the geocode was:
- ROOFTOP / RANGE_INTERPOLATED = precise, street-level — generally trustworthy.
- GEOMETRIC_CENTER / APPROXIMATE = imprecise, often a fallback when Maps couldn't find the actual street. Treat the formatted address with suspicion; weight the raw address more heavily and consider whether Maps may have force-matched a non-Lagos location.

**Hyphen convention — important.** Location names containing a hyphen like "X - Y" denote a *road / corridor from X to Y*, not a single point. Any Lagos neighborhood that falls geographically along the road between X and Y belongs to that corridor at high confidence. Apply your knowledge of Lagos geography. Examples (illustrative — use your own knowledge, not just these):
- "Lekki - Chevron" covers everything along the Lekki–Epe Expressway from Lekki Phase 1 down to Chevron Drive: Lekki Phase 1, Ikate (Elegushi), Jakande, Agungi, Igbo Efon, Ologolo, Chevron, etc.
- "Ajah - Badore" covers the Ado-Langbasa-Badore road: Ado, Langbasa, Ogombo, Badore, etc.
- "Orchid - Ajah Under Bridge" covers the stretch from Orchid Hotel area past VGC, Sangotedo, and Abraham Adesanya to the Ajah flyover.

Use confidence:
- "high"   = the address explicitly names this neighborhood (or a well-known alias), OR the address names a neighborhood that clearly falls inside a hyphen-corridor candidate. No ambiguity. Address is unambiguously in Lagos.
- "medium" = strong indirect signal (street/landmark known to be in this neighborhood, or close fuzzy match, or plausible corridor membership), OR Maps gave an imprecise (GEOMETRIC_CENTER/APPROXIMATE) result you're not fully confident in.
- "low"    = weak signal, your best guess only.
- "none"   = cannot identify, OR you recognize the address as outside Lagos.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          location_id: { type: 'STRING', nullable: true },
          confidence:  { type: 'STRING', enum: ['high', 'medium', 'low', 'none'] },
          reasoning:   { type: 'STRING' },
        },
        required: ['confidence'],
      },
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('gemini error', res.status, errText);
      return { raw: { _http_status: res.status, _err: errText, _prompt_version: PROMPT_VERSION }, pickedId: null, confidence: 'none' };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { raw: { ...json, _no_text: true, _prompt_version: PROMPT_VERSION }, pickedId: null, confidence: 'none' };
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (e) { return { raw: { ...json, _parse_err: String(e), _prompt_version: PROMPT_VERSION }, pickedId: null, confidence: 'none' }; }
    const validId = candidates.some((c) => c.id === parsed.location_id) ? parsed.location_id : null;
    return {
      raw: { ...json, _parsed: parsed, _prompt_version: PROMPT_VERSION },
      pickedId: validId,
      confidence: clampConfidence(parsed.confidence),
    };
  } catch (e) {
    console.error('gemini fetch failed', e);
    return { raw: { _fetch_threw: String(e), _prompt_version: PROMPT_VERSION }, pickedId: null, confidence: 'none' };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response('invalid json', { status: 400 }); }

  const rawAddress: string = String(body.raw_address ?? '').trim();
  const deliveryId: string | null = body.delivery_id ?? null;
  if (!rawAddress) return new Response('raw_address required', { status: 400 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return new Response('server misconfigured', { status: 500 });
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Flag check.
  const { data: flagRow } = await supabase.rpc('get_flag', { p_key: 'enable_address_normalization' });
  const normalizationEnabled = !!flagRow?.enabled;

  let matchedLocationId: string | null = null;
  let confidence: Confidence = 'none';
  let mapsResponse: any = null;
  let geminiResponse: any = null;

  // Pull active candidates once (locations table is tiny — full scan is fine).
  const { data: locs } = await supabase
    .from('locations')
    .select('id, name, aliases')
    .eq('is_active', true);
  const candidates = (locs ?? []) as { id: string; name: string; aliases: string[] | null }[];

  if (!normalizationEnabled) {
    confidence = 'none';
  } else if (candidates.length === 0) {
    confidence = 'none';
  } else {
    // 1. Substring pre-check against names + aliases (locations set is small).
    //    Two-tier scoring:
    //      - Word-boundary match (alias appears as a distinct token in the raw
    //        address) → strong signal, scores 0.9. Saves a Gemini round-trip
    //        on cases like "Langbasa" inside a long full address.
    //      - Plain substring match (no word boundary) → legacy length-ratio
    //        score, threshold 0.45.
    //    Tunable upgrade later: a `match_location_trgm(raw)` RPC using pg_trgm.
    const lcRaw = rawAddress.toLowerCase();
    let trgmWinner: { id: string; score: number; boundary: boolean } | null = null;
    for (const c of candidates) {
      const haystack = [c.name, ...(c.aliases ?? [])].map((s) => s.toLowerCase());
      for (const h of haystack) {
        if (!h) continue;
        const wordRe = new RegExp(`(^|[^a-z0-9])${escapeRegex(h)}([^a-z0-9]|$)`, 'i');
        let score = 0;
        let boundary = false;
        if (wordRe.test(lcRaw)) {
          boundary = true;
          // Tie-break longer aliases above shorter ones (more specific).
          score = 0.9 + Math.min(0.09, h.length / 1000);
        } else if (lcRaw.includes(h) || h.includes(lcRaw)) {
          score = h.length / Math.max(lcRaw.length, h.length);
        }
        if (score > 0 && (!trgmWinner || score > trgmWinner.score)) {
          trgmWinner = { id: c.id, score, boundary };
        }
      }
    }
    if (trgmWinner && (trgmWinner.boundary || trgmWinner.score >= 0.45)) {
      matchedLocationId = trgmWinner.id;
      confidence = trgmWinner.score >= 0.8 ? 'high' : 'medium';
    }

    // 2. If we don't have a clear winner, call Maps + Gemini.
    if (confidence === 'none' || confidence === 'low') {
      const mapsKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
      let formatted: string | null = null;
      let locationType: string | null = null;
      if (mapsKey) {
        mapsResponse = await geocodeAddress(rawAddress, mapsKey);
        const top = mapsResponse?.results?.[0];
        formatted = top?.formatted_address ?? null;
        locationType = top?.geometry?.location_type ?? null;
      }

      // Model name from ai_config.
      const { data: modelCfg } = await supabase.rpc('get_ai_config', { p_key: 'gemini_model' });
      const model = (typeof modelCfg === 'string' ? modelCfg : 'gemini-2.5-flash');

      const geminiKey = Deno.env.get('GEMINI_API_KEY');
      if (geminiKey) {
        const gem = await geminiPickLocation(rawAddress, formatted, locationType, candidates, model, geminiKey);
        if (gem) {
          geminiResponse = gem.raw;
          if (gem.pickedId) {
            matchedLocationId = gem.pickedId;
            confidence = gem.confidence;
          } else {
            confidence = gem.confidence === 'none' ? 'none' : confidence;
          }
        }
      }
    }
  }

  // Always log to address_match_log (delivery_id may be null in shadow mode).
  const { data: logRow, error: logErr } = await supabase
    .from('address_match_log')
    .insert({
      delivery_id:         deliveryId,
      raw_address:         rawAddress,
      maps_response:       mapsResponse,
      gemini_response:     geminiResponse,
      matched_location_id: matchedLocationId,
      confidence,
    })
    .select('id')
    .single();

  if (logErr) {
    console.error('address_match_log insert failed', logErr);
    return new Response(JSON.stringify({
      match_log_id: null,
      matched_location_id: matchedLocationId,
      confidence,
      error: logErr.message,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    match_log_id: logRow.id,
    matched_location_id: matchedLocationId,
    confidence,
    maps_response: mapsResponse,
    gemini_response: geminiResponse,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
