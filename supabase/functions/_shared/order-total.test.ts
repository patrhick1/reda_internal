// Order-total precedence regression tests.
// Run: deno test supabase/functions/_shared/order-total.test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { chooseOrderTotal } from './order-total.ts';

const line = (customer_price: number | null, free = false) => ({ customer_price, free });

Deno.test('Gift / Dentora 2026-08-11: contractor took the first Amount, the Total line wins', () => {
  // Message: "Niacinamide toothpaste 2 units Amount: ₦32,000 2 whitening
  // strips N35000 Total:N67000". Contractor parsed customer_price 32000.
  const c = chooseOrderTotal({
    contractorTotal: 32000,
    llmTotal: 67000,
    llmRan: true,
    lines: [line(32000), line(35000)],
  });
  assertEquals(c.total, 67000);
  assertEquals(c.source, 'llm_total');
  assertEquals(c.lineSum, 67000);
  assertEquals(c.pricedLines, 2);
});

Deno.test('two priced lines and no Total line: the line sum, not the contractor figure', () => {
  const c = chooseOrderTotal({
    contractorTotal: 30000,
    llmTotal: null,
    llmRan: true,
    lines: [line(30000), line(40000)],
  });
  assertEquals(c.total, 70000);
  assertEquals(c.source, 'line_sum');
});

Deno.test('an explicit Total line beats the line sum on a multi-line order', () => {
  // e.g. a Total that includes something the lines do not itemise.
  const c = chooseOrderTotal({
    contractorTotal: 18000,
    llmTotal: 50000,
    llmRan: true,
    lines: [line(18000), line(30000)],
  });
  assertEquals(c.total, 50000);
  assertEquals(c.source, 'llm_total');
});

Deno.test('single priced line: the contractor figure stays authoritative', () => {
  const c = chooseOrderTotal({
    contractorTotal: 18500,
    llmTotal: 18500,
    llmRan: true,
    lines: [line(18500)],
  });
  assertEquals(c.total, 18500);
  assertEquals(c.source, 'contractor');
  assertEquals(c.pricedLines, 1);
});

Deno.test('single line without a contractor figure: LLM Total, then the line price', () => {
  const a = chooseOrderTotal({ contractorTotal: null, llmTotal: 20000, llmRan: true, lines: [line(20000)] });
  assertEquals(a.total, 20000);
  assertEquals(a.source, 'llm_total');
  const b = chooseOrderTotal({ contractorTotal: null, llmTotal: null, llmRan: true, lines: [line(20000)] });
  assertEquals(b.total, 20000);
  assertEquals(b.source, 'line_sum');
});

Deno.test('free lines never count toward the sum or the priced-line count', () => {
  const c = chooseOrderTotal({
    contractorTotal: 20000,
    llmTotal: 20000,
    llmRan: true,
    lines: [line(20000), line(0, true)],
  });
  assertEquals(c.pricedLines, 1);
  assertEquals(c.lineSum, 20000);
  assertEquals(c.total, 20000);
  assertEquals(c.source, 'contractor');
});

Deno.test('LLM did not run: contractor figure, else its own lines, else nothing', () => {
  const a = chooseOrderTotal({ contractorTotal: 15000, llmTotal: 99999, llmRan: false, lines: [] });
  assertEquals(a.total, 15000);
  assertEquals(a.source, 'contractor');
  const b = chooseOrderTotal({ contractorTotal: null, llmTotal: null, llmRan: false, lines: [line(12000)] });
  assertEquals(b.total, 12000);
  assertEquals(b.source, 'line_sum');
  const c = chooseOrderTotal({ contractorTotal: null, llmTotal: null, llmRan: false, lines: [] });
  assertEquals(c.total, null);
  assertEquals(c.source, 'none');
});

Deno.test('a negative or non-finite figure is treated as absent', () => {
  const c = chooseOrderTotal({
    contractorTotal: -1,
    llmTotal: Number.NaN,
    llmRan: true,
    lines: [line(5000), line(7000)],
  });
  assertEquals(c.total, 12000);
  assertEquals(c.source, 'line_sum');
});
