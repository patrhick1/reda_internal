import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';
import type { Role } from '@/lib/permissions';
import { STATUS_GROUPS } from '@/lib/theme';

// The two role-scoped views over deliveries. Same columns except:
//   - deliveries_admin has charged_snapshot, agent_payment_snapshot, margin
//   - deliveries_safe hides charged_snapshot; exposes agent_payment_snapshot only to assigned agent
// Admin queries deliveries_admin; dispatcher and agent query deliveries_safe.
export type DeliveryAdminRow = Database['public']['Views']['deliveries_admin']['Row'];
export type DeliverySafeRow = Database['public']['Views']['deliveries_safe']['Row'];

/** Joined names for display. Same shape regardless of which view was queried. */
export type DeliveryDisplayJoins = {
  client_name: string | null;
  product_name: string | null;
  location_name: string | null;
  assigned_agent_name: string | null;
  /** True when the most-recent delivery_status_history row has been tagged
   *  via mark_client_notified. Powers the "Notified" pill on list rows so
   *  reps can see at a glance which deliveries have already been
   *  communicated. Only listDeliveries computes the real value — single-row
   *  getDelivery defaults this to false, since Detail.tsx renders the
   *  per-history notification state inline (see listClientNotificationsForDelivery). */
  latest_notified: boolean;
};

export type DeliveryRow = (DeliveryAdminRow | DeliverySafeRow) &
  DeliveryDisplayJoins & {
    // deliveries_admin contributes `margin`; deliveries_safe contributes null
    margin: number | null;
  };

export type AgentEarningRow = {
  id: string;
  customer_name: string;
  scheduled_date: string;
  agent_payment_snapshot: number;
  product_name: string | null;
};

/** Returns this agent's delivered-deliveries in the last N days (default 35 — covers month).
 *  Reads from deliveries_safe, which exposes agent_payment_snapshot only to the assigned agent.
 *  Client name is intentionally omitted — agents don't get to see which vendor
 *  the delivery belongs to. */
export async function listAgentEarnings(
  userId: string,
  days: number = 35,
): Promise<AgentEarningRow[]> {
  const todayLagosDate = new Date(new Date().getTime() + 60 * 60 * 1000);
  const cutoff = new Date(todayLagosDate);
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await supabase
    .from('deliveries_safe')
    .select(
      `
      id,
      customer_name,
      scheduled_date,
      agent_payment_snapshot,
      product:product_catalog(product_name)
    `,
    )
    .eq('assigned_agent_id', userId)
    .eq('current_status', 'delivered')
    .gte('scheduled_date', cutoff.toISOString().slice(0, 10))
    .order('scheduled_date', { ascending: false });

  if (error) throw error;
  return (data ?? [])
    .filter(
      (
        row,
      ): row is {
        id: string;
        customer_name: string;
        scheduled_date: string;
        agent_payment_snapshot: number;
        product: { product_name: string } | null;
      } =>
        row.id !== null &&
        row.customer_name !== null &&
        row.scheduled_date !== null &&
        row.agent_payment_snapshot !== null,
    )
    .map((row) => ({
      id: row.id,
      customer_name: row.customer_name,
      scheduled_date: row.scheduled_date,
      agent_payment_snapshot: row.agent_payment_snapshot,
      product_name: row.product?.product_name ?? null,
    }));
}

export type DeliveryStatusDef = Database['public']['Tables']['delivery_status_defs']['Row'];
export type DeliveryStatusTransition =
  Database['public']['Tables']['delivery_status_transitions']['Row'];
export type DeliveryStatusHistoryRow =
  Database['public']['Tables']['delivery_status_history']['Row'] & {
    changed_by_name: string | null;
  };

const VIEW_FOR: Record<Role, 'deliveries_admin' | 'deliveries_safe'> = {
  admin: 'deliveries_admin',
  dispatcher: 'deliveries_safe',
  agent: 'deliveries_safe',
  warehouse: 'deliveries_safe',
  rep: 'deliveries_safe',
};

const JOIN_FRAGMENT = `
  client:clients(name),
  product:product_catalog(product_name),
  location:locations(name),
  assigned_agent:users!deliveries_assigned_agent_id_fkey(display_name)
`;

type JoinShape = {
  client: { name: string } | null;
  product: { product_name: string } | null;
  location: { name: string } | null;
  assigned_agent: { display_name: string } | null;
};

