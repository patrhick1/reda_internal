import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';
import type { Role } from '@/lib/permissions';
import { STATUS_GROUPS, STATUS_META } from '@/lib/theme';
import { formatDayMonthLagos } from '@/lib/date';

// The two role-scoped views over deliveries. Same columns except:
//   - deliveries_admin has charged_snapshot, agent_payment_snapshot, margin
//   - deliveries_safe hides charged_snapshot; exposes agent_payment_snapshot only to assigned agent
// Admin queries deliveries_admin; dispatcher and agent query deliveries_safe.
export type DeliveryAdminRow = Database['public']['Views']['deliveries_admin']['Row'];
export type DeliverySafeRow = Database['public']['Views']['deliveries_safe']['Row'];

/** Joined names for display, plus per-row latest_* aggregates the deliveries
 *  views now embed via LATERAL joins. Same shape regardless of which view
 *  was queried. See scripts/embed-latest-history-in-deliveries-views.sql. */
export type DeliveryDisplayJoins = {
  client_name: string | null;
  product_name: string | null;
  location_name: string | null;
  assigned_agent_name: string | null;
  /** Most recent delivery_status_history.id for this delivery (from view's
   *  LATERAL join). Null if the delivery has no history rows yet. */
  latest_history_id: string | null;
  /** Most recent delivery_status_history.changed_at for this delivery
   *  (from view's LATERAL join). Drives the list's sort key (descending)
   *  so a row touched 30s ago sits above one untouched all day. Null if
   *  the delivery has no history rows yet — list falls back to created_at. */
  latest_changed_at: string | null;
  /** True when the most-recent delivery_status_history row has been tagged
   *  via mark_client_notified. Powers the "Notified" pill on list rows so
   *  reps can see at a glance which deliveries have already been
   *  communicated. Embedded via LEFT JOIN to delivery_client_notifications
   *  in the deliveries views since 2026-06-04. */
  latest_notified: boolean;
  /** Most recent delivery_messages.created_at for this delivery (from the
   *  view's LATERAL join). Folded into the list sort alongside
   *  latest_changed_at so a new thread message bubbles the row to the top the
   *  same way a status change does. Null if the delivery has no messages.
   *  See scripts/embed-latest-message-in-deliveries-views.sql. */
  latest_message_at: string | null;
};

/** [Feature A] One product line of a delivery (from delivery_items, joined to
 *  product_catalog for the name). A delivery is an envelope of N of these. */
export type DeliveryItem = {
  id: string;
  product_catalog_id: string;
  product_name: string | null;
  quantity_ordered: number;
  quantity_delivered: number | null;
  customer_price: number | null;
};

/** Line-item input for create / edit. customer_price is record-keeping only. */
export type DeliveryItemInput = {
  productCatalogId: string;
  quantityOrdered: number;
  customerPrice?: number | null;
};

/** Per-line delivered quantity, captured at mark-delivered. */
export type DeliveryItemDelivered = {
  productCatalogId: string;
  quantityDelivered: number;
};

export type DeliveryRow = (DeliveryAdminRow | DeliverySafeRow) &
  DeliveryDisplayJoins & {
    // deliveries_admin contributes `margin`; deliveries_safe contributes null
    margin: number | null;
    /** [Feature A] The delivery's line items, attached via a batched second
     *  query (see attachItemsToRows). Empty array if none resolved. The legacy
     *  product_name / quantity_ordered columns remain for back-compat display
     *  until the contract phase drops them. */
    items: DeliveryItem[];
  };

/** [Feature A] Fetch line items for a set of deliveries in one query and group
 *  by delivery_id. Done as a separate query (not a PostgREST view-embed) so it
 *  works regardless of whether the deliveries_* views expose the relationship.
 *  delivery_items isn't in database.gen.ts until `npm run gen:types` runs at
 *  cutover, so the table name is cast. */
export async function fetchDeliveryItemsFor(
  deliveryIds: string[],
): Promise<Record<string, DeliveryItem[]>> {
  const ids = deliveryIds.filter(Boolean);
  if (ids.length === 0) return {};
  // delivery_items isn't in database.gen.ts until `npm run gen:types` runs at
  // cutover, so we reach it through an untyped client handle and assert the row
  // shape ourselves.
  type RawItemRow = {
    id: string;
    delivery_id: string;
    product_catalog_id: string;
    quantity_ordered: number;
    quantity_delivered: number | null;
    customer_price: number | null;
    product: { product_name: string } | null;
  };
  const untyped = supabase as unknown as {
    from: (table: string) => ReturnType<typeof supabase.from>;
  };
  const { data, error } = await untyped
    .from('delivery_items')
    .select(
      'id, delivery_id, product_catalog_id, quantity_ordered, quantity_delivered, customer_price, product:product_catalog(product_name)',
    )
    .in('delivery_id', ids);
  if (error) throw error;
  const map: Record<string, DeliveryItem[]> = {};
  for (const r of (data ?? []) as unknown as RawItemRow[]) {
    (map[r.delivery_id] ??= []).push({
      id: r.id,
      product_catalog_id: r.product_catalog_id,
      product_name: r.product?.product_name ?? null,
      quantity_ordered: r.quantity_ordered,
      quantity_delivered: r.quantity_delivered,
      customer_price: r.customer_price,
    });
  }
  return map;
}

