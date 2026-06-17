import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';

export type CurrentStockRow = Database['public']['Views']['current_stock']['Row'];

export type SingleReason = 'loss' | 'theft' | 'damaged' | 'found' | 'correction' | 'bulk_intake';
export type PairedReason = 'transfer' | 'warehouse_return' | 'warehouse_issue';

export const SINGLE_REASONS: {
  value: SingleReason;
  label: string;
  sign: 'negative' | 'positive' | 'either';
}[] = [
  { value: 'loss', label: 'Loss', sign: 'negative' },
  { value: 'theft', label: 'Theft', sign: 'negative' },
  { value: 'damaged', label: 'Damaged', sign: 'negative' },
  { value: 'found', label: 'Found', sign: 'positive' },
  { value: 'bulk_intake', label: 'Bulk intake', sign: 'positive' },
  { value: 'correction', label: 'Correction', sign: 'either' },
];

/** Reasons admissible from the generic "Adjustment" screen — every single
 *  reason except `bulk_intake`, which has its own dedicated Receive screen. */
export const ADJUSTMENT_REASONS = SINGLE_REASONS.filter((r) => r.value !== 'bulk_intake');

export const PAIRED_REASONS: { value: PairedReason; label: string; sub: string }[] = [
  { value: 'transfer', label: 'Transfer (agent → agent)', sub: 'Move stock between two agents' },
  { value: 'warehouse_issue', label: 'Warehouse issue', sub: 'Warehouse → agent' },
  { value: 'warehouse_return', label: 'Warehouse return', sub: 'Agent → warehouse' },
];

/** A flat list of (user, product, qty) — non-zero only. */
export type StockMatrixRow = {
  user_id: string;
  user_email: string;
  user_display_name: string;
  user_role: string;
  product_catalog_id: string;
  product_name: string;
  client_id: string;
  client_name: string;
  quantity_on_hand: number;
};

export async function listCurrentStock(): Promise<StockMatrixRow[]> {
  const stockRes = await supabase.from('current_stock').select('*');
  if (stockRes.error) throw stockRes.error;
  const rows = (stockRes.data ?? []).filter(
    (r): r is { agent_id: string; product_catalog_id: string; quantity_on_hand: number } =>
      r.agent_id !== null && r.product_catalog_id !== null && r.quantity_on_hand !== null,
  );
  if (rows.length === 0) return [];

  const userIds = Array.from(new Set(rows.map((r) => r.agent_id)));
  const prodIds = Array.from(new Set(rows.map((r) => r.product_catalog_id)));

  const [usersRes, prodsRes] = await Promise.all([
    supabase.from('users').select('id, email, display_name, role').in('id', userIds),
    supabase
      // LEFT embed on clients (NOT clients!inner): agents can't read the
      // clients table (anti-poaching RLS), and an inner join would drop every
      // product row for them — silently emptying their My Stock. With a left
      // embed the product rows survive; `clients` just comes back null for
      // agents (ops/warehouse still get the name). Agent My Stock doesn't
      // render the vendor name anyway, so nothing leaks.
      .from('product_catalog')
      .select('id, product_name, client_id, clients(name)')
      .in('id', prodIds),
  ]);
  if (usersRes.error) throw usersRes.error;
  if (prodsRes.error) throw prodsRes.error;

  const userById = new Map((usersRes.data ?? []).map((u) => [u.id, u]));
  const prodById = new Map(
    (prodsRes.data ?? []).map((p) => {
      const row = p as {
        id: string;
        product_name: string;
        client_id: string;
        clients: { name: string } | null;
      };
      return [
        row.id,
        {
          product_name: row.product_name,
          client_id: row.client_id,
          // null when the caller can't read clients (agents) — see the LEFT
          // embed note above. Empty string keeps StockMatrixRow.client_name a
          // plain string for the ops/warehouse screens that do show it.
          client_name: row.clients?.name ?? '',
        },
      ];
    }),
  );

  return rows
    .map((r) => {
      const u = userById.get(r.agent_id);
      const p = prodById.get(r.product_catalog_id);
      if (!u || !p) return null;
      return {
        user_id: r.agent_id,
        user_email: u.email,
        user_display_name: u.display_name,
        user_role: u.role,
        product_catalog_id: r.product_catalog_id,
        product_name: p.product_name,
        client_id: p.client_id,
        client_name: p.client_name,
        quantity_on_hand: r.quantity_on_hand,
      };
    })
    .filter((r): r is StockMatrixRow => r !== null)
    .sort((a, b) => {
      const k1 = a.user_display_name.localeCompare(b.user_display_name);
      return k1 !== 0 ? k1 : a.product_name.localeCompare(b.product_name);
    });
}

/** Stock visible to a specific user (their own only). Used by Agent My Stock view. */
export async function listMyStock(userId: string): Promise<StockMatrixRow[]> {
  const all = await listCurrentStock();
  return all.filter((r) => r.user_id === userId);
}

/** Stock held by ONE holder (agent or warehouse place), non-zero only. Unlike
 *  listMyStock this filters on the server (`agent_id = holderId`) and only
 *  resolves the names for that holder's products — so it doesn't pull the whole
 *  stock matrix. Used by the transfer product picker, which only needs the
 *  source's on-hand. Same shape + sort (by product name) as listCurrentStock. */