function attachJoins<T extends object>(
  row: T & JoinShape,
): T & DeliveryDisplayJoins & { margin: number | null } {
  const { client, product, location, assigned_agent, ...rest } = row;
  return {
    ...(rest as T),
    client_name: client?.name ?? null,
    product_name: product?.product_name ?? null,
    location_name: location?.name ?? null,
    assigned_agent_name: assigned_agent?.display_name ?? null,
    margin: 'margin' in rest && typeof rest.margin === 'number' ? rest.margin : null,
    // Default for the single-row path; listDeliveries overwrites with the
    // real value after its delivery_client_notifications query.
    latest_notified: false,
  };
}

export type ListFilters = {
  /** ISO date (YYYY-MM-DD). Defaults to today (Africa/Lagos). */
  date?: string;
  /** If true, fetch all dates (no date filter). */
  allDates?: boolean;
};

function todayLagos(): string {
  // Africa/Lagos is +01:00 year-round. Convert UTC now to that offset and slice.
  const now = new Date();
  const lagos = new Date(now.getTime() + 60 * 60 * 1000); // +01:00
  return lagos.toISOString().slice(0, 10);
}

export async function listDeliveries(
  role: Role,
  filters: ListFilters = {},
): Promise<DeliveryRow[]> {
  const view = VIEW_FOR[role];
  // created_at DESC is the stable tiebreaker for rows that share a
  // last-change timestamp (or none at all).
  let query = supabase
    .from(view)
    .select(`*, ${JOIN_FRAGMENT}`)
    .order('created_at', { ascending: false });
  if (!filters.allDates) {
    const d = filters.date ?? todayLagos();
    query = query.eq('scheduled_date', d);
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []).map((row) =>
    attachJoins(row as unknown as JoinShape & object),
  ) as DeliveryRow[];

  // Sort: most recent status change DESC across all statuses — a row
  // cancelled 30 seconds ago should sit above a pending row untouched all
  // day. Pulls (id, delivery_id, changed_at) from delivery_status_history
  // for the fetched IDs in a single second query, then merges client-side.
  // For Reda's scale (~hundreds of rows) this is sub-50ms. We also record
  // the latest history row's id per delivery so the next step can check
  // which of them have been tagged 'client notified'.
  const ids = rows.map((r) => r.id).filter((id): id is string => !!id);
  const lastChange = new Map<string, string>();
  const latestHistoryByDelivery = new Map<string, string>();
  if (ids.length > 0) {
    const { data: history } = await supabase
      .from('delivery_status_history')
      .select('id, delivery_id, changed_at')
      .in('delivery_id', ids)
      .order('changed_at', { ascending: false });
    for (const h of history ?? []) {
      // First occurrence per delivery_id wins (already ordered DESC).
      if (!lastChange.has(h.delivery_id)) {
        lastChange.set(h.delivery_id, h.changed_at);
        latestHistoryByDelivery.set(h.delivery_id, h.id);
      }
    }
  }

  // Resolve which of those latest-history rows have a client-notified tag.
  // Single keyed-by-PK lookup against delivery_client_notifications — RLS
  // already restricts visibility to ops + the assigned agent, so this is
  // safe for every role that hits this code path.
  const notifiedLatestSet = new Set<string>();
  const latestHistoryIds = Array.from(new Set(latestHistoryByDelivery.values()));
  if (latestHistoryIds.length > 0) {
    const { data: notifs } = await supabase
      .from('delivery_client_notifications')
      .select('status_history_id')
      .in('status_history_id', latestHistoryIds);
    for (const n of notifs ?? []) {
      notifiedLatestSet.add(n.status_history_id);
    }
  }
  for (const r of rows) {
    const latestId = latestHistoryByDelivery.get(r.id ?? '');
    r.latest_notified = latestId ? notifiedLatestSet.has(latestId) : false;
  }

  return rows.sort((a, b) => {
    const aT = lastChange.get(a.id ?? '') ?? a.created_at ?? '';
    const bT = lastChange.get(b.id ?? '') ?? b.created_at ?? '';
    return bT.localeCompare(aT);
  });
}

/** A handful of fields per row — used by the New Delivery screen's pre-submit
 *  duplicate check. Not a public type elsewhere. */
export type SimilarOpenDelivery = {
  id: string;
  current_status: string | null;
  raw_address: string | null;
  created_at: string | null;
};

/** Open (active + soft) statuses. Built from STATUS_GROUPS so this stays
 *  in lock-step with the theme's bucket definitions — adding a new soft
 *  status updates the duplicate check automatically. */
const OPEN_STATUSES: string[] = [...STATUS_GROUPS.active, ...STATUS_GROUPS.soft];