/** [Feature A] Itemized product summary for display:
 *  "Opulent Oud ×2, Atomizer ×4". Falls back to the legacy single product when
 *  items aren't attached (older rows / partial loads). */
export function deliveryProductsSummary(row: {
  items?: DeliveryItem[] | null;
  product_name?: string | null;
  quantity_ordered?: number | null;
}): string {
  if (row.items && row.items.length > 0) {
    return row.items.map((i) => `${i.product_name ?? 'Product'} ×${i.quantity_ordered}`).join(', ');
  }
  const name = row.product_name ?? '—';
  return row.quantity_ordered != null ? `${name} ×${row.quantity_ordered}` : name;
}

// Soft-failure statuses are the only prior statuses worth surfacing on a
// carried-over row: they mean "attempted yesterday and didn't land". Active
// statuses ('available') are noise here, and a terminal value ('picked_up')
// would read as contradictory on a now-pending row (only possible from
// pre-terminal-reclassification history; never from a forward roll).
const ROLLED_FROM_SURFACED = new Set<string>(STATUS_GROUPS.soft);

/** Human label for a rolled-over delivery's prior status, e.g.
 *  "was Not answering · 16 Jun" or "2× · was Not answering · 16 Jun".
 *  Returns null when the row isn't a carry-over, carried only an untouched
 *  'pending', or carried a non-soft status we don't surface. Sourced from the
 *  rolled_from_* snapshot set at rollover time (carried forward across
 *  multi-day chains). Shared by the list row and the detail screen. */
export function rolledFromLabel(row: {
  rolled_from_status?: string | null;
  rolled_from_date?: string | null;
  rollover_count?: number | null;
}): string | null {
  if (!row.rolled_from_status || !ROLLED_FROM_SURFACED.has(row.rolled_from_status)) return null;
  const label = STATUS_META[row.rolled_from_status]?.label ?? row.rolled_from_status;
  const times = (row.rollover_count ?? 0) > 1 ? `${row.rollover_count}× · ` : '';
  const when = row.rolled_from_date ? ` · ${formatDayMonthLagos(row.rolled_from_date)}` : '';
  return `${times}was ${label}${when}`;
}

/** [Feature A] Compact product label for tight list rows: "3 items" for a
 *  bundle, the product name for a single line. */
export function deliveryProductsLabel(row: {
  items?: DeliveryItem[] | null;
  product_name?: string | null;
}): string {
  if (row.items && row.items.length > 1) return `${row.items.length} items`;
  if (row.items && row.items.length === 1) return row.items[0]?.product_name ?? 'Product';
  return row.product_name ?? '—';
}

/** Attach an `items` array to each delivery row (one batched query). Rows with
 *  no items get []. Used by listDeliveries / getDelivery. */
