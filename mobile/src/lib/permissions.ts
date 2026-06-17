// Permission helpers. Each one mirrors a server-side RLS check or column lock.
// The 1:1 mapping is the whole point — if a helper says "yes" but the server says "no",
// the UI shows a button that fails. If the server says "yes" but the helper says "no",
// the UI hides a button users could legitimately use.
//
// Anchor (database): supabase/dashboard → is_admin(), is_admin_or_dispatcher(), public.users.role check.
// Anchor (column lock): SELECT on deliveries.charged_snapshot is revoked from authenticated.

import { FINAL_STATUSES, STATUS_GROUPS, statusBucket } from '@/lib/theme';

export type Role = 'admin' | 'dispatcher' | 'agent' | 'warehouse' | 'rep';

const ROLES: readonly Role[] = ['admin', 'dispatcher', 'agent', 'warehouse', 'rep'] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

// Operational-coordinator roles. Mirrors the server-side body of
// public.is_admin_or_dispatcher() — admin, dispatcher, and rep all
// share dispatcher-level operational permissions. `rep` is the
// stock-less dispatcher variant: same here in the UI, gated to drop
// stock screens via the (rep) route group + the canAdjustAnyStock /
// canAdjustOwnStock helpers below.
const OPS_ROLES: ReadonlySet<Role> = new Set(['admin', 'dispatcher', 'rep']);
export const isOps = (role: Role): boolean => OPS_ROLES.has(role);

// Operational MANAGERS — admin + dispatcher only. Mirrors the server-side
// public.is_manager(). Reps are deliberately excluded: per Uzo (2026-06-10)
// the needs-review queue and all order-mutation (edit fields, assign/reassign,
// unassign, clear-location) are manager-only. Reps keep the rest of the ops
// surface (deliveries read, follow-ups, comms, audit) via isOps above.
const MANAGER_ROLES: ReadonlySet<Role> = new Set(['admin', 'dispatcher']);
const isManager = (role: Role): boolean => MANAGER_ROLES.has(role);

// --- Read permissions ---------------------------------------------------------

/** Margin (charged − agent_payment). Admin-only.
 * Server anchor: column-level SELECT revoke on deliveries.charged_snapshot;
 * deliveries_admin view gated by is_admin(). */
export function canSeeMargin(role: Role): boolean {
  return role === 'admin';
}

/** Reda's per-trip charge. Admin-only (same anchor as margin). */
export function canSeeCharged(role: Role): boolean {
  return role === 'admin';
}

/** Audit log. Operational set (admin + dispatcher + rep).
 * Server anchor: audit_log_select_admin_dispatcher policy → is_admin_or_dispatcher(). */
export function canSeeAuditLog(role: Role): boolean {
  return isOps(role);
}

/** Drill into a different holder's stock-movement history. Agents always
 *  have their own surface (no gate); this controls whether a holder-card
 *  tap-to-history affordance is wired up at all. Mirrors the server-side
 *  list_stock_movements gate, which itself mirrors stock_adj_select_admin_dispatcher.
 *  Server anchor: list_stock_movements(...) auth check + stock_adj_select_admin_dispatcher policy. */
export function canViewOthersStockHistory(role: Role): boolean {
  return isOps(role) || role === 'warehouse';
}

/** Address-match log + Needs Review queue. Operational set.
 * Server anchor: aml_select_admin_dispatcher policy → is_admin_or_dispatcher(). */
export function canSeeAddressMatchLog(role: Role): boolean {
  return isOps(role);
}

/** Rate card. Operational set.
 * Server anchor: rate_card_select_admin_dispatcher policy → is_admin_or_dispatcher(). */
export function canSeeRateCard(role: Role): boolean {
  return isOps(role);
}

/** Client (vendor) identity on delivery surfaces. Operational set — reps coordinate
 *  with vendors so they need to see whose order it is at a glance. Agents are
 *  redacted on their own screens (anti-poaching); this helper documents the
 *  intent on the shared screens. */
export function canSeeClientName(role: Role): boolean {
  return isOps(role);
}