/** Returns open (non-terminal, non-deleted) deliveries that match the
 *  agent + normalized customer phone + product + scheduled_date tuple.
 *  Used by the New Delivery screen to warn admin before creating a near-
 *  duplicate row. Deliberately ignores raw_address — the server-side
 *  sibling guard in create_delivery is strict about address match, which
 *  lets typos like "f" vs "Festac" slip through. We surface the suspicion
 *  here and let admin confirm. */
export async function findSimilarOpenDeliveries(
  agentId: string,
  customerPhone: string,
  productCatalogId: string,
  scheduledDate: string,
): Promise<SimilarOpenDelivery[]> {
  const normPhone = normalizePhoneForGrouping(customerPhone);
  if (!normPhone) return [];
  const { data, error } = await supabase
    .from('deliveries')
    .select('id, current_status, raw_address, created_at')
    .eq('assigned_agent_id', agentId)
    .eq('customer_phone_normalized', normPhone)
    .eq('product_catalog_id', productCatalogId)
    .eq('scheduled_date', scheduledDate)
    .is('deleted_at', null)
    .in('current_status', OPEN_STATUSES)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SimilarOpenDelivery[];
}

/** Normalize a Nigerian phone for sibling-grouping. Mirrors the SQL
 *  `_norm_phone` helper used by the server-side sibling-coordination trigger.
 *  Strips non-digits; trims '234' country code; trims a leading 0. Returns
 *  null on empty or null input. */
export function normalizePhoneForGrouping(p: string | null | undefined): string | null {
  if (!p) return null;
  let digits = p.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits || null;
}

/** Sibling-aware group key for a delivery row. Two deliveries that the server
 *  treats as siblings (same race-assignment) produce the same key. Used by
 *  Uzo's home counter to show "unique orders" instead of raw row count.
 *
 *  Approximation note: the server's full sibling rule has a tier-1 path
 *  (identical bot_raw_message text) we can't reproduce here without exposing
 *  that field. In practice race-assigned rows also share normalized address
 *  + quantity (tier 2), so this key catches them. Rows missing phone or
 *  product or date can't have siblings — they stand alone by id. */
export function siblingGroupKey(
  r: Pick<
    DeliveryRow,
    | 'id'
    | 'customer_phone'
    | 'product_catalog_id'
    | 'scheduled_date'
    | 'raw_address'
    | 'quantity_ordered'
  >,
): string {
  const phone = normalizePhoneForGrouping(r.customer_phone);
  if (!phone || !r.product_catalog_id || !r.scheduled_date) {
    return `solo:${r.id}`;
  }
  const addr = (r.raw_address ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qty = r.quantity_ordered ?? 0;
  return `${phone}|${r.product_catalog_id}|${r.scheduled_date}|${addr}|${qty}`;
}

export async function getDelivery(role: Role, id: string): Promise<DeliveryRow | null> {
  const view = VIEW_FOR[role];
  const { data, error } = await supabase
    .from(view)
    .select(`*, ${JOIN_FRAGMENT}`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return attachJoins(data as unknown as JoinShape & object) as DeliveryRow;
}

export type CreateDeliveryInput = {
  clientUuid: string; // client-generated idempotency key
  clientId: string;
  productCatalogId: string;
  customerName: string;
  customerPhone: string;
  rawAddress: string;
  quantityOrdered: number;
  customerPrice: number;
  locationId: string | null;
  scheduledDate: string; // YYYY-MM-DD
  assignedAgentId: string | null;
};

export async function createDelivery(input: CreateDeliveryInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_delivery', {
    p_client_uuid: input.clientUuid,
    p_client_id: input.clientId,
    p_product_catalog_id: input.productCatalogId,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_raw_address: input.rawAddress,
    p_quantity_ordered: input.quantityOrdered,
    p_customer_price: input.customerPrice,
    p_location_id: input.locationId as unknown as string,
    p_scheduled_date: input.scheduledDate,
    p_assigned_agent_id: input.assignedAgentId as unknown as string,
    p_created_via: 'manual',
  });
  if (error) throw error;
  return data as string;
}

export type UpdateDeliveryFieldsPatch = {
  customerName?: string;
  customerPhone?: string;
  rawAddress?: string;
  locationId?: string | null;
  clientId?: string;
  productCatalogId?: string;
  quantityOrdered?: number;
  customerPrice?: number;
  assignedAgentId?: string | null;
};

/** Edits customer-facing fields on a pre-delivery row. Server-side guards:
 *  admin/dispatcher only, status must be pre-delivery, caller must hold a
 *  fresh edit_locks row. Pass only the fields that changed — others are
 *  coalesce'd on the server. */
