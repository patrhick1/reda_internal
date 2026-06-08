// Data layer for the per-holder stock movement history surface (warehouse,
// admin, and agent). Reads `public.list_stock_movements` — a SECURITY DEFINER
// RPC that UNIONs the stock_adjustments ledger with delivered deliveries for
// a single holder, sorted newest-first, paginated by keyset cursor on
// (event_at, event_id). Server-side auth gate mirrors the existing
// stock_adj_select_admin_dispatcher RLS:
//   admin/dispatcher/rep -> any holder
//   warehouse staff      -> their own warehouse place + themselves
//   agent                -> themselves only
// The mobile side never grants more visibility than the RPC.
import { supabase } from '@/lib/supabase';

export type MovementSource = 'adjustment' | 'delivery';

/** All kinds the RPC can emit. Schema-bound: `stock_adjustments.reason` is
 *  CHECK-constrained to these adjustment values; `delivered` is the synthetic
 *  kind for delivered-deliveries rows. */
export type MovementEventKind =
  | 'bulk_intake'
  | 'warehouse_issue'
  | 'warehouse_return'
  | 'transfer'
  | 'correction'
  | 'loss'
  | 'theft'
  | 'damaged'
  | 'found'
  | 'delivered';

export type StockMovement = {
  source: MovementSource;
  event_id: string;
  event_at: string;
  event_kind: MovementEventKind;
  product_catalog_id: string;
  product_name: string;
  quantity_delta: number;
  /** Only populated for `delivery` rows; lets the UI render
   *  "−3 (3 of 5 ordered)" on partial deliveries. */
  quantity_ordered: number | null;
  notes: string | null;
  actor_id: string | null;
  actor_name: string | null;
  /** Populated only for paired adjustments (transfer / warehouse_issue /
   *  warehouse_return). NULL counterparty_holder_name with non-null
   *  counterparty_holder_id means the paired row was deleted — the UI
   *  should render "Unknown party". */
  counterparty_holder_id: string | null;
  counterparty_holder_name: string | null;
  related_adjustment_id: string | null;
  /** Populated only for `delivery` rows. Lets the UI link straight to the
   *  delivery detail screen. */
  delivery_id: string | null;
  customer_name: string | null;
};

export type MovementCursor = { event_at: string; event_id: string } | null;

/** Fetch one page of movement events for a holder. Pass `cursor = null` for
 *  the newest page; for the next page, pass the last row of the previous
 *  page (use {@link nextCursor}). Returns up to `limit` rows; if the result
 *  length is < limit, the caller has reached end-of-history. */
export async function listStockMovements(
  holderId: string,
  cursor: MovementCursor,
  limit = 50,
): Promise<StockMovement[]> {
  // The RPC is hand-written and not in the generated DB types — cast once
  // so the typed rpc chain still flows. Mirrors the available-orders
  // ungenerated-view pattern.
  const { data, error } = await (
    supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc('list_stock_movements', {
    p_holder_id: holderId,
    p_before_at: cursor?.event_at ?? null,
    p_before_event_id: cursor?.event_id ?? null,
    p_limit: limit,
  });

  if (error) throw error;

  const rows = (data ?? []) as unknown as Array<{
    source: MovementSource | null;
    event_id: string | null;
    event_at: string | null;
    event_kind: MovementEventKind | null;
    product_catalog_id: string | null;
    product_name: string | null;
    quantity_delta: number | null;
    quantity_ordered: number | null;
    notes: string | null;
    actor_id: string | null;
    actor_name: string | null;
    counterparty_holder_id: string | null;
    counterparty_holder_name: string | null;
    related_adjustment_id: string | null;
    delivery_id: string | null;
    customer_name: string | null;
  }>;

  return rows
    .map((row): StockMovement | null => {
      if (
        !row.source ||
        !row.event_id ||
        !row.event_at ||
        !row.event_kind ||
        !row.product_catalog_id ||
        !row.product_name ||
        row.quantity_delta == null
      ) {
        return null;
      }
      return {
        source: row.source,
        event_id: row.event_id,
        event_at: row.event_at,
        event_kind: row.event_kind,
        product_catalog_id: row.product_catalog_id,
        product_name: row.product_name,
        quantity_delta: row.quantity_delta,
        quantity_ordered: row.quantity_ordered,
        notes: row.notes,
        actor_id: row.actor_id,
        actor_name: row.actor_name,
        counterparty_holder_id: row.counterparty_holder_id,
        counterparty_holder_name: row.counterparty_holder_name,
        related_adjustment_id: row.related_adjustment_id,
        delivery_id: row.delivery_id,
        customer_name: row.customer_name,
      };
    })
    .filter((m): m is StockMovement => m !== null);
}

/** Build the cursor for the next page from the last row of the current page.
 *  Pass back into {@link listStockMovements} to fetch older events. */
export function nextCursor(rows: StockMovement[]): MovementCursor {
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { event_at: last.event_at, event_id: last.event_id };
}