/** Narrow the shared deliveries list by agent and/or customer-name. Operational
 *  set (admin + dispatcher + rep). These are pure CLIENT-SIDE filters over the
 *  ops-wide list every ops role already loads — no mutation, no extra data
 *  exposure (reps already read the full list + the agent roster), so they ride
 *  on the read audience, not the manager-only assign gate. Agents are excluded:
 *  their own screen shows at most a handful of rows, so narrowing has no work.
 *  No server anchor — read-only UI affordance. */
export function canFilterDeliveriesList(role: Role): boolean {
  return isOps(role);
}

// --- Write permissions --------------------------------------------------------

/** Manage catalog: clients, products, locations, rate card. Admin-only.
 * Server anchor: *_all_admin policies on clients/locations/product_catalog/rate_card. */
export function canEditCatalog(role: Role): boolean {
  return role === 'admin';
}

/** Manage users (create, deactivate). Admin-only.
 * Server anchor: users_insert_admin, users_update_admin, users_delete_admin. */
export function canManageUsers(role: Role): boolean {
  return role === 'admin';
}

/** Manage agent profiles. Admin-only.
 * Server anchor: agent_profiles_all_admin. */
export function canManageAgentProfiles(role: Role): boolean {
  return role === 'admin';
}

// --- Stock permissions --------------------------------------------------------
// Server anchor: scripts/warehouse-stock-ops.sql — create_stock_adjustment +
// create_stock_transfer permission branches. Adjustments stay admin/warehouse
// (warehouse own-stock only). Transfers admit dispatcher too — dispatcher
// coordinates rider stock without holding any themselves, so they pick any
// from/to without the participant restriction warehouse has.

/** Adjust ANOTHER user's stock for any reason, or use the `correction`
 *  escape hatch. Admin-only.
 *  Server anchor: create_stock_adjustment v_role='admin' branch. */
export function canAdjustAnyStock(role: Role): boolean {
  return role === 'admin';
}

/** Adjust the warehouse's own stock with non-correction reasons. Admin +
 *  warehouse (covers both a place AND its staff — staff act on the linked
 *  place's holdings; server enforces coalesce(warehouse_id, self)). Admin can
 *  adjust any holder; this helper just gates the screen-level "show Adjust".
 *  Server anchor: create_stock_adjustment v_role='warehouse' branch. */
export function canAdjustOwnStock(role: Role): boolean {
  return role === 'admin' || role === 'warehouse';
}

/** Vendor intake (`bulk_intake`) into the warehouse. Admin + warehouse
 *  (place or staff acting on their place).
 *  Server anchor: create_stock_adjustment reason='bulk_intake'. */
export function canReceiveStock(role: Role): boolean {
  return role === 'admin' || role === 'warehouse';
}

/** Paired warehouse_issue / warehouse_return transfer. Admin + dispatcher + warehouse.
 *  Warehouse must be a participant — its PLACE (from for issue, to for return),
 *  whether the caller is the place or its staff — enforced server-side; admin +
 *  dispatcher have no participant restriction. This helper just gates the screen.
 *  Server anchor: create_stock_transfer warehouse_issue / warehouse_return branches. */
export function canDoWarehouseTransfer(role: Role): boolean {
  return role === 'admin' || role === 'dispatcher' || role === 'warehouse';
}

/** Agent-to-agent transfer. Admin + dispatcher.
 *  Dispatcher coordinates rider stock between routes; warehouse role cannot
 *  do this (they're tied to their own holdings).
 *  Server anchor: create_stock_transfer reason='transfer' (admin + dispatcher). */
export function canTransferAgentToAgent(role: Role): boolean {
  return role === 'admin' || role === 'dispatcher';
}

/** Correction adjustment (the books-override path). Admin-only — kept as
 *  the single accountability anchor for "the math was wrong, force the books."
 *  Server anchor: create_stock_adjustment only admin can pass reason='correction'. */
export function canCorrectStock(role: Role): boolean {
  return role === 'admin';
}

/** Start a brand-new delivery from scratch. Admin + dispatcher only — reps are
 *  the coordination/comms layer with vendors and don't author new orders; new
 *  deliveries enter the system via the bot pipeline or admin/dispatcher.
 *  Reps still create deliveries indirectly via the bot-review fix flow
 *  (resolve_inbound_to_delivery), which is anchored by canResolveReview — the
 *  server keeps is_admin_or_dispatcher() on create_delivery so that path keeps
 *  working without a second RPC. This helper gates ONLY the manual New-delivery
 *  entry points (List FAB, dashboard FAB, /deliveries/new route). */
