import { supabase } from '@/lib/supabase';

export type FollowupClaim = {
  heldBy:     string;
  holderName: string;
  claimedAt:  string;
  isSelf:     boolean;
};

/** Claims (or refreshes) the follow-up on a soft-status delivery for the
 *  caller. If someone else already holds it and `takeover` is false, the
 *  returned row describes the current holder and `isSelf=false`. Pass
 *  `takeover=true` to forcibly claim it (server writes an audit row). */
export async function claimFollowup(
  deliveryId: string,
  takeover = false,
): Promise<FollowupClaim> {
  const { data, error } = await supabase.rpc('claim_followup', {
    p_delivery_id: deliveryId,
    p_takeover:    takeover,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('claim_followup returned no row');
  return {
    heldBy:     row.held_by    as string,
    holderName: row.holder_name as string,
    claimedAt:  row.claimed_at  as string,
    isSelf:     row.is_self     as boolean,
  };
}

/** Releases the claim if the caller holds it. No-op otherwise. */
export async function releaseFollowup(deliveryId: string): Promise<void> {
  const { error } = await supabase.rpc('release_followup', {
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
}

export type ActiveFollowup = {
  delivery_id: string;
  user_id:     string;
  holder_name: string;
  claimed_at:  string;
};

/** Lists every currently-claimed follow-up. The detail screen uses this for
 *  a single row by filtering client-side; the deliveries list page uses it
 *  to attach a small claimer avatar to each soft-status row. One query, no
 *  pagination — the trigger keeps the table tight (auto-release on status
 *  change). */
export async function listActiveFollowups(): Promise<ActiveFollowup[]> {
  const { data, error } = await supabase
    .from('delivery_followups')
    .select('delivery_id, user_id, claimed_at, users!inner(id, display_name)');
  if (error) throw error;
  return (data ?? []).map((row) => ({
    delivery_id: row.delivery_id,
    user_id:     row.user_id,
    holder_name: row.users.display_name,
    claimed_at:  row.claimed_at,
  }));
}

/** Fetches the active claim for one delivery, or null if no one's claimed
 *  it. Used by the FollowupClaimBanner on the delivery detail screen. */
export async function getFollowup(deliveryId: string): Promise<ActiveFollowup | null> {
  const { data, error } = await supabase
    .from('delivery_followups')
    .select('delivery_id, user_id, claimed_at, users!inner(id, display_name)')
    .eq('delivery_id', deliveryId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    delivery_id: data.delivery_id,
    user_id:     data.user_id,
    holder_name: data.users.display_name,
    claimed_at:  data.claimed_at,
  };
}
