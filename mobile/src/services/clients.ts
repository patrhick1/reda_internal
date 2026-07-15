import { rpcUntyped, supabase } from '@/lib/supabase';
import { queryClient } from '@/lib/query';
import type { Database } from '@/types/database.gen';

/** Client mutation → refresh cached useClients() consumers (Phase 2). */
function invalidateClients(): void {
  void queryClient.invalidateQueries({ queryKey: ['clients'] });
}
/** (De)activating a client cascades to its products, so refresh those too. */
function invalidateClientsAndProducts(): void {
  invalidateClients();
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: ['products-by-client'] });
}

export type Client = Database['public']['Tables']['clients']['Row'];

export type ClientInput = {
  name: string;
  contactPhone: string | null;
  contactEmail: string | null;
  notes: string | null;
  // null = "leave the existing cap unchanged" (the SQL uses coalesce). To
  // remove an existing cap, callers must use clearClientCeiling — keeps an
  // empty form from silently wiping a configured cap.
  maxChargePerDelivery?: number | null;
  // Per-client EOD policy. When true, customer-unreachable soft-failed
  // deliveries are marked failed_delivery at EOD instead of being rolled
  // forward. Server-side coalesce: passing null leaves the existing value
  // unchanged (parity with maxChargePerDelivery).
  autoCancelSoftFails?: boolean | null;
};

// The generated RPC types treat `text` params as strict `string`, but Postgres
// accepts NULL at runtime. Use this cast at the boundary so call sites can
// pass null cleanly.
type RpcText = string | null;

export type ClientBankInput = {
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
};

/** List clients ordered by name. Excludes inactive by default. */
export async function listClients(opts: { includeInactive?: boolean } = {}): Promise<Client[]> {
  let query = supabase.from('clients').select('*').order('name');
  if (!opts.includeInactive) {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getClient(id: string): Promise<Client | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function createClient(input: ClientInput): Promise<string> {
  const { data, error } = await supabase.rpc('create_client', {
    p_name: input.name,
    p_contact_phone: input.contactPhone as unknown as string,
    p_contact_email: input.contactEmail as unknown as string,
    p_notes: input.notes as unknown as string,
  });
  if (error) throw error;
  invalidateClients();
  return data as string;
}

export async function updateClient(id: string, input: ClientInput, reason: RpcText): Promise<void> {
  const { error } = await supabase.rpc('update_client', {
    p_id: id,
    p_name: input.name,
    p_contact_phone: input.contactPhone as unknown as string,
    p_contact_email: input.contactEmail as unknown as string,
    p_notes: input.notes as unknown as string,
    p_reason: reason as unknown as string,
    p_max_charge_per_delivery: input.maxChargePerDelivery as unknown as number,
    p_auto_cancel_soft_fails: input.autoCancelSoftFails as unknown as boolean,
  });
  if (error) throw error;
  invalidateClients();
}

/** Set (overwrite) a client's bank details for the Moniepoint payout CSV. All
 *  three fields are written together — the edit form submits the full set
 *  pre-filled, so clearing one intentionally nulls it. Admin-only server-side. */
export async function setClientBankDetails(
  id: string,
  input: ClientBankInput,
  reason: RpcText,
): Promise<void> {
  const { error } = await rpcUntyped('set_client_bank_details', {
    p_id: id,
    p_bank_account_name: input.bankAccountName,
    p_bank_account_number: input.bankAccountNumber,
    p_bank_name: input.bankName,
    p_reason: reason,
  });
  if (error) throw error;
  invalidateClients();
}

/** Explicitly remove a client's per-delivery charge cap. Distinct from
 *  passing null on updateClient (which leaves the existing value alone). */
export async function clearClientCeiling(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('clear_client_ceiling', { p_id: id, p_reason: reason });
  if (error) throw error;
  invalidateClients();
}

export async function deactivateClient(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('deactivate_client', { p_id: id, p_reason: reason });
  if (error) throw error;
  invalidateClientsAndProducts();
}

export async function reactivateClient(id: string): Promise<void> {
  const { error } = await supabase.rpc('reactivate_client', { p_id: id });
  if (error) throw error;
  invalidateClientsAndProducts();
}