export function canCreateDelivery(role: Role): boolean {
  return role === 'admin' || role === 'dispatcher';
}

/** Assign/reassign delivery to an agent. Managers only (admin + dispatcher).
 *  Assignment is an order-mutation, restricted to managers per Uzo
 *  (2026-06-10) — reps lost the single-row reassign affordance along with
 *  the rest of order editing.
 *  Server anchor: update_delivery_fields / unassign_delivery gate on is_manager();
 *  deliveries_update_admin_dispatcher policy tightened to is_manager(). */
export function canAssignDelivery(role: Role): boolean {
  return isManager(role);
}

/** Bulk-reassign N deliveries to one agent in one shot — the Uzo morning-
 *  queue flow. Tighter than canAssignDelivery: reps don't get this even
 *  though they can reassign one-off via the Edit screen, because the bulk
 *  RPC is operationally a routing decision and we want it to stay on the
 *  ops team that runs daily dispatch.
 *  Server anchor: bulk_assign_deliveries RPC checks is_admin_or_dispatcher(). */
export function canBulkAssignDelivery(role: Role): boolean {
  return role === 'admin' || role === 'dispatcher';
}

/** Team-lead handoff: a lead can move a delivery they own to one of their own
 *  sub-agents. Distinct from `canAssignDelivery` — narrower scope (only sub-agents),
 *  narrower actor (only the lead who currently owns it). Caller must also have
 *  at least one sub-agent for the button to be useful.
 *  Server anchor: reassign_to_sub_agent() RPC. */
export function canHandoffToSubAgent(
  viewer: { role: Role; userId: string },
  currentAssigneeId: string | null | undefined,
  hasSubAgents: boolean,
): boolean {
  if (viewer.role !== 'agent') return false;
  if (!hasSubAgents) return false;
  return currentAssigneeId === viewer.userId;
}

/** Backward (corrective) status transitions on a delivery. Admin-only per PRD §5.9 state machine.
 * Server anchor: enforced by change_delivery_status() function — added in Phase 3. */
export function canCorrectStatus(role: Role): boolean {
  return role === 'admin';
}

/** Forward status updates on a delivery (Update status / Mark delivered).
 *  Admin and dispatcher can update any delivery; an agent can update only
 *  their own assigned row. Rep and warehouse cannot — reps coordinate but
 *  do not make ground-truth status calls.
 *  Server anchor: change_delivery_status() RPC + RLS on deliveries_update_*. */
export function canUpdateStatus(role: Role, isAssignedAgent: boolean): boolean {
  if (role === 'admin' || role === 'dispatcher') return true;
  if (role === 'agent') return isAssignedAgent;
  return false;
}

/** Post a message in an existing delivery thread (any reply, agent or ops).
 *  Server anchor: reply_to_delivery() RPC accepts assigned agent OR ops. */
export function canPostOnThread(role: Role, isAssignedAgent: boolean): boolean {
  if (isOps(role)) return true;
  if (role === 'agent') return isAssignedAgent;
  return false;
}

/** Seed an EMPTY delivery thread with a free-text message. Ops-only — agents
 *  start threads through the structured FlagDeliverySheet (chip + status),
 *  not the plain composer. Server anchor: reply_to_delivery() RPC. */
export function canSeedThread(role: Role): boolean {
  return isOps(role);
}

/** Soft-delete a delivery. Managers (admin + dispatcher) per Uzo
 *  (2026-06-17) — dispatchers send their own orders and need to delete a
 *  mistaken one without routing through an admin. Reps stay excluded: like
 *  every other order-mutation (edit, assign, unassign), delete is a manager
 *  job, not part of the rep coordination surface.
 *  Server anchor: `delete_delivery` RPC gates on is_manager()
 *  (scripts/delete-deliveries.sql). */
export function canDeleteDelivery(role: Role): boolean {
  return isManager(role);
}

/** Bulk soft-delete N deliveries in one shot. Admin-only — kept tighter than
 *  single delete (which is now manager-wide, see canDeleteDelivery): deleting
 *  many rows at once is a clean-up/maintenance action, not the everyday
 *  "I mis-sent one order" fix dispatchers need. Dispatchers delete one at a
 *  time from the detail screen; bulk stays an admin tool.
 *  Server anchor: `bulk_delete_deliveries` RPC gates on is_admin(). */
