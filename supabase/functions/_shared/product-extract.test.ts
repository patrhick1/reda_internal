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
  extractWrappedRep,
  extractLabeledRep,
  extractVendorOrderRef,
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

// --- vendor order reference -------------------------------------------------

Deno.test('vendor order ref: extracted from a stamped forward', () => {
  const raw = [
    '📦 ORDER DETAILS',
    'Order #: ORD-20260625-PTS-00506',
    'Date: Jun 25, 2026 08:44 AM',
    'Name: JUBRIL RAZAQ',
    'Catherine',
  ].join('\n');
  assertEquals(extractVendorOrderRef(raw), 'ORD-20260625-PTS-00506');
});

Deno.test('vendor order ref: lowercased input is normalized to uppercase', () => {
  assertEquals(extractVendorOrderRef('order #: ord-20260625-cfm-02599'), 'ORD-20260625-CFM-02599');
});

Deno.test('vendor order ref: null/blank/absent → null', () => {
  assertEquals(extractVendorOrderRef(null), null);
  assertEquals(extractVendorOrderRef(undefined), null);
  assertEquals(extractVendorOrderRef('Name: Ada\nMarina, Lagos\nLinda'), null);
  // near-miss shapes must not match
  assertEquals(extractVendorOrderRef('ORD-2026-PTS-1'), null);   // short date / seq
  assertEquals(extractVendorOrderRef('ORDER-20260625-PTS-00506'), null); // wrong prefix
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
  assertEquals(exampleOutputs.length, 7);
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

// --- extractWrappedRep (recovers the wrapped tail sign-off the LLM drops) -----
// Forwards arrive as a SINGLE line (no newlines), so the rep is the wrapped
// token at the very END of the message — not a "final line".

Deno.test('extractWrappedRep: wrapped sign-off at the tail of a single-line forward', () => {
  const base =
    'CUSTOMER NAME: Engr Destiny CUSTOMER ADDRESS: No 5 Orodu street Ajegunle Apapa. Lagos ' +
    'CUSTOMER PHN NUMBER: 08025710900 PRODUCT NAME: Gold Package - ₦36,000 Buy 2 Fire Stop Spray Get 1 FREE';
  assertEquals(extractWrappedRep(`${base} (Praise)`), 'Praise');   // parens (LLM drops these)
  assertEquals(extractWrappedRep(`${base} *Pamela*`), 'Pamela');   // asterisks
  assertEquals(extractWrappedRep(`${base} [Chisom]`), 'Chisom');   // brackets
  assertEquals(extractWrappedRep(`${base}(Gift)`), 'Gift');        // no leading space
  assertEquals(extractWrappedRep('PRODUCT NAME: Gold Package\n\n(Cynthia)'), 'Cynthia'); // multi-line too
  assertEquals(extractWrappedRep('Order for Ada *Mary Ribue Ofre*'), 'Mary Ribue Ofre'); // up to 3 words
});

Deno.test('extractWrappedRep: only the TAIL token, never a mid-message wrap', () => {
  // A bolded field label in the middle must not be mistaken for the rep.
  assertEquals(extractWrappedRep('*CUSTOMER NAME:* Engr Destiny PRODUCT: Gold Package (Praise)'), 'Praise');
  // No wrapped token at the tail → null even if one appears earlier.
  assertEquals(extractWrappedRep('(Praise) CUSTOMER NAME: Engr Destiny PRODUCT: Gold Package'), null);
});

Deno.test('extractWrappedRep: non-name wrapped tails are rejected', () => {
  assertEquals(extractWrappedRep('PRODUCT: Gold Package (please call on arrival)'), null); // >3 words
  assertEquals(extractWrappedRep('PRODUCT: Gold Package (opposite the blue church)'), null); // landmark phrase
  assertEquals(extractWrappedRep('PRODUCT: Gold Package (urgent)'), null);   // lowercase, not title-case
  assertEquals(extractWrappedRep('PRODUCT: Gold Package (Thanks)'), null);   // stopword
  assertEquals(extractWrappedRep('PRODUCT: Gold Package (08025710900)'), null); // digits
  // Bolded ALL-CAPS instruction at the tail is not a rep; a single all-caps name is.
  assertEquals(extractWrappedRep('1 OPULENT OUD -- #98,000 *CONFIRM SPECIFIC TIME*'), null);
  assertEquals(extractWrappedRep('PRODUCT: Gold Package *CHINECHEREM*'), 'CHINECHEREM');
});

// --- extractLabeledRep ("Call rep <name>" tail, recovers the LLM's coin-flip) -

Deno.test('extractLabeledRep: explicit "call rep" label, lowercase name Title-cased', () => {
  const base =
    'Name: Ogochukwu Phone 1: +2348069639718 Address: Mushin, Lagos, Nigeria ' +
    'Product: Stand Again Oil 2 Unit Price: NGN30,000';
  assertEquals(extractLabeledRep(`${base} Call rep patience`), 'Patience');
  assertEquals(extractLabeledRep(`${base} CALL REP patience`), 'Patience'); // shouted variant
  assertEquals(extractLabeledRep(`${base} Call the rep Patience`), 'Patience');
  assertEquals(extractLabeledRep(`${base} call rep: Mary Ann`), 'Mary Ann'); // colon + 2 words
});

Deno.test('extractLabeledRep: only the TAIL, and non-name tails rejected', () => {
  // "call rep" earlier in the message but a normal tail → no match.
  assertEquals(extractLabeledRep('Call rep patience Name: Ogochukwu Product: Oil'), null);
  assertEquals(extractLabeledRep('Product: Oil Call rep please'), null); // stopword
  assertEquals(extractLabeledRep('Product: Oil please call the customer'), null); // no "rep"
  assertEquals(extractLabeledRep('Product: Oil Call rep'), null); // label with no name
});

Deno.test('extractLabeledRep: blank/absent → null', () => {
  assertEquals(extractLabeledRep(''), null);
  assertEquals(extractLabeledRep(null), null);
  assertEquals(extractLabeledRep(undefined), null);
});

Deno.test('extractWrappedRep: no wrapped tail / blank → null', () => {
  assertEquals(extractWrappedRep('CUSTOMER NAME: Engr Destiny PRODUCT: Gold Package Buy 2 Get 1 FREE'), null);
  assertEquals(extractWrappedRep('Catherine'), null); // bare trailing name is NOT a wrapped sign-off
  assertEquals(extractWrappedRep(''), null);
  assertEquals(extractWrappedRep(null), null);
  assertEquals(extractWrappedRep(undefined), null);
});
