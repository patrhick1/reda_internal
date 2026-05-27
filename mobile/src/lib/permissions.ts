// Permission helpers. Each one mirrors a server-side RLS check or column lock.
// The 1:1 mapping is the whole point — if a helper says "yes" but the server says "no",
// the UI shows a button that fails. If the server says "yes" but the helper says "no",
// the UI hides a button users could legitimately use.
//
// Anchor (database): supabase/dashboard → is_admin(), is_admin_or_dispatcher(), public.users.role check.
// Anchor (column lock): SELECT on deliveries.charged_snapshot is revoked from authenticated.

import { STATUS_GROUPS } from '@/lib/theme';

export type Role = 'admin' | 'dispatcher' | 'agent' | 'warehouse' | 'rep';

const ROLES: readonly Role[] = ['admin', 'dispatcher', 'agent', 'warehouse', 'rep'] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

// Operational-coordinator roles. Mirrors the server-side body of
// public.is_admin_or_dispatcher() — admin, dispatcher, and rep all
// share dispatcher-level operational permissions. `rep` is the
// stock-less dispatcher variant: same here in the UI, gated to drop
// stock screens via the (rep) route group + admin-only canAdjustStock.
const OPS_ROLES: ReadonlySet<Role> = new Set(['admin', 'dispatcher', 'rep']);
const isOps = (role: Role): boolean => OPS_ROLES.has(role);

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

/** Adjust stock (any of 9 reasons). Admin-only.
 * Server anchor: stock_adj_all_admin policy. */
export function canAdjustStock(role: Role): boolean {
  return role === 'admin';
}

/** Create a delivery. Operational set (admin + dispatcher + rep).
 * Server anchor: deliveries_insert_admin_dispatcher policy → is_admin_or_dispatcher(). */
export function canCreateDelivery(role: Role): boolean {
  return isOps(role);
}

/** Assign/reassign delivery to an agent. Operational set.
 * Server anchor: deliveries_update_own_or_admin (agent can update own, ops roles can reassign). */
export function canAssignDelivery(role: Role): boolean {
  return isOps(role);
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

/** Soft-delete a delivery. Admin-only.
 * Server anchor: deliveries_delete_admin policy. */
export function canDeleteDelivery(role: Role): boolean {
  return role === 'admin';
}

/** Pre-delivery statuses where the row's customer-facing fields can still be
 *  edited. Derived from STATUS_GROUPS so adding a new soft or active status
 *  only needs a single edit in theme.ts. The server-side `update_delivery_fields`
 *  RPC inlines the same list — keep them in sync.
 *  (scripts/review-reconcile-and-edit.sql, mirrors STATUS_GROUPS.active + .soft) */
const PRE_DELIVERY_STATUSES = new Set<string>([...STATUS_GROUPS.active, ...STATUS_GROUPS.soft]);

/** Edit customer-facing fields on an existing delivery (name, phone, address,
 *  product, quantity, customer price, location, assigned agent). Operational
 *  set (admin + dispatcher + rep), pre-delivery statuses only.
 *  Server anchor: `update_delivery_fields` RPC enforces both. */
export function canEditDelivery(role: Role, currentStatus: string | null): boolean {
  if (!isOps(role)) return false;
  return PRE_DELIVERY_STATUSES.has(currentStatus ?? 'pending');
}

/** Resolve (fix-and-create or discard) a needs_review bot inbound row.
 *  Operational set.
 *  Server anchor: `resolve_inbound_to_delivery` / `discard_inbound` RPCs. */
export function canResolveReview(role: Role): boolean {
  return isOps(role);
}

/** Soft statuses where one admin/dispatcher can claim the customer follow-up
 *  so peers know to stand down. Derived from STATUS_GROUPS.soft so any future
 *  soft status auto-participates here. Server-side `claim_followup` RPC
 *  inlines the same list (scripts/delivery-followups.sql) — keep them aligned. */
const FOLLOWUP_STATUSES = new Set<string>(STATUS_GROUPS.soft);

/** Can this user claim the customer follow-up on this delivery? Operational
 *  set (admin + dispatcher + rep), soft statuses only. UI gate; server
 *  `claim_followup` RPC is the security anchor. */
export function canClaimFollowup(role: Role, currentStatus: string | null): boolean {
  if (!isOps(role)) return false;
  return FOLLOWUP_STATUSES.has(currentStatus ?? '');
}

/** Can this user tag a status-history row as "client notified on WhatsApp"?
 *  Operational set only — agents don't message clients, they deliver.
 *  Server anchor: `mark_client_notified` RPC + dcn_select_ops_or_self_agent
 *  policy (scripts/client-notified-tag.sql). */
export function canMarkClientNotified(role: Role): boolean {
  return isOps(role);
}