export function canBulkDeleteDeliveries(role: Role): boolean {
  return role === 'admin';
}

/** Bulk status-change N deliveries. Admin + dispatcher (mirrors
 *  bulk_assign_deliveries — the bulk wrapper iterates change_delivery_status,
 *  so the per-row state-machine validation already enforces requires_admin
 *  per transition).
 *  Server anchor: `bulk_change_delivery_status` RPC. */
export function canBulkChangeStatus(role: Role): boolean {
  return role === 'admin' || role === 'dispatcher';
}

/** Bulk "Mark delivered" from the agent's Today screen — long-press to
 *  multi-select, then mark several delivered at once. Agent-only: it marks
 *  the caller's OWN assigned rows, and each enqueued change_delivery_status
 *  job re-checks ownership server-side. Ops keep single-row + their existing
 *  bulk-status tools; bulk delivered is an in-the-field agent action.
 *  No new server RPC — reuses change_delivery_status per row via the queue. */
export function canBulkMarkDelivered(role: Role): boolean {
  return role === 'agent';
}

/** A row can be bulk-marked-delivered only if it isn't already terminal AND
 *  has a location (change_delivery_status raises on delivered with no
 *  location_id). Mirrors the per-row guards so the bulk sheet can preview
 *  which selections will be skipped instead of silently failing in the queue. */
export function canBulkDeliverRow(row: {
  current_status: string | null;
  location_id: string | null;
}): boolean {
  if (row.location_id == null) return false;
  // Non-terminal only: 'active' or 'soft' bucket. 'done'/'closed' rows are
  // already finished and have no valid transition to 'delivered'.
  const bucket = statusBucket(row.current_status);
  return bucket === 'active' || bucket === 'soft';
}

/** UI gate that mirrors the FINAL_STATUSES check inside `delete_delivery` /
 *  `bulk_delete_deliveries`. Lets us hide the trash button for delivered /
 *  rolled_over rows instead of opening a sheet that the RPC would reject.
 *  Reads from theme.FINAL_STATUSES so adding a new final status only needs
 *  one edit. The SQL inlines the same list — keep them in sync. */
export function canDeleteDeliveryByStatus(currentStatus: string | null): boolean {
  if (!currentStatus) return true;
  return !FINAL_STATUSES.has(currentStatus);
}

/** Pre-delivery statuses where the row's customer-facing fields can still be
 *  edited. Derived from STATUS_GROUPS so adding a new soft or active status
 *  only needs a single edit in theme.ts. The server-side `update_delivery_fields`
 *  RPC inlines the same list — keep them in sync.
 *  (scripts/review-reconcile-and-edit.sql, mirrors STATUS_GROUPS.active + .soft) */
const PRE_DELIVERY_STATUSES = new Set<string>([...STATUS_GROUPS.active, ...STATUS_GROUPS.soft]);

/** Edit customer-facing fields on an existing delivery (name, phone, address,
 *  product, quantity, customer price, location, assigned agent). Operational
 *  managers (admin + dispatcher), pre-delivery statuses only. Reps excluded
 *  per Uzo (2026-06-10) — order editing is a manager job.
 *  Server anchor: `update_delivery_fields` RPC gates on is_manager(). */
export function canEditDelivery(role: Role, currentStatus: string | null): boolean {
  if (!isManager(role)) return false;
  return PRE_DELIVERY_STATUSES.has(currentStatus ?? 'pending');
}

/** Clear `assigned_agent_id` on an existing delivery — moves it back to the
 *  Unassigned bucket. Same role + status gate as `canEditDelivery`: managers
 *  (admin + dispatcher), non-terminal rows only. Reps excluded per Uzo
 *  (2026-06-10) along with the rest of order editing. Server also raises on
 *  already-unassigned rows; the UI hides the button when `assigned_agent_id is
 *  null` so the RPC is never reached for that case.
 *  Server anchor: `unassign_delivery` RPC checks is_manager() and
 *  delivery_status_defs.category <> 'terminal'. */
export function canUnassignDelivery(role: Role, currentStatus: string | null): boolean {
  if (!isManager(role)) return false;
  return PRE_DELIVERY_STATUSES.has(currentStatus ?? 'pending');
}

