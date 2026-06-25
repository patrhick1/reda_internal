// Prompt-contract and extraction-helper regression tests.
// Run: deno test supabase/functions/_shared/product-extract.test.ts
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  PRODUCT_EXTRACTION_PROMPT,
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

Deno.test('combo: brand-less variant fragment is absorbed, not orphaned', () => {
  // The LLM split "Clovofresh Capsule and Spray" into a branded line + a bare
  // "Spray" (no brand). Both must collapse to exactly the two canonical SKUs —
  // the bare "Spray" must NOT survive as a spurious third line.
  const raw = 'Product: Clovofresh Capsule and Spray Price: NGN19500';
  const out = expandKnownCombos([li('Clovofresh Capsule', 1, 19500), li('Spray', 1)], raw);
  assertEquals(names(out), ['Clovofresh Capsule x1', 'Clovofresh Spray x1']);
});

Deno.test('combo: bare variant word WITHOUT its combo phrase is left untouched', () => {
  // Absorption only fires when the combo phrase is confirmed in the raw text.
  const out = expandKnownCombos([li('Spray', 1, 3000)], 'Product: Spray 1 unit');
  assertEquals(names(out), ['Spray x1']);
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

// --- prompt contract ---------------------------------------------------------

Deno.test('prompt: explicit quantity survives package-selection wording', () => {
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    'SELECT YOUR PACKAGE 2 Dashboard Umbrella = ₦55,000',
  );
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    '"product_name":"Dashboard Umbrella","quantity":2',
  );
});

Deno.test('prompt: "PACK OF N" counts containers, not inner units (stock per pack)', () => {
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    'means N CONTAINERS, each holding M items',
  );
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    'product_name:"Filter Mesh", quantity:1',
  );
});

Deno.test('prompt: quantity rules cover same-product extras and independent line quantities', () => {
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    'A number immediately before a product name is normally that product\'s quantity',
  );
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    '"product_name":"Stand Again Oil","quantity":3',
  );
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    '"product_name":"Normal Arabian Tea","quantity":2',
  );
  assertStringIncludes(
    PRODUCT_EXTRACTION_PROMPT,
    '"product_name":"Double Arabian Tea","quantity":3',
  );
});

Deno.test('prompt: complete examples preserve strict-schema fields and field boundaries', () => {
  const exampleOutputs = PRODUCT_EXTRACTION_PROMPT.match(/Output: \{[^\n]+\}/g) ?? [];
  assertEquals(exampleOutputs.length, 5);
  for (const output of exampleOutputs) {
    const parsed = JSON.parse(output.slice('Output: '.length));
    assertEquals(Object.keys(parsed).sort(), [
      'client_rep',
      'customer_name',
      'customer_phone',
      'customer_phone_alt',
      'instructions',
      'products',
      'raw_address',
      'total_amount',
    ]);
    for (const product of parsed.products) {
      assertEquals(Object.keys(product).sort(), [
        'customer_price',
        'free',
        'product_name',
        'quantity',
      ]);
    }
  }
  assertStringIncludes(PRODUCT_EXTRACTION_PROMPT, 'Do NOT put');
  assertStringIncludes(PRODUCT_EXTRACTION_PROMPT, '"Payment on Delivery"');
  assertStringIncludes(PRODUCT_EXTRACTION_PROMPT, '"Assigned to:"');
});

// --- extractTrailingRep (deterministic fallback for the LLM-skip path) -------

Deno.test('extractTrailingRep: clean standalone final name', () => {
  const raw = [
    'CUSTOMER NAME: Amaka',
    'PRODUCT: Buy 3 Water Filter Get 2 FREE (5) — ₦60,000',
    '',
    'Linda',
  ].join('\n');
  assertEquals(extractTrailingRep(raw), 'Linda');
  assertEquals(extractTrailingRep(`${raw}\nMary Ribue Ofre`), 'Mary Ribue Ofre');
});

Deno.test('extractTrailingRep: legacy labels and decorated names are not captured', () => {
  assertEquals(extractTrailingRep('PRODUCT: Water Filter\nAvailable for delivery Linda'), null);
  assertEquals(extractTrailingRep('PRODUCT: Water Filter\nCloser: Linda'), null);
  assertEquals(extractTrailingRep('PRODUCT: Water Filter\nAssigned to: Miracle'), null);
  assertEquals(extractTrailingRep('PRODUCT NAME: Gold Package\n\n(Cynthia)'), null);
});

Deno.test('extractTrailingRep: ambiguous place/day/landmark tokens are not captured', () => {
  assertEquals(extractTrailingRep('(Ikorodu)'), null);
  assertEquals(extractTrailingRep('(Chevron)'), null);
  assertEquals(extractTrailingRep('(Monday)'), null);
  assertEquals(extractTrailingRep('Available for delivery'), null);
});

Deno.test('extractTrailingRep: no rep present → null (no false positives)', () => {
  assertEquals(extractTrailingRep('PRODUCT: Fire Stop Spray\nCUSTOMER ADDRESS: 92 Sagamu Road Ikorodu. Lagos'), null);
  assertEquals(extractTrailingRep('(opposite the blue church)'), null); // landmark
  assertEquals(extractTrailingRep('Total: ₦60,000'), null);
  assertEquals(extractTrailingRep('09079700010'), null); // bare phone
  assertEquals(extractTrailingRep(''), null);
  assertEquals(extractTrailingRep(null), null);
  assert(!PRODUCT_EXTRACTION_PROMPT.includes('Available for delivery Linda" → "Linda'));
});
