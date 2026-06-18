// Data layer for the "Available orders" surface (dispatcher + warehouse).
// Reads existing role-gated views — no new RPC, RLS or view needed.
//
// Anchor (status): `available` / `available_evening` means the agent has
// confirmed the customer is reachable and is going to deliver (now or in the
// evening). Either way it's real committed demand — what Mary uses to decide
// stock to give each agent / what total to pull from the warehouse.
import { supabase } from '@/lib/supabase';
import type { StockMatrixRow } from './stock';

export type AvailableOrderRow = {
  delivery_id: string;
  agent_id: string;
  agent_name: string;
  client_id: string;
  client_name: string;
  product_catalog_id: string;
  product_name: string;
  quantity_ordered: number;
  customer_name: string;
  location_name: string | null;
  scheduled_date: string;
};

function todayLagos(): string {
  // Africa/Lagos is +01:00 year-round.
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
}

/** Available orders scheduled for today (Lagos), with assigned agent only.
 *  Reads `available_orders_safe`, a dedicated planning view that bakes the
 *  client / product / agent / location joins server-side and gates visibility
 *  to admin, dispatcher, rep, warehouse, and the assigned agent — so Martha
 *  & Shomolu warehouse see the same numbers Mary the dispatcher does. The
 *  view deliberately omits phone / address / customer_price / payment_method
 *  / agent_payment_snapshot — warehouse doesn't need them to plan stock. */
export async function listAvailableOrders(): Promise<AvailableOrderRow[]> {
  // `available_orders_safe` is a hand-written planning view, not yet in the
  // generated DB types — cast once so the typed select chain still flows.
  const { data, error } = await (
    supabase as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (
            col: string,
            val: string,
          ) => Promise<{ data: unknown; error: { message: string } | null }>;
        };
      };
    }
  )
    .from('available_orders_safe')
    .select('*')
    .eq('scheduled_date', todayLagos());

  if (error) throw error;

  const rows = (
    (data ?? []) as unknown as Array<{
      delivery_id: string | null;
      agent_id: string | null;
      agent_name: string | null;
      client_id: string | null;
      client_name: string | null;
      product_catalog_id: string | null;
      product_name: string | null;
      quantity_ordered: number | null;
      customer_name: string | null;
      location_name: string | null;
      scheduled_date: string | null;
    }>
  )
    .map((row): AvailableOrderRow | null => {
      if (
        !row.delivery_id ||
        !row.agent_id ||
        !row.customer_name ||
        !row.client_id ||
        !row.product_catalog_id ||
        row.quantity_ordered == null ||
        !row.scheduled_date
      ) {
        return null;
      }
      return {
        delivery_id: row.delivery_id,
        agent_id: row.agent_id,
        agent_name: row.agent_name ?? 'Agent',
        client_id: row.client_id,
        client_name: row.client_name ?? 'Client',
        product_catalog_id: row.product_catalog_id,
        product_name: row.product_name ?? 'Product',
        quantity_ordered: row.quantity_ordered,
        customer_name: row.customer_name,
        location_name: row.location_name ?? null,
        scheduled_date: row.scheduled_date,
      };
    })
    .filter((r): r is AvailableOrderRow => r !== null);

  return rows;
}

// --- Aggregators (pure) ------------------------------------------------------

export type AgentProductSummary = {
  product_catalog_id: string;
  product_name: string;
  qty_needed: number;
  deliveries_count: number;
};

export type AgentGroup = {
  agent_id: string;
  agent_name: string;
  total_orders: number;
  total_units: number;
  products: AgentProductSummary[];
};

/** Group available orders by agent. Each agent's products list is sorted by
 *  qty_needed DESC (biggest first). Agents are sorted alphabetically. */