export async function listHolderStock(holderId: string): Promise<StockMatrixRow[]> {
  const stockRes = await supabase.from('current_stock').select('*').eq('agent_id', holderId);
  if (stockRes.error) throw stockRes.error;
  const rows = (stockRes.data ?? []).filter(
    (r): r is { agent_id: string; product_catalog_id: string; quantity_on_hand: number } =>
      r.agent_id !== null && r.product_catalog_id !== null && r.quantity_on_hand !== null,
  );
  if (rows.length === 0) return [];

  const prodIds = Array.from(new Set(rows.map((r) => r.product_catalog_id)));
  const [userRes, prodsRes] = await Promise.all([
    supabase.from('users').select('id, email, display_name, role').eq('id', holderId).maybeSingle(),
    // LEFT embed on clients (see listCurrentStock note): keep product rows even
    // when the caller can't read clients.
    supabase
      .from('product_catalog')
      .select('id, product_name, client_id, clients(name)')
      .in('id', prodIds),
  ]);
  if (userRes.error) throw userRes.error;
  if (prodsRes.error) throw prodsRes.error;

  const u = userRes.data;
  if (!u) return [];
  const prodById = new Map(
    (prodsRes.data ?? []).map((p) => {
      const row = p as {
        id: string;
        product_name: string;
        client_id: string;
        clients: { name: string } | null;
      };
      return [
        row.id,
        {
          product_name: row.product_name,
          client_id: row.client_id,
          client_name: row.clients?.name ?? '',
        },
      ];
    }),
  );

  return rows
    .map((r) => {
      const p = prodById.get(r.product_catalog_id);
      if (!p) return null;
      return {
        user_id: holderId,
        user_email: u.email,
        user_display_name: u.display_name,
        user_role: u.role,
        product_catalog_id: r.product_catalog_id,
        product_name: p.product_name,
        client_id: p.client_id,
        client_name: p.client_name,
        quantity_on_hand: r.quantity_on_hand,
      };
    })
    .filter((r): r is StockMatrixRow => r !== null)
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
}

// ---------------------------------------------------------------------------
// Client-grouped roll-up — total Reda inventory per client, split by where
// it's currently held (warehouse vs agents).
// ---------------------------------------------------------------------------

export type ClientProductTotal = {
  product_catalog_id: string;
  product_name: string;
  total_qty: number;
  warehouse_qty: number;
  agents_qty: number;
};

export type ClientStockGroup = {
  client_id: string;
  client_name: string;
  products: ClientProductTotal[];
  total_qty: number;
  warehouse_qty: number;
  agents_qty: number;
  products_count: number;
};

/** Group a flat StockMatrixRow list by client → product. The split between
 *  warehouse_qty and agents_qty is driven by `user_role === 'warehouse'`.
 *  Sorted by client name asc, products by name asc within each client. */
export function groupByClient(rows: StockMatrixRow[]): ClientStockGroup[] {
  type ProductAccum = Omit<ClientProductTotal, never>;
  const clients = new Map<
    string,
    {
      client_id: string;
      client_name: string;
      products: Map<string, ProductAccum>;
    }
  >();

  for (const r of rows) {
    if (!r.client_id) continue;
    let c = clients.get(r.client_id);
    if (!c) {
      c = { client_id: r.client_id, client_name: r.client_name, products: new Map() };
      clients.set(r.client_id, c);
    }
    let p = c.products.get(r.product_catalog_id);
    if (!p) {
      p = {
        product_catalog_id: r.product_catalog_id,
        product_name: r.product_name,
        total_qty: 0,
        warehouse_qty: 0,
        agents_qty: 0,
      };
      c.products.set(r.product_catalog_id, p);
    }
    p.total_qty += r.quantity_on_hand;
    if (r.user_role === 'warehouse') p.warehouse_qty += r.quantity_on_hand;
    else p.agents_qty += r.quantity_on_hand;
  }

  return Array.from(clients.values())
    .map((c) => {
      const products = Array.from(c.products.values()).sort((a, b) =>
        a.product_name.localeCompare(b.product_name),
      );
      const total_qty = products.reduce((s, p) => s + p.total_qty, 0);
      const warehouse_qty = products.reduce((s, p) => s + p.warehouse_qty, 0);
      const agents_qty = products.reduce((s, p) => s + p.agents_qty, 0);
      return {
        client_id: c.client_id,
        client_name: c.client_name,
        products,
        total_qty,
        warehouse_qty,
        agents_qty,
        products_count: products.length,
      };
    })
    .sort((a, b) => a.client_name.localeCompare(b.client_name));
}

export type CreateAdjustmentInput = {
  clientUuid: string;
  agentId: string;
  productCatalogId: string;
  quantityDelta: number;
  reason: SingleReason;
  notes: string | null;
};

export async function createStockAdjustment(input: CreateAdjustmentInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_stock_adjustment', {
    p_client_uuid: input.clientUuid,
    p_agent_id: input.agentId,
    p_product_catalog_id: input.productCatalogId,
    p_quantity_delta: input.quantityDelta,
    p_reason: input.reason,
    p_notes: input.notes as unknown as string,
  });
  if (error) throw error;
  return data as string;
}

export type CreateTransferInput = {
  clientUuid: string;
  fromUserId: string;
  toUserId: string;
  productCatalogId: string;
  quantity: number;
  reason: PairedReason;
  notes: string | null;
};

export async function createStockTransfer(input: CreateTransferInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_stock_transfer', {
    p_client_uuid: input.clientUuid,
    p_from_user_id: input.fromUserId,
    p_to_user_id: input.toUserId,
    p_product_catalog_id: input.productCatalogId,
    p_quantity: input.quantity,
    p_reason: input.reason,
    p_notes: input.notes as unknown as string,
  });
  if (error) throw error;
  return data as string;
}
