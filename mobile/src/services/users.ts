import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';
import type { Role } from '@/lib/permissions';

export type AppUser = Database['public']['Tables']['users']['Row'] & {
  role: Role;
  /** Lands in the generated Row after scripts/warehouse-staff.sql + gen:types;
   *  the intersection keeps it typed before regeneration. For role='warehouse':
   *  NULL = this user IS a place (stock holder); set = staff acting on that place. */
  warehouse_id: string | null;
};

/** A warehouse PLACE = a warehouse-role user that holds stock (no link).
 *  Warehouse staff (warehouse_id set) act on a place but are never holders, so
 *  holder lists/sections and destination pickers should restrict to places. */
export function isWarehousePlace(u: AppUser): boolean {
  return u.role === 'warehouse' && (u.warehouse_id ?? null) === null;
}

export type AgentStockRow = {
  product_catalog_id: string;
  product_name: string;
  client_name: string;
  quantity_on_hand: number;
};

export async function listUsers(opts: { includeInactive?: boolean } = {}): Promise<AppUser[]> {
  let query = supabase.from('users').select('*').order('display_name');
  if (!opts.includeInactive) {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as AppUser[];
}

/** Sub-agents that report to `leadId`. Empty list = `leadId` is not a team
 *  lead (or has only inactive sub-agents). Drives the "Hand off to team"
 *  button + sheet on the delivery Detail screen. */
export async function listSubAgents(leadId: string): Promise<AppUser[]> {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('parent_agent_id', leadId)
    .eq('is_active', true)
    .order('display_name');
  if (error) throw error;
  return (data ?? []) as AppUser[];
}

export async function getUser(id: string): Promise<AppUser | null> {
  const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as AppUser) ?? null;
}

/** Stock currently on the agent's hand. Empty array if none.
 * current_stock is a view (no FK relationships supabase-js can embed), so we
 * fetch the stock rows and the product catalog separately and merge. */
export async function getAgentStock(agentId: string): Promise<AgentStockRow[]> {
  const stockRes = await supabase
    .from('current_stock')
    .select('product_catalog_id, quantity_on_hand')
    .eq('agent_id', agentId)
    .gt('quantity_on_hand', 0);
  if (stockRes.error) throw stockRes.error;
  const stock = (stockRes.data ?? []).filter(
    (r): r is { product_catalog_id: string; quantity_on_hand: number } =>
      r.product_catalog_id !== null && r.quantity_on_hand !== null,
  );
  if (stock.length === 0) return [];

  const ids = stock.map((s) => s.product_catalog_id);
  const prodRes = await supabase
    .from('product_catalog')
    .select('id, product_name, clients!inner(name)')
    .in('id', ids);
  if (prodRes.error) throw prodRes.error;

  const byId = new Map(
    (prodRes.data ?? []).map((p) => {
      const row = p as { id: string; product_name: string; clients: { name: string } };
      return [row.id, { product_name: row.product_name, client_name: row.clients.name }];
    }),
  );

  return stock.map((s) => ({
    product_catalog_id: s.product_catalog_id,
    quantity_on_hand: s.quantity_on_hand,
    product_name: byId.get(s.product_catalog_id)?.product_name ?? '(unknown product)',
    client_name: byId.get(s.product_catalog_id)?.client_name ?? '',
  }));
}

export type CreateUserInput = {
  email: string;
  password: string;
  role: Role;
  displayName: string;
  phone: string | null;
  /** Only meaningful when role==='warehouse': the place this staffer acts on.
   *  null/undefined = this warehouse user IS a place (a stock holder). */
  warehouseId?: string | null;
};

export async function createAppUser(input: CreateUserInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_app_user', {
    p_email: input.email,
    p_password: input.password,
    p_role: input.role,
    p_display_name: input.displayName,
    p_phone: input.phone as unknown as string,
    p_warehouse_id: (input.warehouseId ?? null) as unknown as string,
  });
  if (error) throw error;
  return data as string;
}

