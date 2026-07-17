// Pure "should I call?" signal logic — shared by the agent Today list, both
// delivery detail screens, and the ops coverage surfaces, so every screen
// derives the same verdict from the same coverage row. Framework-free (like
// lib/rate-trend.ts): no React, no service imports; the input is structural.
//
// Philosophy (settled with Uzo, 2026-07-17): the signal is INFORMATIONAL and
// never blocks anything. Silence is the default good state — a badge only
// appears when calling the customer is likely to over-promise. The metric is
// self-regulating: each confirmation (status -> available) raises `committed`,
// tightening everyone else's badges automatically; first-come-first-served
// resolves limited stock through the statuses we already have (no reservation
// system by design).

/** The subset of a CoverageRow the signal needs (structural, so callers can
 *  pass the service type without an import cycle). */
export type CoverageLike = {
  qty_committed: number;
  on_hand_total: number;
  my_on_hand: number;
};

export type StockSignal = 'out' | 'committed';

/** Statuses that count as "the customer already said yes" — must mirror the
 *  committed set in scripts/stock-coverage.sql (and available_orders_safe). */
export const COMMITTED_STATUSES = new Set<string>(['available', 'available_evening']);

/** Decide the signal for ONE order line.
 *
 *  @param c             Coverage row for the product (undefined = product has
 *                       no open orders today per the RPC, or unknown pid —
 *                       stay silent rather than guess).
 *  @param qty           This order's quantity (fall back to 1 upstream).
 *  @param selfCommitted True when THIS order is already at available/
 *                       available_evening — its own commitment is added back
 *                       so a confirmed order never flags itself as blocked by
 *                       its own reservation.
 *  @returns 'out'       zero (or negative) stock anywhere — calling will
 *                       over-promise;
 *           'committed' stock exists but is already spoken for (or is less
 *                       than this order needs);
 *           null        silent: agent's own bag covers it, or fleet
 *                       uncommitted stock covers it.
 */
export function stockSignal(
  c: CoverageLike | undefined,
  qty: number,
  selfCommitted: boolean,
): StockSignal | null {
  if (!c) return null;
  const q = qty > 0 ? qty : 1;
  // My bag covers it — I can deliver regardless of the fleet picture.
  if (c.my_on_hand >= q) return null;
  // Fleet uncommitted stock covers it. Negative on-hand participates raw —
  // a negative book naturally lands in 'out' below.
  const uncommitted = c.on_hand_total - c.qty_committed + (selfCommitted ? q : 0);
  if (uncommitted >= q) return null;
  if (c.on_hand_total <= 0) return 'out';
  return 'committed';
}

/** Worst-of reducer for multi-item orders: out > committed > null. */
export function worstSignal(signals: (StockSignal | null)[]): StockSignal | null {
  let worst: StockSignal | null = null;
  for (const s of signals) {
    if (s === 'out') return 'out';
    if (s === 'committed') worst = 'committed';
  }
  return worst;
}

/** Display copy + tone per signal. `tone` maps onto the Banner tones. */
export const SIGNAL_META: Record<StockSignal, { label: string; tone: 'error' | 'warn' }> = {
  out: { label: 'Out of stock — hold off calling', tone: 'error' },
  committed: { label: 'Fully committed — check before promising', tone: 'warn' },
};
