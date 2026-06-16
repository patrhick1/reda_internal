// Multi-Product dry-run — validates the NEW intake end-to-end on REAL messages
// without touching production. Pulls real Original Buy bundle messages, runs the
// shared array extraction (OpenRouter) + per-line match_products_by_text +
// pickMatch, and prints exactly what each message WOULD create (or why it would
// go to needs_review). Creates nothing.
//
// Run:
//   OPENROUTER_API_KEY=... SUPABASE_DB_URI=... \
//   deno run --allow-env --allow-run --allow-net tools/multiproduct-dryrun.ts
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

// Pull a varied set of real Original Buy bundle messages.
const raw = await psql(
  `select distinct on (left(d.bot_raw_message,40))
          d.id, replace(replace(d.bot_raw_message, chr(10), ' '), chr(9), ' ')
     from public.deliveries d join public.clients c on c.id = d.client_id
    where c.name = 'Original Buy' and bot_raw_message is not null
      and bot_raw_message ilike '%perfume oil%' and bot_raw_message like '%+%'
    order by left(bot_raw_message,40), d.created_at desc
    limit 5`);
const messages = raw.split('\n').filter(Boolean).map((l) => {
  const i = l.indexOf('\t');
  return { id: l.slice(0, i), text: l.slice(i + 1) };
});

console.log(`\n=== Multi-Product DRY-RUN — ${messages.length} real Original Buy bundles (creates nothing) ===\n`);

let wouldCreate = 0, wouldReview = 0;
for (const [n, m] of messages.entries()) {
  console.log(`\n──────── Message ${n + 1} (delivery ${m.id.slice(0, 8)}) ────────`);
  console.log(`raw: ${m.text.slice(0, 160)}${m.text.length > 160 ? '…' : ''}`);
  const ex = await extract(m.text);
  if (!ex) { console.log('  ⚠️  extraction failed → needs_review'); wouldReview++; continue; }
  console.log(`  customer: ${ex.customer_name ?? '—'} | phone: ${ex.customer_phone ?? '—'} | total: ${ex.total_amount ?? '—'}`);
  console.log(`  extracted ${ex.products.length} line(s):`);

  const resolved: { name: string; sku: string; client: string; score: number }[] = [];
  const unmatched: string[] = [];
  for (const li of ex.products) {
    if (!li.product_name) continue;
    const cands = await matchLine(li.product_name);
    const m2 = pickMatch(cands);
    if (m2) {
      resolved.push({ name: li.product_name, sku: (m2 as any).product_name, client: (m2 as any).client_name, score: m2.score });
      console.log(`    • "${li.product_name}" ×${li.quantity ?? 1}  →  ${(m2 as any).product_name} [${(m2 as any).client_name}] (score ${m2.score.toFixed(2)})`);
    } else {
      unmatched.push(li.product_name);
      console.log(`    • "${li.product_name}" ×${li.quantity ?? 1}  →  ✗ NO CONFIDENT MATCH`);
    }
  }
  const clients = [...new Set(resolved.map((r) => r.client))];
  const multiVendor = clients.length > 1;
  if (resolved.length > 0 && unmatched.length === 0 && !multiVendor) {
    console.log(`  ✅ WOULD CREATE: 1 delivery, ${resolved.length} item(s), client=${clients[0]}, one fee`);
    wouldCreate++;
  } else {
    const why = [
      unmatched.length ? `${unmatched.length} unmatched line(s)` : '',
      multiVendor ? `multi-vendor (${clients.join(', ')})` : '',
      resolved.length === 0 ? 'no matched products' : '',
    ].filter(Boolean).join('; ');
    console.log(`  ⛓  WOULD ROUTE TO needs_review: ${why}`);
    wouldReview++;
  }
}

console.log(`\n=== Summary: ${wouldCreate} would create · ${wouldReview} would need review ===\n`);