export async function updateDeliveryFields(
  deliveryId: string,
  patch: UpdateDeliveryFieldsPatch,
): Promise<void> {
  const { error } = await supabase.rpc('update_delivery_fields', {
    p_delivery_id: deliveryId,
    p_customer_name: patch.customerName,
    p_customer_phone: patch.customerPhone,
    p_raw_address: patch.rawAddress,
    p_location_id: patch.locationId as unknown as string | undefined,
    p_client_id: patch.clientId,
    p_product_catalog_id: patch.productCatalogId,
    p_quantity_ordered: patch.quantityOrdered,
    p_customer_price: patch.customerPrice,
    p_assigned_agent_id: patch.assignedAgentId as unknown as string | undefined,
  });
  if (error) throw error;
}

/** Returns the agent's current on-hand quantity for a specific product.
 *  Used by the New Delivery screen to show stock inline + warn the admin
 *  before submitting. Returns 0 if the row isn't present (means no stock
 *  has ever been adjusted for that pair). */
export async function getAgentProductStock(
  agentId: string,
  productCatalogId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('current_stock')
    .select('quantity_on_hand')
    .eq('agent_id', agentId)
    .eq('product_catalog_id', productCatalogId)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.quantity_on_hand ?? 0);
}

export type ChangeStatusInput = {
  clientUuid: string;
  deliveryId: string;
  toStatus: string;
  reason: string | null;
  notes: string | null;
  // For 'delivered' only:
  quantityDelivered: number | null;
  paid: number | null;
  paymentMethod: 'cash' | 'transfer' | null;
  // For 'postponed' only — YYYY-MM-DD; server ignores otherwise.
  newScheduledDate: string | null;
};

export async function changeDeliveryStatus(input: ChangeStatusInput): Promise<void> {
  const { error } = await supabase.rpc('change_delivery_status', {
    p_client_uuid: input.clientUuid,
    p_delivery_id: input.deliveryId,
    p_to_status: input.toStatus,
    p_reason: input.reason as unknown as string,
    p_notes: input.notes as unknown as string,
    p_quantity_delivered: input.quantityDelivered as unknown as number,
    p_paid: input.paid as unknown as number,
    p_payment_method: input.paymentMethod as unknown as string,
    p_new_scheduled_date: input.newScheduledDate as unknown as string,
  });
  if (error) throw error;
}

/** Team-lead handoff: move a delivery from the current owner (must be the
 *  caller, or one of the caller's sub-agents) to another sub-agent in the
 *  caller's team. Permission is enforced server-side by reassign_to_sub_agent.
 *  The standard assignment-push trigger fires on the row update, so the new
 *  assignee gets the "you've been assigned" push without any extra plumbing. */
export async function reassignToSubAgent(
  deliveryId: string,
  subAgentId: string,
  clientUuid: string,
): Promise<void> {
  const { error } = await supabase.rpc('reassign_to_sub_agent', {
    p_client_uuid: clientUuid,
    p_delivery_id: deliveryId,
    p_sub_agent_id: subAgentId,
  });
  if (error) throw error;
}

/** Admin/dispatcher bulk reassign: set the assigned agent on every supplied
 *  delivery in a single round-trip. Terminal / deleted rows and rows already
 *  on the target agent are silently skipped server-side. Returns the count
 *  actually updated for the success toast. Not a status change — the
 *  delivery_status_history table is untouched; the audit_log records each
 *  assignment with reason='bulk_assign'. The assignment-push trigger fires
 *  per row, so the new assignee gets one notification per delivery. */
export async function bulkAssignDeliveries(
  deliveryIds: string[],
  agentId: string,
): Promise<number> {
  // @ts-expect-error — RPC added 2026-05-30 in scripts/manual-rollover-
  // assignment.sql, not yet in database.gen.ts. Will resolve after the
  // next `npm run gen:types` once the SQL has been applied.
  const { data, error } = await supabase.rpc('bulk_assign_deliveries', {
    p_delivery_ids: deliveryIds,
    p_agent_id: agentId,
  });
  if (error) throw error;
  return (data ?? 0) as number;
}

/** Admin-only soft delete. Server raises on delivered / rolled_over (the
 *  FINAL_STATUSES gate) and on missing rows; idempotent on already-deleted
 *  rows (no-op return). Reason is required. */
