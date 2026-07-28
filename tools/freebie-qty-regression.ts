// Regression test for the "free giveaway inflates main product qty" fix.
// Runs the LIVE shared extraction prompt (PRODUCT_EXTRACTION_PROMPT) against a
// battery of cases and asserts the expected product/quantity shape, so we know
// the rule-3 tightening fixes the A520 case WITHOUT breaking other shapes
// (rule 2 same-product "buy N get M free", plain single, distinct multi,
// Opulent bundle). Creates nothing — read-only LLM calls.
//
// Run:
//   OPENROUTER_API_KEY=... deno run --allow-env --allow-net tools/freebie-qty-regression.ts
import {
  PRODUCT_EXTRACTION_SCHEMA,
  PRODUCT_EXTRACTION_PROMPT,
  coerceExtractedProducts,
  stripJsonFences,
} from '../supabase/functions/_shared/product-extract.ts';

const MODEL = 'openai/gpt-4.1-mini';

async function extract(text: string) {
  const apiKey = Deno.env.get('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: PRODUCT_EXTRACTION_SCHEMA },
      messages: [{ role: 'user', content: PRODUCT_EXTRACTION_PROMPT.replace('{{TEXT}}', text) }],
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '';
  return coerceExtractedProducts(JSON.parse(stripJsonFences(content)));
}

type Expect = { name: RegExp; qty: number; free: boolean };
type Case = { label: string; text: string; expect: Expect[] };

// Each `expect` entry must match exactly one extracted product (by name regex),
// with the given qty + free flag. Extra/missing products are failures.
const CASES: Case[] = [
  {
    label: 'FIX TARGET: earbuds 1 PCS + 1 free bracelet (distinct freebie)',
    text: 'Name: Oduntan oriyomi Phone 1: +2348088701046 Address: Oshodi, Lagos Product: A520 TWS EARBUDS 1 PCS + 1 FREE DIGITAL BRACELET Price: NGN24,000',
    expect: [
      { name: /earbud/i, qty: 1, free: false },
      { name: /bracelet/i, qty: 1, free: true },
    ],
  },
  {
    label: 'FIX TARGET variant: 2 PCS + 1 free bracelet (main qty must stay 2)',
    text: 'Name: Test Phone 1: +2348000000000 Address: Lagos Product: A520 TWS EARBUDS 2 PCS + 1 FREE DIGITAL BRACELET Price: NGN40,000',
    expect: [
      { name: /earbud/i, qty: 2, free: false },
      { name: /bracelet/i, qty: 1, free: true },
    ],
  },
  {
    label: 'RULE 2 GUARD: buy-2-get-1-free SAME product folds to qty 3 (must NOT regress)',
    text: 'Name: Test Phone 1: +2348000000000 Address: Lagos Product: Buy 2 Water Filter Get 1 FREE Price: NGN30,000',
    expect: [{ name: /water filter/i, qty: 3, free: false }],
  },
  {
    label: 'PLAIN SINGLE: one product, qty 1, no freebie',
    text: 'Name: Test Phone 1: +2348000000000 Address: Lagos Product: Hairline Shadow Stick Price: NGN15,000',
    expect: [{ name: /hairline|shadow/i, qty: 1, free: false }],
  },
  {
    label: 'DISTINCT MULTI: two paid products, separate lines',
    text: 'Name: Test Phone 1: +2348000000000 Address: Lagos Product: 1 Antivirus Cleanser and 5 Gallant Max Price: NGN50,000',
    expect: [
      { name: /antivirus|cleanser/i, qty: 1, free: false },
      { name: /gallant/i, qty: 5, free: false },
    ],
  },
  {
    label: 'OPULENT BUNDLE: expands to two products, no freebie',
    text: 'Name: Test Phone 1: +2348000000000 Address: Lagos Product: 1 Opulent X Khamrah Price: NGN35,000',
    expect: [
      { name: /opulent/i, qty: 1, free: false },
      { name: /khamrah/i, qty: 1, free: false },
    ],
  },
];

function check(products: { product_name: string | null; quantity: number | null; free: boolean }[], expect: Expect[]) {
  const fails: string[] = [];
  const used = new Set<number>();
  for (const e of expect) {
    const idx = products.findIndex(
      (p, i) => !used.has(i) && e.name.test(p.product_name ?? ''),
    );
    if (idx < 0) {
      fails.push(`  MISSING product matching ${e.name} (qty ${e.qty}, free ${e.free})`);
      continue;
    }
    used.add(idx);
    const p = products[idx];
    if ((p.quantity ?? -1) !== e.qty) fails.push(`  ${p.product_name}: qty ${p.quantity} != expected ${e.qty}`);
    if (p.free !== e.free) fails.push(`  ${p.product_name}: free ${p.free} != expected ${e.free}`);
  }
  const extra = products.filter((_, i) => !used.has(i));
  for (const p of extra) fails.push(`  UNEXPECTED extra product: ${p.product_name} (qty ${p.quantity}, free ${p.free})`);
  return fails;
}

let pass = 0;
let fail = 0;
for (const c of CASES) {
  const out = await extract(c.text);
  const products = out?.products ?? [];
  const fails = check(products, c.expect);
  const shape = products.map((p) => `${p.product_name}×${p.quantity}${p.free ? '(free)' : ''}`).join(', ');
  if (fails.length === 0) {
    console.log(`PASS  ${c.label}\n      -> ${shape}`);
    pass++;
  } else {
    console.log(`FAIL  ${c.label}\n      -> ${shape}`);
    for (const f of fails) console.log(f);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
