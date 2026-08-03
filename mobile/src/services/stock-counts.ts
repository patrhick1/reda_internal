// Stock counts — a physical-count log for reconciliation. REPORT-ONLY: recording
// a count never changes the stock ledger; it stores what was counted vs what the
// app expected (current_stock) and the variance. Reads go straight to the
// `stock_counts` table (RLS gates ops + warehouse); the write goes through the
// `record_stock_count` RPC (SECURITY DEFINER — computes expected server-side and
// enforces permission). Neither is in database.gen.ts, so handles are cast, as in
// services/available-orders.ts.
import { rpcUntyped, supabase } from '@/lib/supabase';
import { queryClient } from '@/lib/query';

/** Refresh the count-history caches after a count is recorded.
 *
 *  Counts don't move stock, so `recordStockCount` is a direct RPC and never
 *  passes through the offline queue's drain loop — which is where
 *  `invalidateStock()` is called from, and the only place it is called from.
 *  Without this, a count you just recorded wouldn't show up in the history
 *  until the cache went stale on its own.
 *
 *  Narrowed with a predicate rather than invalidating the whole `['stock']`
 *  prefix: the keys are `['stock', uid, 'counts', …]`, and refetching the stock
 *  matrix and coverage would be pure waste since nothing in the ledger moved. */
function invalidateStockCounts(): void {
  void queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'stock' && q.queryKey[2] === 'counts',
  });
}

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
  invalidateStockCounts();
  return (data as StockCountResult | null) ?? { recorded: 0, matched: 0, off: 0 };
}

/** One count RUN — the shape the history feed lists. `items_count` is how many
 *  products were counted; `off_count` how many of those had a non-zero variance.
 *  Ids are resolved to names client-side against the cached users/products
 *  queries rather than joined server-side, which keeps the feed small. */
export type StockCountBatch = {
  batch_id: string;
  holder_id: string;
  counted_at: string;
  counted_by: string | null;
  note: string | null;
  items_count: number;
  off_count: number;
};

/** Keyset cursor for {@link listStockCountBatches} — the last row of the page
 *  you already have. Mirrors MovementCursor in services/stock-movements.ts. */
export type StockCountCursor = { counted_at: string; batch_id: string } | null;

/** Cursor for the page after `page`, or null when the page was short (= end of
 *  history, no further request needed). */
export function nextBatchCursor(page: StockCountBatch[], pageSize: number): StockCountCursor {
  if (page.length < pageSize) return null;
  const last = page[page.length - 1];
  return last ? { counted_at: last.counted_at, batch_id: last.batch_id } : null;
}

/** [Egress] One page of count runs, newest first — one row per RUN, not per
 *  product. Grouping client-side instead would mean shipping every counted row
 *  ever recorded (a warehouse count is ~150 rows) just to render a summary
 *  line, so the grouping happens in `list_stock_count_batches`. The per-product
 *  rows are fetched only for the one run a user expands, via
 *  {@link listCountsForBatch}.
 *
 *  Pass `cursor = null` for the newest page. A result shorter than `limit`
 *  means end-of-history. */
export async function listStockCountBatches(
  cursor: StockCountCursor,
  limit = 30,
  opts: { holderId?: string | null } = {},
): Promise<StockCountBatch[]> {
  const { data, error } = await rpcUntyped<StockCountBatch[]>('list_stock_count_batches', {
    p_limit: limit,
    p_cursor_at: cursor?.counted_at ?? null,
    p_cursor_batch: cursor?.batch_id ?? null,
    p_holder_id: opts.holderId ?? null,
  });
  if (error) throw error;
  return data ?? [];
}

/** The per-product rows of ONE count run, for the expanded card. Scoped on
 *  batch_id so opening a run never pulls anyone else's. */
export async function listCountsForBatch(batchId: string): Promise<StockCountRow[]> {
  const { data, error } = await (supabase as unknown as UntypedFrom)
    .from('stock_counts')
    .select(
      'id, batch_id, holder_id, product_catalog_id, expected_qty, counted_qty, variance, counted_by, counted_at, note',
    )
    .eq('batch_id', batchId)
    .order('counted_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as StockCountRow[];
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