export async function deleteDelivery(deliveryId: string, reason: string): Promise<void> {
  // @ts-expect-error — RPC added in scripts/delete-deliveries.sql, not yet in
  // database.gen.ts. Resolves after the next `npm run gen:types`.
  const { error } = await supabase.rpc('delete_delivery', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Admin-only bulk soft delete. Returns the per-row tally. Rows in
 *  delivered/rolled_over, already-deleted, or missing IDs are reported as
 *  skipped without raising. */
export async function bulkDeleteDeliveries(
  deliveryIds: string[],
  reason: string,
): Promise<{ deletedCount: number; skippedCount: number }> {
  // @ts-expect-error — RPC added in scripts/delete-deliveries.sql.
  const { data, error } = await supabase.rpc('bulk_delete_deliveries', {
    p_delivery_ids: deliveryIds,
    p_reason: reason,
  });
  if (error) throw error;
  const row = (data ?? {}) as { deleted_count?: number; skipped_count?: number };
  return {
    deletedCount: row.deleted_count ?? 0,
    skippedCount: row.skipped_count ?? 0,
  };
}

/** Admin/dispatcher bulk status change. The server iterates change_delivery_
 *  status per row, so all the usual validation (transition table,
 *  requires_admin, requires_reason, sibling-cascade trigger) goes through one
 *  canonical path. Rows that fail validation are reported as skipped, not as
 *  errors — the caller decides what to do with the count summary. */
export async function bulkChangeStatus(
  deliveryIds: string[],
  toStatus: string,
  reason: string,
  clientUuid: string,
): Promise<{ changedCount: number; skippedCount: number }> {
  // @ts-expect-error — RPC added in scripts/delete-deliveries.sql.
  const { data, error } = await supabase.rpc('bulk_change_delivery_status', {
    p_client_uuid: clientUuid,
    p_delivery_ids: deliveryIds,
    p_to_status: toStatus,
    p_reason: reason,
  });
  if (error) throw error;
  const row = (data ?? {}) as { changed_count?: number; skipped_count?: number };
  return {
    changedCount: row.changed_count ?? 0,
    skippedCount: row.skipped_count ?? 0,
  };
}

export async function listDeliveryHistory(deliveryId: string): Promise<DeliveryStatusHistoryRow[]> {
  const { data, error } = await supabase
    .from('delivery_status_history')
    .select('*, changed_by:users(display_name)')
    .eq('delivery_id', deliveryId)
    .order('effective_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const r = row as Database['public']['Tables']['delivery_status_history']['Row'] & {
      changed_by: { display_name: string } | null;
    };
    const { changed_by, ...rest } = r;
    return { ...rest, changed_by_name: changed_by?.display_name ?? null };
  });
}

// State machine reads — same surface for everyone, RLS allows select-all on these tables.

export async function listStatusDefs(): Promise<DeliveryStatusDef[]> {
  const { data, error } = await supabase
    .from('delivery_status_defs')
    .select('*')
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

export async function listTransitionsFrom(
  from: string,
  isAdmin: boolean,
): Promise<DeliveryStatusTransition[]> {
  // Embed the target status's sort_order so we can return transitions in
  // the same order ops sees everywhere else (e.g. Available right before
  // Available evening). The constraint name disambiguates between the
  // from_status and to_status FKs that both point at delivery_status_defs.
  let query = supabase
    .from('delivery_status_transitions')
    .select('*, to_def:delivery_status_defs!delivery_status_transitions_to_status_fkey(sort_order)')
    .eq('from_status', from);
  if (!isAdmin) {
    query = query.eq('requires_admin', false);
  }
  const { data, error } = await query;
  if (error) throw error;
  type Joined = DeliveryStatusTransition & { to_def: { sort_order: number } | null };
  const rows = (data ?? []) as unknown as Joined[];
  rows.sort(
    (a, b) =>
      (a.to_def?.sort_order ?? Number.MAX_SAFE_INTEGER) -
      (b.to_def?.sort_order ?? Number.MAX_SAFE_INTEGER),
  );
  return rows.map(({ to_def: _drop, ...rest }) => rest);
}

export type ChargePreview = {
  rate_card_charged: number;
  effective_charged: number;
  client_ceiling: number | null;
  was_clamped: boolean;
};

/** Mirrors the server-side clamp so the new-delivery screen can show
 *  "Reda charge: ₦9,000 (clamped from rate card ₦10,000)" before submit. */
export async function previewDeliveryCharge(
  locationId: string,
  clientId: string,
): Promise<ChargePreview | null> {
  const { data, error } = await supabase.rpc('preview_delivery_charge', {
    p_location_id: locationId,
    p_client_id: clientId,
  });
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ?? null;
}
