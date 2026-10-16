import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { pickMatchWithClientHint } from './vendor-classify.ts';
import type { ProductMatch } from './product-extract.ts';

const sku = (id: string, client_name: string, score: number, client_id = client_name): ProductMatch =>
  ({ id, client_id, client_name, score });

Deno.test('hint cannot replace the clear Oralis match with Oratox', () => {
  for (const scores of [[1, 0.578947], [0.823529, 0.47619]]) {
    const pool = [sku('oralis', 'JQ', scores[0]), sku('oratox', 'Dentora', scores[1])];
    const before = structuredClone(pool);
    assertEquals(pickMatchWithClientHint(pool, 'Dentora'), { match: pool[0], outcome: 'ignored_clear_match' });
    assertEquals(pool, before, 'The audit must retain the original pool');
  }
});
Deno.test('correct or missing hint preserves the normal catalog match', () => {
  const pool = [sku('oralis', 'JQ', 1), sku('oratox', 'Dentora', 0.58)];
  assertEquals(pickMatchWithClientHint(pool, ' jq ').outcome, 'confirmed_clear_match');
  for (const hint of [null, '']) assertEquals(pickMatchWithClientHint(pool, hint), {match:pool[0],outcome:'no_hint'});
});
Deno.test('hint can break a genuine shared-name vendor tie with case and whitespace normalization', () => {
  const pool = [sku('a', 'Vendor A', 1), sku('b', ' Vendor B ', 1)];
  assertEquals(pickMatchWithClientHint(pool, ' vEnDoR b '), {match:pool[1],outcome:'resolved_vendor_tie'});
});
Deno.test('hint without a credible contender leaves the full-pool tie unresolved', () => {
  const pool = [sku('a', 'A', 1), sku('b', 'B', 1), sku('c', 'C', 0.41)];
  assertEquals(pickMatchWithClientHint(pool, 'C'), {match:null,outcome:'ignored_not_contender'});
  assertEquals(pickMatchWithClientHint(pool, 'Missing'), {match:null,outcome:'ignored_not_contender'});
});
Deno.test('hint cannot promote low-score candidates below the vendor floor', () => {
  const pool = [sku('a', 'A', 0.48), sku('b', 'B', 0.42)];
  assertEquals(pickMatchWithClientHint(pool, 'B'), {match:null,outcome:'ignored_not_contender'});
});
Deno.test('hint respects the existing cross-vendor margin at its boundary', () => {
  const pool = [sku('a', 'A', 1), sku('b', 'B', 0.85)];
  assertEquals(pickMatchWithClientHint(pool, 'B'), {match:pool[0],outcome:'ignored_clear_match'});
});
Deno.test('ambiguous SKUs within the hinted vendor still need review', () => {
  const pool = [sku('a', 'A', 1), sku('b1', 'B', 1), sku('b2', 'B', 0.98)];
  assertEquals(pickMatchWithClientHint(pool, 'B'), {match:null,outcome:'ambiguous_hinted_products'});
});
Deno.test('same-vendor SKU ties and empty catalogs cannot be resolved by a vendor hint', () => {
  for (const pool of [[], [sku('a1', 'A', 1), sku('a2', 'A', 0.98)]]) {
    assertEquals(pickMatchWithClientHint(pool, 'A'), {match:null,outcome:'ignored_not_vendor_tie'});
  }
});
Deno.test('duplicate vendor display names do not choose an arbitrary client', () => {
  const pool = [sku('a', 'Shared', 1, 'client-a'), sku('b', 'Shared', 1, 'client-b')];
  assertEquals(pickMatchWithClientHint(pool, 'Shared'), {match:null,outcome:'ignored_ambiguous_vendor'});
});
