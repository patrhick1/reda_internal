// Which figure becomes the order's customer_price — the amount the rider is told
// to collect and the number every reconciliation line is built on.
//
// Three sources can offer one:
//   contractor — the pre-parse carries ONE price field. On a message with a
//                price beside every product it is the FIRST product's amount,
//                not the total (2026-08-11, Gift / Dentora: contractor 32,000,
//                message "Total: N67000"; 12 of 13 wrong totals in 90 days).
//   llm        — our extraction reads the whole message: an explicit Total
//                line (`total_amount`) and a price per line.
//   line sum   — the priced lines added up (free lines never count).
//
// Rule: once the LLM has seen the message and found TWO OR MORE priced lines,
// the contractor's single figure cannot be the total — take the LLM's Total
// line, else the line sum, and only then the contractor. On single-line orders
// the contractor stays authoritative (it has SKU/name context the LLM lacks),
// exactly as before. When the LLM did not run there is nothing to correct with.
//
// Pure and dependency-free so it is testable: see order-total.test.ts.

export type OrderTotalSource = 'contractor' | 'llm_total' | 'line_sum' | 'none';

/** The subset of a line item this decision needs. */
export type PricedLineLike = { customer_price: number | null; free?: boolean };

export type OrderTotalChoice = {
  total: number | null;
  source: OrderTotalSource;
  /** Sum of the priced, non-free lines (0 when none). */
  lineSum: number;
  /** How many non-free lines carried a price > 0. */
  pricedLines: number;
};

export function chooseOrderTotal(args: {
  contractorTotal: number | null;
  /** The LLM's explicit Total line. Ignored when `llmRan` is false. */
  llmTotal: number | null;
  llmRan: boolean;
  lines: PricedLineLike[];
}): OrderTotalChoice {
  const priced = args.lines.filter(
    (l) => !l.free && typeof l.customer_price === 'number' && l.customer_price > 0,
  );
  const lineSum = priced.reduce((s, l) => s + (l.customer_price as number), 0);
  const pricedLines = priced.length;

  const contractor = isAmount(args.contractorTotal) ? args.contractorTotal : null;
  const llm = args.llmRan && isAmount(args.llmTotal) ? args.llmTotal : null;
  const sum = lineSum > 0 ? lineSum : null;

  const pick = (order: Array<[OrderTotalSource, number | null]>): OrderTotalChoice => {
    for (const [source, value] of order) {
      if (value !== null) return { total: value, source, lineSum, pricedLines };
    }
    return { total: null, source: 'none', lineSum, pricedLines };
  };

  if (args.llmRan && pricedLines >= 2) {
    return pick([['llm_total', llm], ['line_sum', sum], ['contractor', contractor]]);
  }
  return pick([['contractor', contractor], ['llm_total', llm], ['line_sum', sum]]);
}

function isAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}