export type UpdateUserInput = {
  displayName: string;
  role: Role;
  phone: string | null;
  /** Only meaningful when role==='warehouse'. Coalesced server-side (omit to
   *  keep the existing link); a non-warehouse role clears it automatically. */
  warehouseId?: string | null;
};

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('update_user', {
    p_id: id,
    p_display_name: input.displayName,
    p_role: input.role,
    p_phone: input.phone as unknown as string,
    p_reason: reason as unknown as string,
    p_warehouse_id: (input.warehouseId ?? null) as unknown as string,
  });
  if (error) throw error;
}

export async function deactivateUser(
  id: string,
  reason: string,
  stockDisposition: string | null = null,
): Promise<void> {
  const { error } = await supabase.rpc('deactivate_user', {
    p_id: id,
    p_reason: reason,
    p_stock_disposition: stockDisposition as unknown as string,
  });
  if (error) throw error;
}

export async function reactivateUser(id: string): Promise<void> {
  const { error } = await supabase.rpc('reactivate_user', { p_id: id });
  if (error) throw error;
}

/** Agent → zone preferences. Two independent lists per agent:
 *   preferred = zones where auto-assign favours this agent (tier 1)
 *   avoided   = zones where auto-assign deprioritises this agent (tier 3,
 *               still assignable as last-resort)
 *  Empty lists = neutral; auto-assign treats them the same as any agent
 *  who has no rows for that location. */
export type AgentZonePrefs = { preferred: string[]; avoided: string[] };

export async function listAgentLocations(agentId: string): Promise<AgentZonePrefs> {
  const { data, error } = await supabase
    .from('agent_locations')
    .select('location_id, kind')
    .eq('agent_id', agentId);
  if (error) throw error;
  const preferred: string[] = [];
  const avoided: string[] = [];
  for (const r of data ?? []) {
    if (r.kind === 'avoid') avoided.push(r.location_id);
    else preferred.push(r.location_id);
  }
  return { preferred, avoided };
}

export async function setAgentLocations(
  agentId: string,
  preferredIds: string[],
  avoidedIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc('set_agent_locations', {
    p_agent_id: agentId,
    p_preferred_ids: preferredIds,
    p_avoided_ids: avoidedIds,
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Self-service profile + auth
// ---------------------------------------------------------------------------

export type SelfProfileInput = { displayName: string; phone: string | null };

export async function updateSelfProfile(input: SelfProfileInput): Promise<void> {
  const { error } = await supabase.rpc('update_self_profile', {
    p_display_name: input.displayName,
    p_phone: input.phone ?? '',
  });
  if (error) throw error;
}

/** Re-authenticates with the current password (since Supabase doesn't expose
 *  a "verify password" call), then updates to the new password. */
export async function changeMyPassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const email = u.user?.email;
  if (!email) throw new Error('Not signed in');
  const reauth = await supabase.auth.signInWithPassword({ email, password: currentPassword });
  if (reauth.error) throw new Error('Current password is incorrect');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/** Re-authenticates with the current password, then requests an email change.
 *  Supabase emails a confirmation link to the new address; the change isn't
 *  applied until the user clicks the link. After confirmation, the
 *  auth.users → public.users email sync trigger (added 2026-05-26) keeps
 *  public.users.email aligned automatically. */
export async function changeMyEmail(currentPassword: string, newEmail: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const email = u.user?.email;
  if (!email) throw new Error('Not signed in');
  const reauth = await supabase.auth.signInWithPassword({ email, password: currentPassword });
  if (reauth.error) throw new Error('Current password is incorrect');
  const trimmed = newEmail.trim().toLowerCase();
  if (trimmed === email.toLowerCase()) throw new Error('That is already your email');
  const { error } = await supabase.auth.updateUser({ email: trimmed });
  if (error) throw error;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase());
  if (error) throw error;
}