async function attachItemsToRows<T extends { id: string | null }>(
  rows: (T & { items?: DeliveryItem[] })[],
): Promise<(T & { items: DeliveryItem[] })[]> {
  const byDelivery = await fetchDeliveryItemsFor(
    rows.map((r) => r.id).filter((x): x is string => !!x),
  );
  return rows.map((r) => ({ ...r, items: (r.id && byDelivery[r.id]) || [] }));
}

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
    // latest_* fields come embedded from the deliveries views (LATERAL + LEFT
    // JOIN). The spread above carries them through at runtime; these explicit
    // reads put them on the static type (until database.gen.ts is regenerated
    // to include them) and defend against any path that bypasses the view.
    latest_history_id:
      'latest_history_id' in rest && typeof rest.latest_history_id === 'string'
        ? rest.latest_history_id
        : null,
    latest_changed_at:
      'latest_changed_at' in rest && typeof rest.latest_changed_at === 'string'
        ? rest.latest_changed_at
        : null,
    latest_message_at:
      'latest_message_at' in rest && typeof rest.latest_message_at === 'string'
        ? rest.latest_message_at
        : null,
    latest_notified:
      'latest_notified' in rest && typeof rest.latest_notified === 'boolean'
        ? rest.latest_notified
        : false,
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
  const joined = (data ?? []).map((row) =>
    attachJoins(row as unknown as JoinShape & object),
  ) as Omit<DeliveryRow, 'items'>[];
  // [Feature A] attach line items (one batched query).
  const rows = (await attachItemsToRows(joined)) as DeliveryRow[];

  // Sort by most recent ACTIVITY DESC — a row touched 30s ago sits above one
  // untouched all day. "Activity" = the latest of a status change
  // (latest_changed_at), a thread message (latest_message_at), or creation
  // (created_at). Folding in latest_message_at means a new message bubbles the
  // row to the top exactly like a status change does. All three timestamps are
  // embedded on the deliveries views via LATERAL joins, so this whole function
  // is a single PostgREST round trip.
  // See scripts/embed-latest-history-in-deliveries-views.sql and
  //     scripts/embed-latest-message-in-deliveries-views.sql.
  return rows.sort((a, b) => latestActivityAt(b).localeCompare(latestActivityAt(a)));
}

/** The agent's own orders that were postponed to a FUTURE date. Postponing moves
 *  a row's scheduled_date forward in place (status stays 'postponed', the agent
 *  stays assigned), so it drops off the today list and would otherwise vanish
 *  from the agent's view until that day arrives. This surfaces them so the agent
 *  can still check the order / re-engage if the customer calls back early.
 *
 *  Scoped to `assigned_agent_id = me`, status 'postponed', scheduled_date in the
 *  future. RLS already lets an agent read their own rows on any date, so no
 *  backend change is needed. Ordered by the date they were postponed TO, soonest
 *  first. Same join + line-item pipeline as listDeliveries so cards render
 *  identically. */
export async function listAgentPostponed(userId: string): Promise<DeliveryRow[]> {
  const { data, error } = await supabase
    .from('deliveries_safe')
    .select(`*, ${JOIN_FRAGMENT}`)
    .eq('assigned_agent_id', userId)
    .eq('current_status', 'postponed')
    .gt('scheduled_date', todayLagos())
    .order('scheduled_date', { ascending: true });
  if (error) throw error;
  const joined = (data ?? []).map((row) =>
    attachJoins(row as unknown as JoinShape & object),
  ) as Omit<DeliveryRow, 'items'>[];
  return (await attachItemsToRows(joined)) as DeliveryRow[];
}

/** Most recent activity timestamp for list ordering: the max of the row's last
 *  status change, last thread message, and creation time. ISO timestamptz
 *  strings share one format, so lexical comparison is chronological. */
