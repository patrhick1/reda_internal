import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyPerfumeGiftPolicy, giftPackingInstructions, PERFUME_VENDOR_ID, type ProductResolution } from './perfume-gifts.ts';
const oud = '67f486ef-d7c5-4934-8f54-4916abda42df';
const pacific = 'd36c6537-3d12-40ac-b14d-aaf46c805932';
const main = (name: string, catalog = 'Arabiyat Oud Al Layl EDP', id = oud): ProductResolution => ({
  line: { product_name: name, quantity: 1, customer_price: null, free: false },
  match: { id, client_id: PERFUME_VENDOR_ID, client_name: 'Zael NG', product_name: catalog, score: .75 }, candidates: [],
});
const oil = (name = 'Touch Concentrated Perfume Oil 5ml Alcohol Free'): ProductResolution => ({
  line: { product_name: name, quantity: 2, customer_price: null, free: false }, match: null, candidates: [],
});
const ready = (r: ReturnType<typeof applyPerfumeGiftPolicy>) => r.applied && r.reviewReasons.length === 0
  && r.rows.every(x => x.match || x.line.free);

Deno.test('catalog renaming preserves approved SKU eligibility and old names', () => {
  for (const name of ['Arabiyat Oud Al Layl EDP', 'Oud Al Layl Perfume']) {
    assert(ready(applyPerfumeGiftPolicy([main(name), oil('Touch Perfume Oil')], '')));
  }
  const renamed = main('New Opulent display name', 'New Opulent display name', '125334f2-d69a-4431-8356-47b15687a7d5');
  assert(ready(applyPerfumeGiftPolicy([renamed, oil('Perfume Oil')], '')));
});
Deno.test('Pacific Blue old and current names identify the same approved SKU', () => {
  for (const name of ['Pacific Blue Perfume', 'Maison Alhambra Pacific Blue EDP']) {
    assert(ready(applyPerfumeGiftPolicy([main(name, 'Maison Alhambra Pacific Blue EDP', pacific), oil('Atomizer')], '')));
  }
});
Deno.test('reported full main name and stored extraction variants keep quantity and packing count', () => {
  for (const name of ['Arabiyat Oud Al Layl EDP Perfume', 'Arabiyat Oud Al Layl EDP 100ml Perfume For Men and Women']) {
    const input = [main(name), oil()]; const before = JSON.stringify(input);
    const r = applyPerfumeGiftPolicy(input, 'Main offer; total 32500');
    assert(ready(r)); assertEquals(r.rows.length, 1); assertEquals(r.rows[0].line.quantity, 1);
    assertEquals(r.ignored, [{ product_name: 'Perfume Oil', quantity: 2 }]);
    assertEquals(giftPackingInstructions(null, r.ignored), 'Included gifts: Perfume Oil ×2.');
    assertEquals(JSON.stringify(input), before, 'Never mutate stored extraction evidence');
  }
});
Deno.test('concentrated oil variants work with implicit and explicit gifts', () => {
  for (const name of ['Touch Concentrated Perfume Oil', 'Touch Concentrated Perfume Oil Alcohol Free',
    'Touch Concentrated Perfume Oil 5ml Alcohol Free', 'Touch Concentrated Perfume Oil 5 ml Alcohol Free']) {
    for (const free of [false, true]) {
      const gift = oil(name); gift.line.free = free;
      assert(ready(applyPerfumeGiftPolicy([main('Oud Al Layl Perfume', 'Oud Al Layl Perfume'), gift], '')));
    }
  }
});
Deno.test('separately charged concentrated oil is never dropped, even if marked free', () => {
  for (const free of [false, true]) {
    const gift = oil(); gift.line.customer_price = 1500; gift.line.free = free;
    const r = applyPerfumeGiftPolicy([main('Arabiyat Oud Al Layl EDP'), gift], '');
    assertEquals(r.ignored, []); assertEquals(r.rows[1].line.free, false); assert(!ready(r));
  }
});
Deno.test('a known display name does not approve a new or foreign product ID', () => {
  const unknown = main('Opulent Oud', 'Opulent Oud', '11111111-1111-4111-8111-111111111111');
  assert(!ready(applyPerfumeGiftPolicy([unknown, oil('Perfume Oil')], '')));
  const foreign = main('Arabiyat Oud Al Layl EDP'); foreign.match!.client_id = 'other-vendor';
  assert(!ready(applyPerfumeGiftPolicy([foreign, oil()], '')));
});
Deno.test('Aswad, other sizes and unknown extra model words still require review', () => {
  for (const name of ['Arabiyat Oud Al Layl Aswad EDP', 'Arabiyat Oud Al Layl EDP 50ml Perfume For Men and Women',
    'Arabiyat Oud Al Layl EDP Intense']) {
    assert(!ready(applyPerfumeGiftPolicy([main(name), oil()], '')));
  }
  const wrong = main('Arabiyat Oud Al Layl EDP', 'Oud Al Layl Aswad', '5bd093a5-fbf8-4c8c-b6ac-7b5fff32fcb5');
  assert(!ready(applyPerfumeGiftPolicy([wrong, oil()], '')));
});
Deno.test('unknown oil products and sizes cannot become included gifts', () => {
  for (const name of ['Touch Concentrated Perfume Oil 50ml Alcohol Free', 'Other Brand Perfume Oil', 'Concentrated Oil', 'Oil']) {
    assert(!ready(applyPerfumeGiftPolicy([main('Arabiyat Oud Al Layl EDP'), oil(name)], '')));
  }
  assert(!ready(applyPerfumeGiftPolicy([oil()], '')));
});
Deno.test('missing gift quantity remains reviewable for the longer gift name', () => {
  const gift = oil(); gift.line.quantity = null;
  const r = applyPerfumeGiftPolicy([main('Arabiyat Oud Al Layl EDP'), gift], '');
  assert(r.reviewReasons.length > 0); assert(!ready(r)); assertEquals(r.ignored, []);
});
