// Edge Function: enumerate-corridor-aliases
//
// One-off helper to populate `locations.aliases` for hyphen-named corridor
// locations like "Lekki - Chevron". The hyphen means "from X to Y" — every
// Lagos neighborhood on that road belongs to the corridor, but Uzo doesn't
// have all the names by heart, so we let Gemini propose them and Google
// Maps verify each one exists.
//
// Pipeline per corridor:
//   1. Parse start + end from the name (split on " - ").
//   2. Gemini → propose neighborhoods along the route, with common aliases.
//   3. For each proposed neighborhood, Maps Geocoding API → verify it
//      resolves inside Lagos. Drop anything that doesn't.
//   4. Return JSON: { id, name, verified_aliases, dropped, gemini_raw }.
//
// Returns the proposal as JSON only — no DB writes. Review then apply
// manually via SQL.
//
// Input (optional):
//   { corridor_id?: uuid }  — limit to one corridor; default: all hyphenated.
//
// Deploy:  supabase functions deploy enumerate-corridor-aliases --no-verify-jwt
// Secrets: GOOGLE_MAPS_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { denyIfNotInternal } from '../_shared/internal-auth.ts';

const PROMPT_VERSION = 'enumerate-corridor-aliases-v1';

const PROMPT_TEMPLATE = `You are enumerating Lagos, Nigeria neighborhoods that fall along a specific road / corridor.

The corridor is named "<<CORRIDOR>>" — this means the road / route from "<<START>>" to "<<END>>". Any neighborhood, estate, or well-known landmark that someone delivering on this road would pass through (or that a customer would name when ordering a delivery somewhere along it) belongs to this corridor.

Return a JSON object with one field, "neighborhoods", containing an array. Each entry has:
- "canonical": the most commonly written / official name (e.g. "Lekki Phase 1").
- "aliases": an array of alternate spellings, abbreviations, or common informal names (e.g. ["Lekki Phase I", "Lekki Ph 1", "Phase 1 Lekki"]). Include the canonical form too if customers commonly write it differently. Do not include the corridor's own start/end names ("<<START>>", "<<END>>") as aliases — those are the corridor endpoints, not aliases of intermediate neighborhoods.

Rules:
- High recall. Err on the side of including a neighborhood if it's plausibly on this road.
- Real Lagos places only. No invented names.
- Include sub-areas, popular estates, well-known landmarks, common bus stops.
- 8 to 25 neighborhoods is a reasonable range for most corridors.
- Skip the start and end themselves — they're already the corridor endpoints.`;

async function geminiPropose(
  corridorName: string,
  startName: string,
  endName: string,
  model: string,
  apiKey: string,
): Promise<{ raw: any; neighborhoods: { canonical: string; aliases: string[] }[] }> {
  const prompt = PROMPT_TEMPLATE
    .replaceAll('<<CORRIDOR>>', corridorName)
    .replaceAll('<<START>>', startName)
    .replaceAll('<<END>>', endName);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          neighborhoods: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                canonical: { type: 'STRING' },
                aliases:   { type: 'ARRAY', items: { type: 'STRING' } },
              },
              required: ['canonical', 'aliases'],
            },
          },
        },
        required: ['neighborhoods'],
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
    throw new Error(`gemini ${res.status}: ${errText}`);
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = {}; }
  const neighborhoods = Array.isArray(parsed.neighborhoods) ? parsed.neighborhoods : [];
  return {
    raw: { ...json, _prompt_version: PROMPT_VERSION },
    neighborhoods: neighborhoods.filter((n: any) => n && typeof n.canonical === 'string'),
  };
}

async function verifyInLagos(name: string, mapsKey: string): Promise<boolean> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', `${name}, Lagos, Nigeria`);
  url.searchParams.set('components', 'country:NG');
  url.searchParams.set('bounds', '6.39,3.13|6.70,3.55');
  url.searchParams.set('key', mapsKey);
  try {
    const res = await fetch(url.toString());
    if (!res.ok) return false;
    const json = await res.json();
    const top = json?.results?.[0];
    if (!top) return false;
    // Confirm Lagos appears somewhere in the address components.
    const comps = top.address_components ?? [];
    const seesLagos = comps.some((c: any) =>
      (c.long_name === 'Lagos' || c.short_name === 'LA') &&
      Array.isArray(c.types) && c.types.includes('administrative_area_level_1'),
    );
    return seesLagos;
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Internal/admin-only: no public caller. Avoids API-cost abuse + location enumeration.
  const denied = denyIfNotInternal(req);
  if (denied) return denied;

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const onlyCorridorId: string | null = typeof body.corridor_id === 'string' ? body.corridor_id : null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mapsKey     = Deno.env.get('GOOGLE_MAPS_API_KEY');
  const geminiKey   = Deno.env.get('GEMINI_API_KEY');
  if (!supabaseUrl || !serviceKey || !mapsKey || !geminiKey) {
    return new Response('server misconfigured: missing one of SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_MAPS_API_KEY, GEMINI_API_KEY', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let q = supabase.from('locations')
    .select('id, name, aliases')
    .eq('is_active', true)
    .ilike('name', '% - %');
  if (onlyCorridorId) q = q.eq('id', onlyCorridorId);

  const { data: locs, error: locErr } = await q;
  if (locErr) return new Response(JSON.stringify({ error: locErr.message }), { status: 500 });

  const { data: modelCfg } = await supabase.rpc('get_ai_config', { p_key: 'gemini_model' });
  const model = (typeof modelCfg === 'string' ? modelCfg : 'gemini-2.5-flash');

  const corridors: any[] = [];
  for (const row of (locs ?? [])) {
    const parts = row.name.split(' - ');
    if (parts.length !== 2) {
      corridors.push({ id: row.id, name: row.name, skipped: 'name does not match "X - Y" pattern' });
      continue;
    }
    const [start, end] = parts.map((s: string) => s.trim());

    let proposed: { canonical: string; aliases: string[] }[];
    let geminiRaw: any;
    try {
      const g = await geminiPropose(row.name, start, end, model, geminiKey);
      proposed   = g.neighborhoods;
      geminiRaw  = g.raw;
    } catch (e: any) {
      corridors.push({ id: row.id, name: row.name, error: `gemini: ${e.message}` });
      continue;
    }

    const verified: { canonical: string; aliases: string[] }[] = [];
    const dropped:  { canonical: string; reason: string }[]    = [];
    for (const n of proposed) {
      const ok = await verifyInLagos(n.canonical, mapsKey);
      if (ok) verified.push(n);
      else    dropped.push({ canonical: n.canonical, reason: 'maps did not resolve to Lagos' });
    }

    // Flatten verified entries into a single alias array (canonical + aliases),
    // deduped case-insensitively. Also exclude the corridor's own endpoints.
    const blocked = new Set([start.toLowerCase(), end.toLowerCase(), row.name.toLowerCase()]);
    const seen = new Set<string>();
    const flat: string[] = [];
    for (const n of verified) {
      const candidates = [n.canonical, ...n.aliases];
      for (const c of candidates) {
        const t = c.trim();
        if (!t) continue;
        const k = t.toLowerCase();
        if (blocked.has(k) || seen.has(k)) continue;
        seen.add(k);
        flat.push(t);
      }
    }

    corridors.push({
      id:                 row.id,
      name:               row.name,
      existing_aliases:   row.aliases ?? [],
      proposed_neighborhoods: verified,
      dropped,
      flattened_aliases:  flat,
      _gemini_raw:        geminiRaw,
    });
  }

  return new Response(JSON.stringify({ corridors, _prompt_version: PROMPT_VERSION }, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
