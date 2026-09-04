// Pure restock-signal logic — shared by the warehouse stock list, the holder
// stock detail and the ops dashboards, so every surface derives "is this low?"
// from one definition. Framework-free by design (like lib/stock-signal.ts): no
// React, no service imports, so it is unit-testable under plain node.
//
// The input is structural, letting callers pass the service row type without
// an import cycle.

/** `out`      — nothing on the shelf while the product is still selling.
 *  `critical` — under a day of cover.
 *  `reorder`  — under the replenishment lead time: order now or it runs dry
 *               before the delivery lands.
 *  `ok`       — silent. */
export type RestockTier = 'out' | 'critical' | 'reorder' | 'ok';

/** The subset of a restock row the pure helpers need. */
export type CoverLike = {
  product_catalog_id: string;
  product_name: string;
  client_name: string;
  warehouse_qty: number;
  days_cover: number;
  tier: RestockTier;
};

/** The subset of a stock-matrix row {@link withOutOfStock} reads and writes. */
export type StockRowLike = {
  user_id: string;
  user_email: string;
  user_display_name: string;
  user_role: string;
  product_catalog_id: string;
  product_name: string;
  client_id: string;
  client_name: string;
  quantity_on_hand: number;
  is_active: boolean;
};

/** Days it takes a restock to reach the warehouse. Uzo (2026-09-04): 2-5 days
 *  in practice, plan on 3. This is the whole meaning of the `reorder` tier —
 *  cover shorter than this and the product runs out before more arrives — so
 *  it belongs in one place, named, rather than as a bare 3 in a call site. */
export const DEFAULT_LEAD_DAYS = 3;

/** The rows worth acting on, in the order they should be worked. */
export function needsRestock<T extends CoverLike>(rows: T[]): T[] {
  return rows.filter((r) => r.tier !== 'ok');
}

/** Index the signal by product so a stock list can look up a row's tier while
 *  rendering. The low-stock surfaces are per-product lists already; this is the
 *  only join they need. */
export function coverByProduct(rows: CoverLike[] | null | undefined): Map<string, CoverLike> {
  const m = new Map<string, CoverLike>();
  for (const r of rows ?? []) m.set(r.product_catalog_id, r);
  return m;
}

/** Does this product need ordering? Replaces the flat `isLow(qty) = qty <= 3`
 *  test on the warehouse stock lists. Unknown product (not selling, so not in
 *  the signal) is NOT low — nothing to reorder. */
export function isLowOnCover(row: CoverLike | undefined): boolean {
  return !!row && row.tier !== 'ok';
}

/** Out or gone-today: the rows that can't wait for the next order run. */
export function isUrgentCover(row: CoverLike | undefined): boolean {
  return !!row && (row.tier === 'out' || row.tier === 'critical');
}

/** "0.43 days" means nothing mid-shift; "under a day left" does. */
export function coverLabel(row: CoverLike | undefined): string | null {
  if (!row) return null;
  if (row.warehouse_qty <= 0) return 'Nothing left';
  const d = row.days_cover;
  if (d < 0.75) return 'Under a day left';
  if (d < 1.5) return 'About a day left';
  if (d < 2.5) return 'About 2 days left';
  if (row.tier === 'ok') return `${Math.round(d)} days left`;
  return `About ${Math.round(d)} days left`;
}

/** Re-admit products the warehouse is OUT of.
 *
 *  `current_stock` is `HAVING sum(quantity_delta) <> 0`, so a product sitting
 *  at exactly zero has no row at all and simply is not in any stock list. That
 *  is the single worst blind spot in the old low-stock rule — six products are
 *  out and still selling right now, and none of them appear on the warehouse's
 *  own product list. Folding the restock signal into that list without this
 *  would have quietly reintroduced the bug it exists to fix.
 *
 *  Synthesised rows carry quantity 0 and the holder's identity; only
 *  product/client/quantity are rendered by the stock lists. */
export function withOutOfStock(
  rows: StockRowLike[],
  cover: CoverLike[] | null | undefined,
  holder: { id: string; role: string; displayName?: string; email?: string },
): StockRowLike[] {
  const present = new Set(rows.map((r) => r.product_catalog_id));
  const extra: StockRowLike[] = [];
  for (const c of cover ?? []) {
    if (c.tier !== 'out') continue;
    if (present.has(c.product_catalog_id)) continue;
    extra.push({
      user_id: holder.id,
      user_email: holder.email ?? '',
      user_display_name: holder.displayName ?? '',
      user_role: holder.role,
      product_catalog_id: c.product_catalog_id,
      product_name: c.product_name,
      client_id: '',
      client_name: c.client_name,
      quantity_on_hand: 0,
      is_active: true,
    });
  }
  return extra.length > 0 ? [...rows, ...extra] : rows;
}

/** Headline counts for the dashboard attention rows. `urgent` is the subset
 *  that cannot wait for the next order run. */
export function restockStats(rows: CoverLike[]): {
  total: number;
  urgent: number;
  topName: string | null;
} {
  const acting = needsRestock(rows);
  const urgent = acting.filter((r) => r.tier === 'out' || r.tier === 'critical').length;
  return { total: acting.length, urgent, topName: acting[0]?.product_name ?? null };
}
