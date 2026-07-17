import { rpcUntyped, supabase } from '@/lib/supabase';

/** One product with open (non-terminal) delivery orders today, from the
 *  `stock_coverage_today` RPC (scripts/stock-coverage.sql; Cloud + VPS).
 *  Aggregate-only — no customer data, and deliberately no client/vendor name
 *  (the RPC is callable by agents; vendor names would leak past the
 *  anti-poaching RLS). Ops screens resolve names client-side. */
export type CoverageRow = {
  product_catalog_id: string;
  product_name: string;
  /** Open (non-terminal) delivery orders touching this product today. */
  orders_open: number;
  /** Total quantity those orders need. */
  qty_open: number;
  /** Quantity at `available` / `available_evening` — the customer already said
   *  yes. A confirmation is a soft reservation: on_hand − committed is what's
   *  still safely promisable. */
  qty_committed: number;
  /** Fleet stock: warehouse place + all riders. Can be negative (book errors). */
  on_hand_total: number;
  /** The warehouse PLACE's share of on_hand_total. */
  on_hand_warehouse: number;
  /** The CALLING user's own stock ("my bag"). 0 for non-holders. */
  my_on_hand: number;
};

/** Today's demand-vs-stock coverage, one row per product with open orders.
 *  Callable by every active staff role (agents included — it powers their
 *  "should I call?" badge). ~30-60 tiny rows; cached via useStockCoverage
 *  under the ['stock'] key prefix so stock mutations and status changes
 *  auto-refresh it through the existing invalidateStock() choke point. */
export async function stockCoverageToday(): Promise<CoverageRow[]> {
  const { data, error } = await rpcUntyped<CoverageRow[]>('stock_coverage_today');
  if (error) throw error;
  return data ?? [];
}

/** Vendor names for the ops/warehouse coverage screen, keyed by product id.
 *  Deliberately a separate client-side lookup (LEFT embed on clients, same
 *  pattern as listCurrentStock) instead of a column on the RPC: the RPC is
 *  agent-callable and vendor names must not leak past the anti-poaching RLS.
 *  Agents never mount the coverage screen, so this query never runs for them. */
export async function fetchCoverageClientNames(productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('product_catalog')
    .select('id, clients(name)')
    .in('id', productIds);
  if (error) throw error;
  const m = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as { id: string; clients: { name: string } | null };
    m.set(r.id, r.clients?.name ?? '');
  }
  return m;
}
