// Tests for expandKnownCombos — run: deno test supabase/functions/_shared/product-extract.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  coerceExtractedProducts,
  expandKnownCombos,
  extractTrailingRep,
  type LineItem,
} from './product-extract.ts';

const li = (p: string, q = 1, price: number | null = null, free = false): LineItem => ({
  product_name: p,
  quantity: q,
  customer_price: price,
  free,
});
const names = (xs: LineItem[]) => xs.map((x) => `${x.product_name} x${x.quantity}`).sort();

Deno.test('combo: LLM collapsed to one variant → both SKUs restored', () => {
  const raw = 'Name: Caroline Product: Oratox Capsule and Powder 1 unit Price: NGN19,500';
  const out = expandKnownCombos([li('Oratox Capsule', 1, 19500)], raw); // Powder dropped by LLM
  assertEquals(names(out), ['Oratox Capsule x1', 'Oratox Powder x1']);
  assertEquals(out.find((x) => x.product_name === 'Oratox Capsule')!.customer_price, 19500);
  assertEquals(out.find((x) => x.product_name === 'Oratox Powder')!.customer_price, null);
});

Deno.test('combo: quantity carries to both lines (3 units)', () => {
  const raw = 'Product: Oratox Capsule and Powder 3 units Price: NGN58,500';
  const out = expandKnownCombos([li('Oratox Capsule', 3, 58500)], raw);
  assertEquals(names(out), ['Oratox Capsule x3', 'Oratox Powder x3']);
});

Deno.test('combo: clovofresh capsule and spray → two SKUs', () => {
  const raw = 'Product: Clovofresh Capsule and Spray 1 unit Price: NGN19,500';
  const out = expandKnownCombos([li('Clovofresh Capsule', 1, 19500)], raw);
  assertEquals(names(out), ['Clovofresh Capsule x1', 'Clovofresh Spray x1']);
});

Deno.test('combo: idempotent — already-split lines do not duplicate', () => {
  const raw = 'Product: Oratox Capsule and Powder 1 unit';
  const out = expandKnownCombos([li('Oratox Capsule', 1, 19500), li('Oratox Powder', 1)], raw);
  assertEquals(names(out), ['Oratox Capsule x1', 'Oratox Powder x1']); // exactly two, no dup
});

Deno.test('combo present + unrelated product → only the combo expands', () => {
  const raw = 'Product: Oratox Capsule and Powder 1 unit + Mint Spray 1';
  const out = expandKnownCombos([li('Oratox Capsule', 1, 19500), li('Mint Spray', 1, 5000)], raw);
  assertEquals(names(out), ['Mint Spray x1', 'Oratox Capsule x1', 'Oratox Powder x1']);
});

// --- regression / over-match safety ----------------------------------------

Deno.test('single variant (no "and powder") is left untouched', () => {
  const raw = 'Product: Oratox Capsule 1 unit'; // genuine single-variant order
  const out = expandKnownCombos([li('Oratox Capsule', 1, 9000)], raw);
  assertEquals(names(out), ['Oratox Capsule x1']); // NOT split
});

Deno.test('other client conjunction products never split', () => {
  for (const p of ['D&N Arabian Tea', 'Wine Opener/Beer Opener', 'A7 Plus/Factor', 'Aswad Spray set']) {
    const out = expandKnownCombos([li(p, 1, 1000)], `Product: ${p} 1`);
    assertEquals(names(out), [`${p} x1`], `${p} must not split`);
  }
});

Deno.test('no combo phrase in raw → passthrough unchanged', () => {
  const lines = [li('Cadix Capsule', 2, 8000), li('Fire Stop Spray', 1)];
  const out = expandKnownCombos(lines, 'Product: Cadix Capsule x2 and Fire Stop Spray');
  assertEquals(names(out), ['Cadix Capsule x2', 'Fire Stop Spray x1']);
});

// --- client_rep coercion ----------------------------------------------------

Deno.test('client_rep: trailing rep name is carried through coercion', () => {
  const out = coerceExtractedProducts({
    customer_name: 'Amaka',
    customer_phone: '09079700010',
    client_rep: 'Linda',
    products: [],
  });
  assertEquals(out?.client_rep, 'Linda');
});

Deno.test('client_rep: trimmed, and blank/absent → null', () => {
  assertEquals(coerceExtractedProducts({ client_rep: '  Cynthia ', products: [] })?.client_rep, 'Cynthia');
  assertEquals(coerceExtractedProducts({ client_rep: '   ', products: [] })?.client_rep, null);
  assertEquals(coerceExtractedProducts({ products: [] })?.client_rep, null); // field omitted
});

// --- extractTrailingRep (deterministic fallback for the LLM-skip path) -------

Deno.test('extractTrailingRep: "Available for delivery <Name>" tail', () => {
  const raw = [
    'CUSTOMER NAME: Amaka',
    'PRODUCT: Buy 3 Water Filter Get 2 FREE (5) — ₦60,000',
    '',
    '👤 Available for delivery Linda',
    '📞',
  ].join('\n');
  assertEquals(extractTrailingRep(raw), 'Linda');
});

Deno.test('extractTrailingRep: "Available for delivery <Name>" survives trailing emoji line', () => {
  const raw = 'PRODUCT: x\n👤 Available for delivery Linda\n📞';
  assertEquals(extractTrailingRep(raw), 'Linda');
});

Deno.test('extractTrailingRep: lone parenthesised token is NOT captured (place/day/landmark ambiguity)', () => {
  // A bare "(Name)" is structurally identical to a place/day/note — we skip it
  // rather than risk storing a location as a rep. The LLM handles "(Cynthia)" on
  // the live path; this fallback intentionally misses it.
  assertEquals(extractTrailingRep('PRODUCT NAME: Gold Package\n\n(Cynthia)'), null);
  assertEquals(extractTrailingRep('(Ikorodu)'), null);
  assertEquals(extractTrailingRep('(Chevron)'), null);
  assertEquals(extractTrailingRep('(Monday)'), null);
});

Deno.test('extractTrailingRep: no rep present → null (no false positives)', () => {
  assertEquals(extractTrailingRep('PRODUCT: Fire Stop Spray\nCUSTOMER ADDRESS: 92 Sagamu Road Ikorodu. Lagos'), null);
  assertEquals(extractTrailingRep('(opposite the blue church)'), null); // landmark
  assertEquals(extractTrailingRep('Total: ₦60,000'), null);
  assertEquals(extractTrailingRep('09079700010'), null); // bare phone
  assertEquals(extractTrailingRep(''), null);
  assertEquals(extractTrailingRep(null), null);
});
