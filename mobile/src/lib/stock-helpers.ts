// Stock-related pure helpers shared between the Stock Overview, warehouse
// home, agent My-stock tab, and any future stock surface. Centralising the
// "low" threshold + status predicates here prevents drift — without this,
// any tweak to LOW_STOCK_THRESHOLD has to be made in three places and
// inevitably one gets missed.
import type { StockMatrixRow } from '@/services/stock';

/** Rows at or below this on-hand count render in the "low" amber colour
 *  and are counted on the hero LOW chip. 0 is intentionally NOT low — it
 *  represents "nothing to issue", which is a different problem (no stock
 *  to give) vs. low (some stock, restock soon). Negative is its own bucket. */
export const LOW_STOCK_THRESHOLD = 3;

export function isLow(qty: number): boolean {
  return qty > 0 && qty <= LOW_STOCK_THRESHOLD;
}

export function isNegative(qty: number): boolean {
  return qty < 0;
}

export type HolderStats = {
  totalUnits: number;
  productCount: number;
  lowCount: number;
  negativeCount: number;
  /** Top N "needs attention" items, ordered: negative first (worst gap,
   *  most negative), then low (smallest qty first). Drives the per-card
   *  problem chip strip. Empty when the holder has no issues. */
  topProblems: { product_name: string; product_catalog_id: string; quantity_on_hand: number }[];
};

export function getHolderStats(rows: StockMatrixRow[], holderId: string, topN = 3): HolderStats {
  let totalUnits = 0;
  let lowCount = 0;
  let negativeCount = 0;
  const products = new Set<string>();
  const problems: HolderStats['topProblems'] = [];

  for (const r of rows) {
    if (r.user_id !== holderId) continue;
    totalUnits += r.quantity_on_hand;
    products.add(r.product_catalog_id);
    if (isNegative(r.quantity_on_hand)) {
      negativeCount += 1;
      problems.push({
        product_name: r.product_name,
        product_catalog_id: r.product_catalog_id,
        quantity_on_hand: r.quantity_on_hand,
      });
    } else if (isLow(r.quantity_on_hand)) {
      lowCount += 1;
      problems.push({
        product_name: r.product_name,
        product_catalog_id: r.product_catalog_id,
        quantity_on_hand: r.quantity_on_hand,
      });
    }
  }

  // Sort: most-negative first, then ascending qty (smallest-low first).
  // Pure compare — no mutation outside the local array.
  problems.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand);

  return {
    totalUnits,
    productCount: products.size,
    lowCount,
    negativeCount,
    topProblems: problems.slice(0, topN),
  };
}

/** Aggregate stats across the whole matrix — drives the Stock Overview
 *  hero card. Rows are pre-filtered to non-zero by listCurrentStock so
 *  productCount here = (holder, product) tuples that hold any stock. */
export type OverviewStats = {
  totalUnits: number;
  lowCount: number;
  negativeCount: number;
  /** Number of HOLDERS (not rows) that have at least one low item. */
  lowHolderCount: number;
  /** Number of HOLDERS with at least one negative row. */
  negativeHolderCount: number;
};

export function getOverviewStats(rows: StockMatrixRow[]): OverviewStats {
  let totalUnits = 0;
  let lowCount = 0;
  let negativeCount = 0;
  const lowHolders = new Set<string>();
  const negHolders = new Set<string>();
  for (const r of rows) {
    totalUnits += r.quantity_on_hand;
    if (isNegative(r.quantity_on_hand)) {
      negativeCount += 1;
      negHolders.add(r.user_id);
    } else if (isLow(r.quantity_on_hand)) {
      lowCount += 1;
      lowHolders.add(r.user_id);
    }
  }
  return {
    totalUnits,
    lowCount,
    negativeCount,
    lowHolderCount: lowHolders.size,
    negativeHolderCount: negHolders.size,
  };
}
