import { rpcUntyped } from '@/lib/supabase';

/** One row of the customer blacklist, as returned by list_customer_blacklist.
 *  `blocked_count` is how many bot orders this entry has refused (counted from
 *  the inbound messages filed as `blocked` against it). */
export type BlacklistEntry = {
  id: string;
  phone_normalized: string;
  phone_display: string;
  reason: string;
  source_delivery_id: string | null;
  added_by: string;
  added_by_name: string | null;
  added_at: string;
  removed_by: string | null;
  removed_by_name: string | null;
  removed_at: string | null;
  removal_note: string | null;
  blocked_count: number;
  last_blocked_at: string | null;
};

/** The active entry a number (or its alternate) matched, from
 *  check_customer_blacklist. Null from the RPC means the number is clean. */
export type BlacklistHit = {
  id: string;
  phone_display: string;
  reason: string;
  added_at: string;
  added_by_name: string | null;
  source_delivery_id: string | null;
  matched_on: 'phone' | 'alt';
};

export type AddBlacklistResult = {
  id: string;
  phone_display: string;
  phone_normalized: string;
  reason: string;
  added_at: string;
  /** True when the number was already listed — the existing entry is returned
   *  rather than a twin. */
  already_listed: boolean;
  /** Non-terminal deliveries that still carry this number. Nothing is closed
   *  automatically; ops decide. */
  open_orders: number;
};

/** Ops: the blacklist, newest first. Server gate: is_admin_or_dispatcher(). */
export async function listCustomerBlacklist(
  opts: { includeRemoved?: boolean } = {},
): Promise<BlacklistEntry[]> {
  const { data, error } = await rpcUntyped<BlacklistEntry[]>('list_customer_blacklist', {
    p_include_removed: !!opts.includeRemoved,
  });
  if (error) throw error;
  return data ?? [];
}

/** Managers: list a number in any format (+234…, 0…, bare digits). Server
 *  gate: is_manager(). Idempotent on an already-listed number. */
export async function addCustomerBlacklist(input: {
  phone: string;
  reason: string;
  sourceDeliveryId?: string | null;
}): Promise<AddBlacklistResult> {
  const { data, error } = await rpcUntyped<AddBlacklistResult>('add_customer_blacklist', {
    p_phone: input.phone,
    p_reason: input.reason,
    p_source_delivery_id: input.sourceDeliveryId ?? null,
  });
  if (error) throw error;
  if (!data) throw new Error('No response from the server. Try again.');
  return data;
}

/** Managers: close an entry. The row stays as history; add + remove are both
 *  in the audit log. Server gate: is_manager(). */
export async function removeCustomerBlacklist(id: string, note: string | null): Promise<void> {
  const { error } = await rpcUntyped<null>('remove_customer_blacklist', {
    p_id: id,
    p_note: note,
  });
  if (error) throw error;
}

/** Ops: is this number (or its alternate) listed? Null when clean. Powers the
 *  inline warning on the delivery form and the marker on a delivery. The
 *  server refuses a listed number on save regardless of this check. */
export async function checkCustomerBlacklist(
  phone: string,
  phoneAlt?: string | null,
): Promise<BlacklistHit | null> {
  const { data, error } = await rpcUntyped<BlacklistHit | null>('check_customer_blacklist', {
    p_phone: phone,
    p_phone_alt: phoneAlt ?? null,
  });
  if (error) throw error;
  return data ?? null;
}
