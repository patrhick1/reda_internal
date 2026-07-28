// Re-validate the NEW extraction prompt against REAL orders, no prod impact.
// Pulls (a) recent orders that went to review with an unmatched line — these
// SHOULD now resolve — and (b) recent clean auto-created orders — these MUST
// still resolve (regression guard). Runs the shared array extraction (with the
// edited prompt) + per-line match + pickMatch, and tallies each set separately.
//
// Run:
//   OPENROUTER_API_KEY=... SUPABASE_DB_URI=... \
//   deno run --allow-env --allow-run --allow-net tools/multiproduct-revalidate.ts
import {
  PRODUCT_EXTRACTION_SCHEMA,
  PRODUCT_EXTRACTION_PROMPT,
  coerceExtractedProducts,
  stripJsonFences,
  pickMatch,
  type ProductMatch,
} from '../supabase/functions/_shared/product-extract.ts';

const MODEL = 'openai/gpt-4.1-mini';
const dec = new TextDecoder();
const CUTOVER = '2026-06-16 20:00:00+01';

async function psql(sql: string): Promise<string> {
  const uri = Deno.env.get('SUPABASE_DB_URI');
  if (!uri) throw new Error('SUPABASE_DB_URI not set');
  const { code, stdout, stderr } = await new Deno.Command('psql', {
    args: [uri, '-At', '-F', '\t', '-c', sql], stdout: 'piped', stderr: 'piped',
  }).output();
  if (code !== 0) throw new Error(dec.decode(stderr));
  return dec.decode(stdout).trim();
}

async function matchLine(name: string): Promise<ProductMatch[]> {
  const safe = name.replace(/'/g, "''");
  const out = await psql(
    `select id, client_id, coalesce(client_name,''), coalesce(product_name,''), score
       from public.match_products_by_text('${safe}', 0.4) order by score desc`);
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [id, client_id, client_name, product_name, score] = l.split('\t');
    return { id, client_id, client_name, product_name, score: Number(score) } as ProductMatch;
  });
}

async function extract(text: string) {
  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0,
      messages: [{ role: 'user', content: PRODUCT_EXTRACTION_PROMPT.replace('{{TEXT}}', text) }],
      response_format: { type: 'json_schema', json_schema: PRODUCT_EXTRACTION_SCHEMA },
    }),
  });
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  try { return coerceExtractedProducts(JSON.parse(stripJsonFences(content))); } catch { return null; }
}

function pull(sql: string) {
  return psql(sql).then((raw) =>
    raw.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('\t');
      return { id: l.slice(0, i), text: l.slice(i + 1) };
    }));
}

const failing = await pull(
  `select id, replace(replace(raw_text, chr(10),' '), chr(9),' ')
     from public.bot_inbound_messages
    where received_at > '${CUTOVER}'
      and (parse_result->>'unmatched_count')::int > 0
    order by received_at desc limit 25`);

const passing = await pull(
  `select id, replace(replace(raw_text, chr(10),' '), chr(9),' ')
     from public.bot_inbound_messages
    where received_at > '${CUTOVER}' and status='created_delivery'
      and parse_result is not null
      and coalesce((parse_result->>'unmatched_count')::int,0)=0
      and not coalesce((parse_result->>'client_id_conflict')::bool,false)
    order by received_at desc limit 12`);

async function evaluate(text: string): Promise<{ ok: boolean; why: string; lines: string[] }> {
  const ex = await extract(text);
  if (!ex) return { ok: false, why: 'extraction failed', lines: [] };
  const resolved: string[] = [], unmatched: string[] = [], clients = new Set<string>();
  const lines: string[] = [];
  for (const li of ex.products) {
    if (!li.product_name) continue;
    const m = pickMatch(await matchLine(li.product_name));
    if (m) { resolved.push(li.product_name); clients.add((m as any).client_name); lines.push(`"${li.product_name}"×${li.quantity ?? 1} → ${(m as any).product_name}`); }
    else { unmatched.push(li.product_name); lines.push(`"${li.product_name}"×${li.quantity ?? 1} → ✗`); }
  }
  const multiVendor = clients.size > 1;
  const ok = resolved.length > 0 && unmatched.length === 0 && !multiVendor;
  const why = ok ? `client=${[...clients][0]}` :
    [unmatched.length ? `${unmatched.length} unmatched` : '', multiVendor ? `multi-vendor(${[...clients].join('/')})` : '', resolved.length === 0 ? 'no match' : ''].filter(Boolean).join('; ');
  return { ok, why, lines };
}

console.log(`\n========== RE-VALIDATION (new prompt, creates nothing) ==========`);
let fFixed = 0;
console.log(`\n--- WAS-FAILING set (${failing.length}) — should now CREATE ---`);
for (const m of failing) {
  const r = await evaluate(m.text);
  if (r.ok) fFixed++;
  console.log(`${r.ok ? '✅ FIXED ' : '❌ still '} ${m.text.slice(0, 75)}`);
  for (const l of r.lines) console.log(`        ${l}`);
  if (!r.ok) console.log(`        why: ${r.why}`);
}
let pKept = 0;
console.log(`\n--- WAS-PASSING set (${passing.length}) — must STILL create (regression guard) ---`);
for (const m of passing) {
  const r = await evaluate(m.text);
  if (r.ok) pKept++;
  console.log(`${r.ok ? '✅ ok    ' : '⚠️ REGRESSED '} ${m.text.slice(0, 70)}  (${r.why})`);
}
console.log(`\n========== RESULT ==========`);
console.log(`WAS-FAILING now create:  ${fFixed}/${failing.length}`);
console.log(`WAS-PASSING still create: ${pKept}/${passing.length}  (regressions: ${passing.length - pKept})`);
