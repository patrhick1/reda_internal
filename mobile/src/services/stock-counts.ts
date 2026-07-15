// Stock counts — a physical-count log for reconciliation. REPORT-ONLY: recording
// a count never changes the stock ledger; it stores what was counted vs what the
// app expected (current_stock) and the variance. Reads go straight to the
// `stock_counts` table (RLS gates ops + warehouse); the write goes through the
// `record_stock_count` RPC (SECURITY DEFINER — computes expected server-side and
// enforces permission). Neither is in database.gen.ts, so handles are cast, as in
// services/available-orders.ts.
import { rpcUntyped, supabase } from '@/lib/supabase';

type PgResult = { data: unknown; error: { message: string } | null };
type PgQuery = {
  eq: (col: string, val: string) => PgQuery;
  order: (col: string, opts: { ascending: boolean }) => PgQuery;
  limit: (n: number) => PgQuery;
} & Promise<PgResult>;
type UntypedFrom = { from: (table: string) => { select: (cols: string) => PgQuery } };

/** One counted product from a count run. */
export type StockCountItem = { productCatalogId: string; countedQty: number };

/** Summary the RPC returns for a count run. */
export type StockCountResult = { recorded: number; matched: number; off: number };

/** A recorded count row (the reference point). `expected_qty` is what the app
 *  said at count time; `variance = counted − expected` (0 = matches). */
export type StockCountRow = {
  id: string;
  batch_id: string;
  holder_id: string;
  product_catalog_id: string;
  expected_qty: number;
  counted_qty: number;
  variance: number;
  counted_by: string | null;
  counted_at: string;
  note: string | null;
};

/** Record a count run for a holder. Report-only: stores counted vs expected +
 *  variance; does NOT change stock. `batchId` (a fresh uuid) makes it idempotent.
 *  Only products the user actually counted should be passed. */
export async function recordStockCount(
  batchId: string,
  holderId: string,
  items: StockCountItem[],
  note?: string | null,
): Promise<StockCountResult> {
  const { data, error } = await rpcUntyped('record_stock_count', {
    p_batch_id: batchId,
    p_holder_id: holderId,
    p_items: items.map((i) => ({
      product_catalog_id: i.productCatalogId,
      counted_qty: i.countedQty,
    })),
    p_note: note ?? null,
  });
  if (error) throw error;
  return (data as StockCountResult | null) ?? { recorded: 0, matched: 0, off: 0 };
}

/** Recent count rows for a holder, newest first — powers the counts history and
 *  the "last count" reference shown on the count screen. */
export async function listCountsForHolder(holderId: string, limit = 50): Promise<StockCountRow[]> {
  const { data, error } = await (supabase as unknown as UntypedFrom)
    .from('stock_counts')
    .select(
      'id, batch_id, holder_id, product_catalog_id, expected_qty, counted_qty, variance, counted_by, counted_at, note',
    )
    .eq('holder_id', holderId)
    .order('counted_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as StockCountRow[];
}
