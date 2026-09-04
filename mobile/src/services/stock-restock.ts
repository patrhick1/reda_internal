import { rpcUntyped } from '@/lib/supabase';
import { DEFAULT_LEAD_DAYS, type RestockTier } from '@/lib/restock-signal';

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
  /** Quantity on today's open (non-terminal) orders. Used as a FLOOR under the
   *  rate when the shelf is empty or nothing shipped all window — being out of
   *  stock stops sales, so shipments alone would let the product go quiet
   *  exactly when it has been unavailable longest. */
  qty_open: number;
  /** Selling days the rate is averaged over — Sundays excluded (they have
   *  never traded), and capped to the product's own age if it is newer than
   *  the window. */
  selling_days: number;
  /** Effective selling speed: units_out / selling_days, floored by qty_open in
   *  the out-of-stock case above. */
  rate_per_day: number;
  /** warehouse_qty / rate_per_day. 0 when the shelf is empty. */
  days_cover: number;
  tier: RestockTier;
};

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

/** Re-exported so a caller that only needs the row type imports one module.
 *  All pure logic lives in lib/restock-signal.ts (framework-free, unit-tested). */
export { DEFAULT_LEAD_DAYS } from '@/lib/restock-signal';