export function groupByAgent(rows: AvailableOrderRow[]): AgentGroup[] {
  // [Feature A] rows are now one-per-line-item (available_orders_safe is
  // itemized), so total_orders counts DISTINCT delivery_id, not row count.
  // total_units / qty_needed sum the per-line quantities (correct for bundles).
  const byAgent = new Map<
    string,
    {
      agent_id: string;
      agent_name: string;
      deliveryIds: Set<string>;
      total_units: number;
      products: Map<string, AgentProductSummary & { _deliveries: Set<string> }>;
    }
  >();

  for (const r of rows) {
    let g = byAgent.get(r.agent_id);
    if (!g) {
      g = {
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        deliveryIds: new Set(),
        total_units: 0,
        products: new Map(),
      };
      byAgent.set(r.agent_id, g);
    }
    g.deliveryIds.add(r.delivery_id);
    g.total_units += r.quantity_ordered;
    let p = g.products.get(r.product_catalog_id);
    if (!p) {
      p = {
        product_catalog_id: r.product_catalog_id,
        product_name: r.product_name,
        qty_needed: 0,
        deliveries_count: 0,
        _deliveries: new Set(),
      };
      g.products.set(r.product_catalog_id, p);
    }
    p.qty_needed += r.quantity_ordered;
    p._deliveries.add(r.delivery_id);
  }

  return Array.from(byAgent.values())
    .map((g) => ({
      agent_id: g.agent_id,
      agent_name: g.agent_name,
      total_orders: g.deliveryIds.size,
      total_units: g.total_units,
      products: Array.from(g.products.values())
        .map(({ _deliveries, ...p }) => ({ ...p, deliveries_count: _deliveries.size }))
        .sort((a, b) => b.qty_needed - a.qty_needed),
    }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}

export type ClientProductTotal = {
  product_catalog_id: string;
  product_name: string;
  qty_needed: number;
  deliveries_count: number;
};

export type ClientAggregate = {
  client_id: string;
  client_name: string;
  total_units: number;
  total_orders: number;
  products: ClientProductTotal[];
};

/** Aggregate per (client, product). Used by the index screen's top
 *  "Total to pull today" roll-up — Mary tells the warehouse exactly how
 *  much of each product to surface, broken down by vendor. Clients sorted
 *  alphabetically; products within a client sorted by qty_needed DESC. */
export function aggregateByClientProduct(rows: AvailableOrderRow[]): ClientAggregate[] {
  // [Feature A] Itemized rows → total_orders counts DISTINCT delivery_id.
  const byClient = new Map<
    string,
    {
      client_id: string;
      client_name: string;
      total_units: number;
      deliveryIds: Set<string>;
      products: Map<string, ClientProductTotal & { _deliveries: Set<string> }>;
    }
  >();

  for (const r of rows) {
    let c = byClient.get(r.client_id);
    if (!c) {
      c = {
        client_id: r.client_id,
        client_name: r.client_name,
        total_units: 0,
        deliveryIds: new Set(),
        products: new Map(),
      };
      byClient.set(r.client_id, c);
    }
    c.total_units += r.quantity_ordered;
    c.deliveryIds.add(r.delivery_id);
    let p = c.products.get(r.product_catalog_id);
    if (!p) {
      p = {
        product_catalog_id: r.product_catalog_id,
        product_name: r.product_name,
        qty_needed: 0,
        deliveries_count: 0,
        _deliveries: new Set(),
      };
      c.products.set(r.product_catalog_id, p);
    }
    p.qty_needed += r.quantity_ordered;
    p._deliveries.add(r.delivery_id);
  }

  return Array.from(byClient.values())
    .map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      total_units: c.total_units,
      total_orders: c.deliveryIds.size,
      products: Array.from(c.products.values())
        .map(({ _deliveries, ...p }) => ({ ...p, deliveries_count: _deliveries.size }))
        .sort((a, b) => b.qty_needed - a.qty_needed),
    }))
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
}

// --- Allocation join ---------------------------------------------------------

export type AllocationAction = 'give' | 'collect' | 'ok';

export type AllocationLine = {
  product_catalog_id: string;
  product_name: string;
  /** Owning vendor. Each product_catalog_id belongs to exactly one client, so a
   *  product "sold by two clients" surfaces as two lines with the same
   *  product_name but different vendors — the warehouse needs this to know whose
   *  stock to transfer from. */
  client_id: string | null;
  client_name: string | null;
  qty_needed: number;
  qty_held: number;
  gap: number; // qty_needed - qty_held; positive = give, negative = collect
  action: AllocationAction;
};

/** For a single agent: produce one row per product that's relevant (has
 *  demand OR holdings). Rows where gap > 0 ⇒ give, < 0 ⇒ collect, 0 ⇒ ok.
 *  Sorted: give first (biggest gap), then collect, then ok. */
export function buildAllocation(
  agentRows: AvailableOrderRow[],
  stockRows: StockMatrixRow[],
  agentId: string,
): AllocationLine[] {
  const needByProduct = new Map<
    string,
    { name: string; qty: number; client_id: string | null; client_name: string | null }
  >();
  for (const r of agentRows) {
    const cur = needByProduct.get(r.product_catalog_id);
    if (cur) {
      cur.qty += r.quantity_ordered;
    } else {
      needByProduct.set(r.product_catalog_id, {
        name: r.product_name,
        qty: r.quantity_ordered,
        client_id: r.client_id,
        client_name: r.client_name,
      });
    }
  }

  const heldByProduct = new Map<
    string,
    { name: string; qty: number; client_id: string | null; client_name: string | null }
  >();
  for (const s of stockRows) {
    if (s.user_id !== agentId) continue;
    heldByProduct.set(s.product_catalog_id, {
      name: s.product_name,
      qty: s.quantity_on_hand,
      client_id: s.client_id || null,
      client_name: s.client_name || null,
    });
  }

  const allProductIds = new Set<string>([...needByProduct.keys(), ...heldByProduct.keys()]);
  const lines: AllocationLine[] = [];
  for (const pid of allProductIds) {
    const need = needByProduct.get(pid);
    const held = heldByProduct.get(pid);
    const qty_needed = need?.qty ?? 0;
    const qty_held = held?.qty ?? 0;
    const gap = qty_needed - qty_held;
    let action: AllocationAction;
    if (gap > 0) action = 'give';
    else if (gap < 0) action = 'collect';
    else action = 'ok';
    lines.push({
      product_catalog_id: pid,
      product_name: need?.name ?? held?.name ?? 'Product',
      // Prefer the demand row's vendor; fall back to the held-stock row for
      // collect-only lines (held but no demand today).
      client_id: need?.client_id ?? held?.client_id ?? null,
      client_name: need?.client_name ?? held?.client_name ?? null,
      qty_needed,
      qty_held,
      gap,
      action,
    });
  }

  return lines.sort((a, b) => {
    // give → collect → ok; within each, biggest |gap| first
    const rank = (l: AllocationLine) => (l.action === 'give' ? 0 : l.action === 'collect' ? 1 : 2);
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return Math.abs(b.gap) - Math.abs(a.gap);
  });
}
