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

/** Call an RPC that isn't in the generated DB types. `list_stock_movements`
 *  and `list_movement_actors` are hand-written SQL functions, so the typed
 *  `supabase.rpc` chain rejects their names — cast through this one helper
 *  instead of repeating the assertion at each call site. */
function rpcUntyped(fn: string, args: Record<string, unknown>) {
  return (
    supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc(fn, args);
}

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
  | 'delivered'
  // [Phase 2] the +qty release written when a delivered order is reverted.
  | 'delivery_returned';

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

/** Server-side filters. Both are pushed into the RPC (not applied client-side)
 *  because the list is infinite-history + keyset-paginated — a client filter
 *  would only narrow already-loaded pages and silently miss older matches.
 *    actorId — only this performer's movements (the staff/actor filter)
 *    kinds   — only these event kinds (e.g. ['transfer'] or the adjustments
 *              group ['correction','loss','theft','damaged','found']) */
export type MovementFilters = {
  actorId?: string | null;
  kinds?: MovementEventKind[] | null;
  /** Only movements whose paired recipient is this holder — i.e. stock
   *  issued/transferred/returned TO this agent ("To agent" filter). */
  counterpartyId?: string | null;
};

/** Fetch one page of movement events for a holder. Pass `cursor = null` for
 *  the newest page; for the next page, pass the last row of the previous
 *  page (use {@link nextCursor}). Returns up to `limit` rows; if the result
 *  length is < limit, the caller has reached end-of-history. */
export async function listStockMovements(
  holderId: string,
  cursor: MovementCursor,
  limit = 50,
  filters?: MovementFilters,
): Promise<StockMovement[]> {
  const { data, error } = await rpcUntyped('list_stock_movements', {
    p_holder_id: holderId,
    p_before_at: cursor?.event_at ?? null,
    p_before_event_id: cursor?.event_id ?? null,
    p_limit: limit,
    p_actor_id: filters?.actorId ?? null,
    p_kinds: filters?.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    p_counterparty_id: filters?.counterpartyId ?? null,
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

// ---------------------------------------------------------------------------
// Cross-holder feed (Phase 1). Powers TWO oversight views off ONE RPC
// (`list_stock_movements_global`): a per-client view (clientId set) and a
// company-wide view (any subset of filters). Unlike the per-holder feed it is
// NOT scoped to a single holder, so every row carries its holder + vendor, and
// paired transfer legs are collapsed server-side to the source (negative) leg.
// Ops-only on the server (admin/dispatcher/rep); agents/warehouse get 42501.
// ---------------------------------------------------------------------------

/** A movement row from the cross-holder feed: the per-holder shape plus the
 *  holder and vendor each row belongs to (there is no single "viewer" holder). */
export type GlobalMovement = StockMovement & {
  holder_id: string;
  holder_name: string | null;
  client_id: string | null;
  client_name: string | null;
};

/** Server-side filters for the cross-holder feed. All optional → company-wide
 *  with no filter. `clientId` fixed (and the client filter hidden) in the
 *  per-client view. */
export type GlobalMovementFilters = {
  clientId?: string | null;
  productCatalogId?: string | null;
  holderId?: string | null;
  kinds?: MovementEventKind[] | null;
};

/** Fetch one page of the cross-holder movement feed. Same keyset contract as
 *  {@link listStockMovements} — pass `cursor = null` for the newest page, then
 *  {@link nextCursor} of the previous page for older ones. */
export async function listGlobalStockMovements(
  cursor: MovementCursor,
  limit = 50,
  filters?: GlobalMovementFilters,
): Promise<GlobalMovement[]> {
  const { data, error } = await rpcUntyped('list_stock_movements_global', {
    p_client_id: filters?.clientId ?? null,
    p_product_catalog_id: filters?.productCatalogId ?? null,
    p_holder_id: filters?.holderId ?? null,
    p_kinds: filters?.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    p_before_at: cursor?.event_at ?? null,
    p_before_event_id: cursor?.event_id ?? null,
    p_limit: limit,
  });

  if (error) throw error;

  // Explicit raw-row shape (matches listStockMovements' style) so the null-guard
  // below narrows each required field and the mapper needs no per-field casts.
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
    holder_id: string | null;
    holder_name: string | null;
    client_id: string | null;
    client_name: string | null;
  }>;

  return rows
    .map((row): GlobalMovement | null => {
      if (
        !row.source ||
        !row.event_id ||
        !row.event_at ||
        !row.event_kind ||
        !row.product_catalog_id ||
        !row.product_name ||
        row.quantity_delta == null ||
        !row.holder_id
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
        holder_id: row.holder_id,
        holder_name: row.holder_name,
        client_id: row.client_id,
        client_name: row.client_name,
      };
    })
    .filter((m): m is GlobalMovement => m !== null);
}

export type MovementActor = { actor_id: string; actor_name: string };

/** The distinct set of performers (actors) who appear in a holder's history —
 *  the COMPLETE set across all of history, not just the loaded page, so the
 *  staff-filter chips are exhaustive. Backed by the `list_movement_actors`
 *  RPC, which shares list_stock_movements' auth gate. */
export async function listMovementActors(holderId: string): Promise<MovementActor[]> {
  const { data, error } = await rpcUntyped('list_movement_actors', { p_holder_id: holderId });

  if (error) throw error;

  const rows = (data ?? []) as Array<{ actor_id: string | null; actor_name: string | null }>;
  return rows
    .filter((r): r is MovementActor => r.actor_id != null && r.actor_name != null)
    .map((r) => ({ actor_id: r.actor_id, actor_name: r.actor_name }));
}

export type MovementCounterparty = { counterparty_id: string; counterparty_name: string };

/** The distinct recipient agents in a holder's history — who stock was
 *  issued/transferred/returned TO. Feeds the "To agent" dropdown. Complete set
 *  across all history (not just the loaded page); shares the auth gate. */
export async function listMovementCounterparties(
  holderId: string,
): Promise<MovementCounterparty[]> {
  const { data, error } = await rpcUntyped('list_movement_counterparties', {
    p_holder_id: holderId,
  });

  if (error) throw error;

  const rows = (data ?? []) as Array<{
    counterparty_id: string | null;
    counterparty_name: string | null;
  }>;
  return rows
    .filter(
      (r): r is MovementCounterparty => r.counterparty_id != null && r.counterparty_name != null,
    )
    .map((r) => ({ counterparty_id: r.counterparty_id, counterparty_name: r.counterparty_name }));
}
