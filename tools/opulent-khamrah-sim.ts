// Focused simulation: how does the CURRENT prompt + live matcher handle
// "Opulent X Khamrah" payloads? Pulls real distinct raw_texts from the inbound
// table, runs the shared extraction + per-line match_products_by_text + pickMatch,
// and prints each line's resolution. Creates nothing.
//
// Run:
//   OPENROUTER_API_KEY=... SUPABASE_DB_URI=... \
//   deno run --allow-env --allow-run --allow-net tools/opulent-khamrah-sim.ts
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

async function psql(sql: string): Promise<string> {
  const uri = Deno.env.get('SUPABASE_DB_URI');
  if (!uri) throw new Error('SUPABASE_DB_URI not set');
  const { code, stdout, stderr } = await new Deno.Command('psql', {
    args: [uri, '-At', '-F', '\t', '-c', sql], stdout: 'piped', stderr: 'piped',
    env: { PGCLIENTENCODING: 'UTF8' },
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

// distinct recent Opulent X Khamrah payloads (one per customer/order)
const raw = await psql(
  `select distinct on (left(raw_text,40)) replace(replace(raw_text, chr(10),' '), chr(9),' ')
     from public.bot_inbound_messages
    where (raw_text ilike '%opulent%' and raw_text ilike '%khamrah%')
    order by left(raw_text,40), received_at desc limit 14`);
const messages = raw.split('\n').filter(Boolean);

console.log(`\n========== OPULENT X KHAMRAH SIM (${messages.length} payloads, creates nothing) ==========`);
let ok = 0;
for (const text of messages) {
  const ex = await extract(text);
  console.log(`\n■ ${text.slice(0, 90)}`);
  if (!ex) { console.log('   extraction FAILED'); continue; }
  const clients = new Set<string>();
  let unmatched = 0;
  for (const li of ex.products) {
    if (!li.product_name) continue;
    const m = pickMatch(await matchLine(li.product_name));
    if (m) { clients.add((m as any).client_name); console.log(`   ✓ "${li.product_name}"×${li.quantity ?? 1} → ${(m as any).product_name} [${(m as any).client_name}]`); }
    else { unmatched++; console.log(`   ✗ "${li.product_name}"×${li.quantity ?? 1} → no match`); }
  }
  const multiVendor = clients.size > 1;
  const pass = ex.products.length > 0 && unmatched === 0 && !multiVendor;
  if (pass) ok++;
  console.log(`   => ${pass ? 'CREATE' : 'REVIEW'}${unmatched ? ` (${unmatched} unmatched)` : ''}${multiVendor ? ` (multi-vendor: ${[...clients].join('/')})` : ''}`);
}
console.log(`\n========== ${ok}/${messages.length} would auto-create ==========`);
