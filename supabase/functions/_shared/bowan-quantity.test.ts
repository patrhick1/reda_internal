import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { applyBowanQuantities } from './bowan-quantity.ts';
import type { LineItem } from './product-extract.ts';

const item = (
  name = 'Suction Situp Bar',
  quantity = 3,
  price: number | null = 39500,
  free = false,
): LineItem => ({ product_name: name, quantity, customer_price: price, free });
const template = (line: string, closer = 'Closer name: TEST') =>
  `Order number: Bowan-TEST\n${line}\n${closer}`;

Deno.test('Bowan: explicit units override the numeric name prefix, including real multi-unit orders', () => {
  for (const qty of [1, 2, 3]) {
    assertEquals(
      applyBowanQuantities(
        template(`- 3 - SUCTION SITUP-BAR + FREE SKIPPING ROPE x${qty} · NGN39,500`),
        [item()],
      )[0].quantity,
      qty,
    );
  }
});
Deno.test('Bowan: old columns retain their arithmetic guard', () => {
  assertEquals(
    applyBowanQuantities(template('3 - SUCTION SITUP-BAR | 2 | 39,500 | 79,000', 'Closer: TEST'), [
      item(),
    ])[0].quantity,
    2,
  );
  assertEquals(
    applyBowanQuantities(template('3 - SUCTION SITUP-BAR | 2 | 39500 | 39500'), [item()])[0]
      .quantity,
    3,
  );
});
Deno.test('Bowan: quantities belong to products, not extracted array positions', () => {
  const result = applyBowanQuantities(
    template('- 3 - SUCTION SITUP-BAR x1 · NGN39,500\n- Water Filter x2 · NGN12,000'),
    [item('Water Filter', 9, null), item()],
  );
  assertEquals(result.map((x) => x.quantity), [2, 1]);
});
Deno.test('Bowan: free and explicitly zero-price gifts remain unchanged', () => {
  const items = [item(), item('Skipping Rope', 4, 0, true), item('Water Filter', 5, 0)];
  const result = applyBowanQuantities(
    template(
      '- 3 - SUCTION SITUP-BAR + FREE SKIPPING ROPE x1 · NGN39,500\n- Skipping Rope x2 · NGN1,000\n- Water Filter x2 · NGN12,000',
    ),
    items,
  );
  assertEquals(result.map((x) => x.quantity), [1, 4, 5]);
  assertEquals(items[0].quantity, 3, 'input extraction is not mutated');
});
Deno.test('Bowan: missing template markers, invalid quantities and missing prices do not override', () => {
  for (
    const raw of [
      '3 - SUCTION SITUP-BAR x1 · NGN39,500',
      template('3 - SUCTION SITUP-BAR x0 · NGN39,500'),
      template('3 - SUCTION SITUP-BAR x1'),
      template('3 - SUCTION SITUP-BAR x1 · NGN0'),
      template('3 - SUCTION SITUP-BAR x1 · NGN39,500', 'Agent: TEST'),
    ]
  ) {
    assertEquals(applyBowanQuantities(raw, [item()])[0].quantity, 3);
  }
});
Deno.test('Bowan: ambiguous raw lines or competing extracted lines are not guessed', () => {
  assertEquals(
    applyBowanQuantities(
      template('Suction Situp Bar x1 · NGN39,500\nSuction Situp Bar x2 · NGN79,000'),
      [item()],
    )[0].quantity,
    3,
  );
  assertEquals(
    applyBowanQuantities(template('Suction Situp Bar x1 · NGN39,500'), [
      item(),
      item('Situp Bar', 4),
    ]).map((x) => x.quantity),
    [3, 4],
  );
});