/** Clear `location_id` on a non-terminal delivery — closes the "can't blank
 *  location once it's set" gap left by update_delivery_fields' coalesce
 *  contract (see scripts/clear-delivery-location.sql header). Same role +
 *  status gate as canUnassignDelivery: managers (admin + dispatcher),
 *  non-terminal rows only. Reps excluded per Uzo (2026-06-10). The button is
 *  also hidden when the row's location_id is already null (the RPC would
 *  raise) — callers should pass the live row's location_id and short-circuit
 *  at the UI level. Server anchor: `clear_delivery_location` RPC gates on
 *  is_manager(). */
export function canClearDeliveryLocation(
  role: Role,
  currentStatus: string | null,
  locationId: string | null,
): boolean {
  if (!isManager(role)) return false;
  if (locationId == null) return false;
  return PRE_DELIVERY_STATUSES.has(currentStatus ?? 'pending');
}

/** Correct the `location_id` on an already-DELIVERED row — re-snapshots
 *  charged_snapshot + agent_payment_snapshot from the new location's rate.
 *  Admin only (it mutates frozen money on a closed row, so it sits tighter
 *  than the ops-wide edit gate) and `delivered` only (pre-delivery rows use
 *  the normal Edit screen; other terminal states don't feed reconciliation).
 *  Server anchor: `correct_delivery_location` RPC checks is_admin() and
 *  current_status = 'delivered'. */
export function canCorrectDeliveryLocation(role: Role, currentStatus: string | null): boolean {
  return role === 'admin' && currentStatus === 'delivered';
}

/** Revert a wrongly-`delivered` row back to `pending`. Admin + dispatcher
 *  (widened 2026-06-08 — dispatcher is the manager and Uzo asked that it
 *  not bottleneck on him alone). Rep deliberately excluded because this
 *  mutates frozen money on a closed row that fed reconciliation; reps are
 *  the vendor-coordination layer, not the dispatch decision-maker.
 *  `delivered` only — other terminal states (cancelled, failed_delivery,
 *  rolled_over) don't have the same fat-finger recovery story and are out
 *  of scope for this RPC. Server anchor: `revert_delivery_to_pending` RPC
 *  inline-checks role IN ('admin','dispatcher') and current_status='delivered'. */
export function canRevertDelivered(role: Role, currentStatus: string | null): boolean {
  return (role === 'admin' || role === 'dispatcher') && currentStatus === 'delivered';
}

/** See AND resolve (fix-and-create or discard) the needs_review bot inbound
 *  queue. Managers only (admin + dispatcher) per Uzo (2026-06-10) — reps no
 *  longer get the Review tab at all. Also gates the Review-tab visibility in
 *  OpsTabsLayout and the needs-review reads on the dashboards.
 *  Server anchor: `resolve_inbound_to_delivery` / `discard_inbound` RPCs gate
 *  on is_manager(); bot_inbound_select_admin_dispatcher policy tightened to
 *  is_manager() so reps can't even read the queue. */
export function canResolveReview(role: Role): boolean {
  return isManager(role);
}

/** Can this user claim the customer follow-up on this delivery? Operational
 *  set (admin + dispatcher + rep) AND a status flagged `needs_followup` in
 *  `delivery_status_defs` (read off the live row, not a hardcoded list — the
 *  inlined-list approach drifted from SQL twice). Caller passes the set of
 *  follow-up statuses derived from a `listStatusDefs()` query; the empty set
 *  (defs not yet loaded) safely returns false so the banner doesn't flash up
 *  with a button that the RPC would reject. Server anchor:
 *  `claim_followup` RPC gates on the same column (scripts/needs-followup-flag.sql). */
export function canClaimFollowup(
  role: Role,
  currentStatus: string | null,
  followupStatuses: ReadonlySet<string>,
): boolean {
  if (!isOps(role)) return false;
  return followupStatuses.has(currentStatus ?? '');
}

/** Can this user tag a status-history row as "client notified on WhatsApp"?
 *  Operational set only — agents don't message clients, they deliver.
 *  Server anchor: `mark_client_notified` RPC + dcn_select_ops_or_self_agent
 *  policy (scripts/client-notified-tag.sql). */
export function canMarkClientNotified(role: Role): boolean {
  return isOps(role);
}
