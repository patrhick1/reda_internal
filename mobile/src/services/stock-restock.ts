import { rpcUntyped } from '@/lib/supabase';

/** How many days of stock a product has left, from the `stock_restock_signal`
 *  RPC (supabase/migrations/20260904090000_stock_restock_signal.sql).
 *
 *  This is the RESTOCK question — "what do we need to order?" — and it is
 *  deliberately distinct from `stock_coverage_today`, which answers "can we
 *  serve the orders already booked for today?". A product can be comfortably
 *  covered for today and still need ordering, which is exactly the case that
 *  went unreported (Water Filter, 2026-09-01: 5 units against 5 units of
 *  orders, silent, and it was selling ~12 a day).
 *
 *  Unlike the coverage RPC this one is NOT agent-callable — it carries vendor
 *  names, and agents don't restock. */
export type RestockRow = {
  product_catalog_id: string;
  product_name: string;
  /** Vendor. Safe to include: the RPC is gated to ops + warehouse, both of
   *  which already read `clients` under the existing policy. */
  client_name: string;
  /** The warehouse PLACE's stock. Riders' bags are excluded on purpose — a
   *  rider holding 1-3 units is a normal day's round, not a shortage. */
  warehouse_qty: number;
  /** Units shipped in the window (reason='delivered'). */
  units_out: number;
  /** Selling days the rate is averaged over — Sundays excluded (they have
   *  never traded), and capped to the product's own age if it is newer than
   *  the window. */
  selling_days: number;
  /** units_out / selling_days. */
  rate_per_day: number;
  /** warehouse_qty / rate_per_day. 0 when the shelf is empty. */
  days_cover: number;
  tier: RestockTier;
};

/** `out`      — nothing on the shelf while the product is still selling.
 *  `critical` — under a day of cover.
 *  `reorder`  — under the replenishment lead time: order now or it runs dry
 *               before the delivery lands.
 *  `ok`       — silent. */
export type RestockTier = 'out' | 'critical' | 'reorder' | 'ok';

/** Products needing action, worst first. `ok` rows are returned too so the
 *  screen can offer an "All" view without a second call; every caller that
 *  only wants the alert list should use {@link needsRestock}. */
export async function stockRestockSignal(opts: { leadDays?: number } = {}): Promise<RestockRow[]> {
  const { data, error } = await rpcUntyped<RestockRow[]>('stock_restock_signal', {
    p_window_days: 28,
    p_lead_days: opts.leadDays ?? DEFAULT_LEAD_DAYS,
  });
  if (error) throw error;
  return data ?? [];
}

/** Days it takes a restock to reach the warehouse. Uzo (2026-09-04): 2-5 days
 *  in practice, plan on 3. This is the whole meaning of the `reorder` tier —
 *  cover shorter than this and the product runs out before more arrives — so
 *  it belongs in one place, named, rather than as a bare 3 in a call site. */
export const DEFAULT_LEAD_DAYS = 3;

/** The rows worth acting on, in the order they should be worked. */
export function needsRestock(rows: RestockRow[]): RestockRow[] {
  return rows.filter((r) => r.tier !== 'ok');
}

/** Headline counts for the dashboard attention rows. `urgent` is the subset
 *  that cannot wait for the next order run. */
export function restockStats(rows: RestockRow[]): {
  total: number;
  urgent: number;
  topName: string | null;
} {
  const acting = needsRestock(rows);
  const urgent = acting.filter((r) => r.tier === 'out' || r.tier === 'critical').length;
  return { total: acting.length, urgent, topName: acting[0]?.product_name ?? null };
}
