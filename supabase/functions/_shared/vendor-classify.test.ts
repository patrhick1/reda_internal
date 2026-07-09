// Vendor-classifier contract + trigger tests (no network).
// Run: deno test supabase/functions/_shared/vendor-classify.test.ts
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isCrossVendorTie,
  vendorContenders,
  buildCandidateBlock,
  VENDOR_CLASSIFIER_PROMPT,
  VENDOR_CLASSIFIER_SCHEMA,
  CROSS_VENDOR_FLOOR,
  CROSS_VENDOR_BAND,
  type VendorCandidate,
} from './vendor-classify.ts';
import type { ProductMatch } from './product-extract.ts';

const pm = (id: string, client_id: string, score: number, client_name = client_id): ProductMatch => ({
  id,
  client_id,
  client_name,
  product_name: id,
  score,
});

// --- isCrossVendorTie: fires ONLY for same-name/different-vendor ties ---------

Deno.test('isCrossVendorTie: two vendors tied on the same name -> true (the arabian-tea case)', () => {
  const pool = [pm('teaA', 'vendorA', 1.0, 'Vendor A'), pm('teaB', 'vendorB', 1.0, 'Vendor B')];
  assert(isCrossVendorTie(pool));
});

Deno.test('isCrossVendorTie: near-tie across vendors within band -> true', () => {
  assert(isCrossVendorTie([pm('a', 'A', 0.60), pm('b', 'B', 0.50)])); // 0.50 + 0.15 > 0.60
});

Deno.test('isCrossVendorTie: top vendor clearly beats the other vendor -> false', () => {
  assert(!isCrossVendorTie([pm('a', 'A', 0.95), pm('b', 'B', 0.50)])); // 0.50 + 0.15 <= 0.95
});

Deno.test('isCrossVendorTie: all candidates same vendor -> false (that is pickMatch same-client turf)', () => {
  assert(!isCrossVendorTie([pm('a', 'A', 1.0), pm('b', 'A', 1.0)]));
});

Deno.test('isCrossVendorTie: below score floor -> false (genuine weak/no match)', () => {
  assert(!isCrossVendorTie([pm('a', 'A', 0.40), pm('b', 'B', 0.40)])); // both < 0.45 floor
});

Deno.test('isCrossVendorTie: single candidate or empty -> false', () => {
  assert(!isCrossVendorTie([pm('a', 'A', 1.0)]));
  assert(!isCrossVendorTie([]));
});

Deno.test('isCrossVendorTie: top from vendor A, tied runner-up ALSO A, weak B -> false', () => {
  // top two are same vendor (A resolves via pickMatch), the only other vendor is far below.
  assert(!isCrossVendorTie([pm('a1', 'A', 1.0), pm('a2', 'A', 0.99), pm('b', 'B', 0.30)]));
});

// --- vendorContenders: the distinct vendors worth asking about ----------------

Deno.test('vendorContenders: returns both tied vendors, sorted by best score', () => {
  const pool = [pm('teaA', 'vendorA', 0.9, 'Vendor A'), pm('teaB', 'vendorB', 1.0, 'Vendor B')];
  const c = vendorContenders(pool);
  assertEquals(c.length, 2);
  assertEquals(c[0].client_id, 'vendorB'); // higher score first
  assertEquals(c[0].client_name, 'Vendor B');
  assertEquals(c[1].client_id, 'vendorA');
});

Deno.test('vendorContenders: excludes vendors clearly beaten or below floor', () => {
  const pool = [pm('a', 'A', 1.0), pm('b', 'B', 0.98), pm('c', 'C', 0.30)];
  const c = vendorContenders(pool);
  assertEquals(c.map((x) => x.client_id).sort(), ['A', 'B']); // C dropped (below floor & beaten)
});

Deno.test('vendorContenders: one contender per vendor even with multiple SKUs', () => {
  const pool = [pm('a1', 'A', 1.0), pm('a2', 'A', 0.99), pm('b', 'B', 0.95)];
  const c = vendorContenders(pool);
  assertEquals(c.length, 2);
  assertEquals(c.find((x) => x.client_id === 'A')?.best_score, 1.0); // keeps A's BEST sku score
});

// --- prompt / schema contract -------------------------------------------------

Deno.test('prompt: instructs style-based choice and allows a 0 "unsure" answer', () => {
  assertStringIncludes(VENDOR_CLASSIFIER_PROMPT, 'HOW THE MESSAGE IS WRITTEN');
  assertStringIncludes(VENDOR_CLASSIFIER_PROMPT, 'return 0');
  assertStringIncludes(VENDOR_CLASSIFIER_PROMPT, 'Never guess');
  assertStringIncludes(VENDOR_CLASSIFIER_PROMPT, '{{CANDIDATES}}');
  assertStringIncludes(VENDOR_CLASSIFIER_PROMPT, '{{TEXT}}');
});

Deno.test('schema: strict, required vendor_number/confidence/reason, no extra keys', () => {
  assertEquals(VENDOR_CLASSIFIER_SCHEMA.strict, true);
  assertEquals(VENDOR_CLASSIFIER_SCHEMA.schema.additionalProperties, false);
  assertEquals(
    [...VENDOR_CLASSIFIER_SCHEMA.schema.required].sort(),
    ['confidence', 'reason', 'vendor_number'],
  );
});

Deno.test('buildCandidateBlock: numbers vendors 1..N and includes their examples', () => {
  const cands: VendorCandidate[] = [
    { client_id: 'A', client_name: 'Decency Stores', examples: ['ORDER: normal arabian tea\nQty: 1'] },
    { client_id: 'B', client_name: 'Rival Ltd', examples: ['normal arabian tea x1 — pls deliver'] },
  ];
  const block = buildCandidateBlock(cands);
  assertStringIncludes(block, '[1] Vendor: Decency Stores');
  assertStringIncludes(block, '[2] Vendor: Rival Ltd');
  assertStringIncludes(block, 'normal arabian tea');
});

Deno.test('buildCandidateBlock: vendor with no examples is labelled, not dropped', () => {
  const block = buildCandidateBlock([
    { client_id: 'A', client_name: 'A Co', examples: [] },
    { client_id: 'B', client_name: 'B Co', examples: ['hi'] },
  ]);
  assertStringIncludes(block, '[1] Vendor: A Co');
  assertStringIncludes(block, '(no example messages available)');
});

// --- constants sanity ---------------------------------------------------------

Deno.test('trigger thresholds are sane (floor keeps weak matches out; band = pickMatch cross-client gate)', () => {
  assert(CROSS_VENDOR_FLOOR > 0 && CROSS_VENDOR_FLOOR < 1);
  assertEquals(CROSS_VENDOR_BAND, 0.15);
});