function latestActivityAt(r: {
  latest_changed_at: string | null;
  latest_message_at: string | null;
  created_at: string | null;
}): string {
  let t = r.created_at ?? '';
  if ((r.latest_changed_at ?? '') > t) t = r.latest_changed_at as string;
  if ((r.latest_message_at ?? '') > t) t = r.latest_message_at as string;
  return t;
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
    | 'items'
  >,
): string {
  const phone = normalizePhoneForGrouping(r.customer_phone);
  if (!phone || !r.scheduled_date) {
    return `solo:${r.id}`;
  }
  // [Feature A] Identity is the ITEM SET, mirroring the server's
  // _delivery_items_sig (sorted product:qty). Falls back to the legacy single
  // product+qty for rows whose items haven't been attached.
  const itemSig =
    r.items && r.items.length > 0
      ? r.items
          .map((i) => `${i.product_catalog_id}:${i.quantity_ordered}`)
          .sort()
          .join('|')
      : r.product_catalog_id
        ? `${r.product_catalog_id}:${r.quantity_ordered ?? 0}`
        : null;
  if (!itemSig) return `solo:${r.id}`;
  const addr = (r.raw_address ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${phone}|${itemSig}|${r.scheduled_date}|${addr}`;
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
  const joined = attachJoins(data as unknown as JoinShape & object) as Omit<DeliveryRow, 'items'>;
  const [row] = await attachItemsToRows([joined]);
  return row as DeliveryRow;
}

export type CreateDeliveryInput = {
  clientUuid: string; // client-generated idempotency key
  clientId: string;
  /** Legacy primary product (the first line). Kept for back-compat / dual-write. */
  productCatalogId: string;
  customerName: string;
  customerPhone: string;
  customerPhoneAlt?: string | null;
  rawAddress: string;
  /** Legacy primary quantity (the first line). */
  quantityOrdered: number;
  /** The single order total on the delivery. */
  customerPrice: number;
  locationId: string | null;
  scheduledDate: string; // YYYY-MM-DD
  assignedAgentId: string | null;
  /** [Feature A] The full line-item set. When omitted, the server derives a
   *  1-item array from productCatalogId/quantityOrdered (old callers unaffected). */
  items?: DeliveryItemInput[];
};

/** Maps a DeliveryItemInput[] to the p_items jsonb shape the RPCs expect. */
function toItemsJsonb(items: DeliveryItemInput[] | undefined): unknown {
  if (!items || items.length === 0) return undefined;
  return items.map((i) => ({
    product_catalog_id: i.productCatalogId,
    quantity_ordered: i.quantityOrdered,
    customer_price: i.customerPrice ?? null,
  }));
}

export async function createDelivery(input: CreateDeliveryInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_delivery', {
    p_client_uuid: input.clientUuid,
    p_client_id: input.clientId,
    p_product_catalog_id: input.productCatalogId,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_customer_phone_alt: input.customerPhoneAlt as unknown as string | undefined,
    p_raw_address: input.rawAddress,
    p_quantity_ordered: input.quantityOrdered,
    p_customer_price: input.customerPrice,
    p_location_id: input.locationId as unknown as string,
    p_scheduled_date: input.scheduledDate,
    p_assigned_agent_id: input.assignedAgentId as unknown as string,
    p_created_via: 'manual',
    p_items: toItemsJsonb(input.items) as unknown as undefined, // [Feature A]
  });
  if (error) throw error;
  return data as string;
}

export type UpdateDeliveryFieldsPatch = {
  customerName?: string;
  customerPhone?: string;
  /** '' clears the alt phone; a value sets it; omit to leave unchanged. */
  customerPhoneAlt?: string;
  rawAddress?: string;
  locationId?: string | null;
  clientId?: string;
  productCatalogId?: string;
  quantityOrdered?: number;
  customerPrice?: number;
  assignedAgentId?: string | null;
  /** [Feature A] Replace the full line-item set. Omit to leave items unchanged
   *  (the server keeps them in sync with any legacy single-product edit). */
  items?: DeliveryItemInput[];
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
    p_customer_phone_alt: patch.customerPhoneAlt,
    p_raw_address: patch.rawAddress,
    p_location_id: patch.locationId as unknown as string | undefined,
    p_client_id: patch.clientId,
    p_product_catalog_id: patch.productCatalogId,
    p_quantity_ordered: patch.quantityOrdered,
    p_customer_price: patch.customerPrice,
    p_assigned_agent_id: patch.assignedAgentId as unknown as string | undefined,
    p_items: toItemsJsonb(patch.items) as unknown as undefined, // [Feature A]
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

/** [Feature A] Batched per-line stock: the agent's on-hand for a set of
 *  products in one query → map of productCatalogId → on-hand (0 when absent).
 *  Used by the line-items form + mark-delivered sheet to validate every line. */
export async function getAgentProductsStock(
  agentId: string,
  productCatalogIds: string[],
): Promise<Record<string, number>> {
  const ids = [...new Set(productCatalogIds.filter(Boolean))];
  if (!agentId || ids.length === 0) return {};
  const { data, error } = await supabase
    .from('current_stock')
    .select('product_catalog_id, quantity_on_hand')
    .eq('agent_id', agentId)
    .in('product_catalog_id', ids);
  if (error) throw error;
  const map: Record<string, number> = {};
  for (const r of data ?? []) {
    if (r.product_catalog_id) map[r.product_catalog_id] = Number(r.quantity_on_hand ?? 0);
  }
  return map;
}

export type ChangeStatusInput = {
  clientUuid: string;
  deliveryId: string;
  toStatus: string;
  reason: string | null;
  notes: string | null;
  // For 'delivered' only:
  /** Order-total delivered quantity (sum of the per-line quantities). */
  quantityDelivered: number | null;
  paid: number | null;
  paymentMethod: 'cash' | 'transfer' | null;
  // For 'postponed' only — YYYY-MM-DD; server ignores otherwise.
  newScheduledDate: string | null;
  /** [Feature A] Per-line delivered quantities. When omitted on a delivered
   *  transition, the server fans quantityDelivered onto the order's lone item. */
  itemQuantities?: DeliveryItemDelivered[];
};

export async function changeDeliveryStatus(input: ChangeStatusInput): Promise<void> {
  const itemQuantities =
    input.itemQuantities && input.itemQuantities.length > 0
      ? input.itemQuantities.map((i) => ({
          product_catalog_id: i.productCatalogId,
          quantity_delivered: i.quantityDelivered,
        }))
      : undefined;
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
    p_item_quantities: itemQuantities as unknown as undefined, // [Feature A]
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

/** Admin/dispatcher/rep: clear assigned_agent_id on a non-terminal delivery,
 *  moving it back to the Unassigned bucket. Reason is required and prefixed
 *  with 'unassign:' in the audit_log so consumers can filter for unassign
 *  events. Server raises on terminal / deleted / already-unassigned rows;
 *  the caller surfaces the raise text via the sheet's error banner. The
 *  assignment-push trigger does NOT fire on unassign (it gates on new agent
 *  not null) so the previous assignee is not notified — they just stop
 *  seeing the row in their list on next refresh. */
export async function unassignDelivery(deliveryId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('unassign_delivery', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Admin: correct the location on an already-DELIVERED row. The server re-runs
 *  effective_rate(new_location, client, agent) and re-snapshots both
 *  charged_snapshot (Reda's fee) and agent_payment_snapshot (the agent's
 *  earning) — the normal Edit path refuses delivered rows, and these snapshots
 *  feed reconciliation directly, so a wrong location silently mis-bills both
 *  sides until corrected here. Reason is required and prefixed with
 *  'location_correction:' in the audit_log. Server raises on non-admin
 *  callers, non-delivered / deleted rows, an unchanged location, or a target
 *  location with no active rate card; the caller surfaces the raise text. */
export async function correctDeliveryLocation(
  deliveryId: string,
  locationId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase.rpc('correct_delivery_location', {
    p_delivery_id: deliveryId,
    p_location_id: locationId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Admin: revert a wrongly-`delivered` row back to `pending`. The server
 *  nulls quantity_delivered / paid / payment_method / cash_pos_fee_snapshot
 *  on the row and inserts a status_history entry. Stock auto-recovers via
 *  the current_stock view (delivered_decrements CTE filters on
 *  current_status='delivered'); no stock_adjustments row is written — that
 *  would double-count. Siblings cancelled by the original delivered's
 *  cascade STAY cancelled — admin reviews and reopens those separately if
 *  needed (the cascade trigger only fires on transitions INTO terminal so
 *  the revert doesn't re-fire it). agent_payment_snapshot and
 *  charged_snapshot are unchanged — they're set at create time from the
 *  rate card and remain valid. Reason prefixed with 'revert_delivered:' in
 *  audit_log. Server raises 42501 on non-admin callers, 22023 on
 *  non-delivered / deleted / empty-reason; the caller surfaces the raise
 *  text via the sheet's error banner. */
export async function revertDeliveryToPending(deliveryId: string, reason: string): Promise<void> {
  // `revert_delivery_to_pending` is a hand-written RPC not yet in the
  // generated DB types — cast once so the typed rpc chain still flows,
  // same pattern as mobile/src/services/available-orders.ts for the
  // available_orders_safe view.
  const { error } = await (
    supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc('revert_delivery_to_pending', {
    p_delivery_id: deliveryId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Admin/dispatcher/rep: clear `location_id` on a non-terminal delivery so
 *  admin can wait for clarification. Snapshots stay intact and will
 *  refresh when a new location is set via update_delivery_fields. Server
 *  raises 42501 on agent callers, 22023 on terminal / deleted / empty-
 *  reason / already-null. SQL: scripts/clear-delivery-location.sql. */
export async function clearDeliveryLocation(deliveryId: string, reason: string): Promise<void> {
  const { error } = await (
    supabase as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc('clear_delivery_location', {
    p_delivery_id: deliveryId,
    p_reason: reason,
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

/** One row of a delivery's merged history timeline (the delivery + its rollover
 *  ancestry). Comes from list_delivery_history_chain. `is_current` marks rows
 *  belonging to the delivery being viewed (vs. an earlier carried-over day);
 *  `scheduled_date` is the owning delivery's date, for day dividers. */
export type DeliveryChainHistoryRow =
  Database['public']['Functions']['list_delivery_history_chain']['Returns'][number];

/** Status history for a delivery AND its rollover ancestry (parent chain),
 *  oldest delivery first and chronological within each. Backed by a
 *  SECURITY DEFINER RPC so the ancestry is reachable for every role (an agent
 *  can't read a parent assigned to someone else via the deliveries views, but
 *  the chain's history is). Powers the detail screen's merged timeline. */
export async function listDeliveryHistoryChain(
  deliveryId: string,
): Promise<DeliveryChainHistoryRow[]> {
  const { data, error } = await supabase.rpc('list_delivery_history_chain', {
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
  return (data ?? []) as DeliveryChainHistoryRow[];
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
