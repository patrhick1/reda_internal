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
 *  Joins client + product + agent + location names for display. */
export async function listAvailableOrders(): Promise<AvailableOrderRow[]> {
  const { data, error } = await supabase
    .from('deliveries_safe')
    .select(
      `
      id,
      assigned_agent_id,
      customer_name,
      quantity_ordered,
      scheduled_date,
      client_id,
      product_catalog_id,
      client:clients(name),
      product:product_catalog(product_name),
      location:locations(name),
      assigned_agent:users!deliveries_assigned_agent_id_fkey(display_name)
    `,
    )
    .in('current_status', ['available', 'available_evening'])
    .eq('scheduled_date', todayLagos())
    .not('assigned_agent_id', 'is', null);

  if (error) throw error;

  const rows = (data ?? [])
    .map((r): AvailableOrderRow | null => {
      const row = r as unknown as {
        id: string | null;
        assigned_agent_id: string | null;
        customer_name: string | null;
        quantity_ordered: number | null;
        scheduled_date: string | null;
        client_id: string | null;
        product_catalog_id: string | null;
        client: { name: string } | null;
        product: { product_name: string } | null;
        location: { name: string } | null;
        assigned_agent: { display_name: string } | null;
      };
      if (
        !row.id ||
        !row.assigned_agent_id ||
        !row.customer_name ||
        !row.client_id ||
        !row.product_catalog_id ||
        row.quantity_ordered == null ||
        !row.scheduled_date
      ) {
        return null;
      }
      return {
        delivery_id: row.id,
        agent_id: row.assigned_agent_id,
        agent_name: row.assigned_agent?.display_name ?? 'Agent',
        client_id: row.client_id,
        client_name: row.client?.name ?? 'Client',
        product_catalog_id: row.product_catalog_id,
        product_name: row.product?.product_name ?? 'Product',
        quantity_ordered: row.quantity_ordered,
        customer_name: row.customer_name,
        location_name: row.location?.name ?? null,
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
  const byAgent = new Map<
    string,
    {
      agent_id: string;
      agent_name: string;
      total_orders: number;
      total_units: number;
      products: Map<string, AgentProductSummary>;
    }
  >();

  for (const r of rows) {
    let g = byAgent.get(r.agent_id);
    if (!g) {
      g = {
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        total_orders: 0,
        total_units: 0,
        products: new Map(),
      };
      byAgent.set(r.agent_id, g);
    }
    g.total_orders += 1;
    g.total_units += r.quantity_ordered;
    let p = g.products.get(r.product_catalog_id);
    if (!p) {
      p = {
        product_catalog_id: r.product_catalog_id,
        product_name: r.product_name,
        qty_needed: 0,
        deliveries_count: 0,
      };
      g.products.set(r.product_catalog_id, p);
    }
    p.qty_needed += r.quantity_ordered;
    p.deliveries_count += 1;
  }

  return Array.from(byAgent.values())
    .map((g) => ({
      agent_id: g.agent_id,
      agent_name: g.agent_name,
      total_orders: g.total_orders,
      total_units: g.total_units,
      products: Array.from(g.products.values()).sort((a, b) => b.qty_needed - a.qty_needed),
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
  const byClient = new Map<
    string,
    {
      client_id: string;
      client_name: string;
      total_units: number;
      total_orders: number;
      products: Map<string, ClientProductTotal>;
    }
  >();

  for (const r of rows) {
    let c = byClient.get(r.client_id);
    if (!c) {
      c = {
        client_id: r.client_id,
        client_name: r.client_name,
        total_units: 0,
        total_orders: 0,
        products: new Map(),
      };
      byClient.set(r.client_id, c);
    }
    c.total_units += r.quantity_ordered;
    c.total_orders += 1;
    let p = c.products.get(r.product_catalog_id);
    if (!p) {
      p = {
        product_catalog_id: r.product_catalog_id,
        product_name: r.product_name,
        qty_needed: 0,
        deliveries_count: 0,
      };
      c.products.set(r.product_catalog_id, p);
    }
    p.qty_needed += r.quantity_ordered;
    p.deliveries_count += 1;
  }

  return Array.from(byClient.values())
    .map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      total_units: c.total_units,
      total_orders: c.total_orders,
      products: Array.from(c.products.values()).sort((a, b) => b.qty_needed - a.qty_needed),
    }))
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
}

// --- Allocation join ---------------------------------------------------------

export type AllocationAction = 'give' | 'collect' | 'ok';

export type AllocationLine = {
  product_catalog_id: string;
  product_name: string;
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
  const needByProduct = new Map<string, { name: string; qty: number }>();
  for (const r of agentRows) {
    const cur = needByProduct.get(r.product_catalog_id);
    if (cur) {
      cur.qty += r.quantity_ordered;
    } else {
      needByProduct.set(r.product_catalog_id, {
        name: r.product_name,
        qty: r.quantity_ordered,
      });
    }
  }

  const heldByProduct = new Map<string, { name: string; qty: number }>();
  for (const s of stockRows) {
    if (s.user_id !== agentId) continue;
    heldByProduct.set(s.product_catalog_id, {
      name: s.product_name,
      qty: s.quantity_on_hand,
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
