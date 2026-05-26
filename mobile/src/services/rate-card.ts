import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database.gen';

export type RateCardRow = Database['public']['Tables']['rate_card']['Row'];

/** Matrix row: one per active location, with the current rate (or nulls if unset). */
export type LocationRate = {
  location_id: string;
  location_name: string;
  charged: number | null;
  agent_payment: number | null;
  effective_from: string | null;
};

/** History row, with the display name of who set it. */
export type RateHistory = RateCardRow & { created_by_name: string | null };

/** One row per active location, joined with current rate (effective_until IS NULL). */
export async function listCurrentRates(): Promise<LocationRate[]> {
  const [locsRes, ratesRes] = await Promise.all([
    supabase.from('locations').select('id, name').eq('is_active', true).order('name'),
    supabase
      .from('rate_card')
      .select('location_id, charged, agent_payment, effective_from')
      .is('effective_until', null),
  ]);
  if (locsRes.error) throw locsRes.error;
  if (ratesRes.error) throw ratesRes.error;

  const rateByLoc = new Map(
    (ratesRes.data ?? []).map((r) => [
      r.location_id,
      { charged: r.charged, agent_payment: r.agent_payment, effective_from: r.effective_from },
    ]),
  );

  return (locsRes.data ?? []).map((l) => {
    const rate = rateByLoc.get(l.id);
    return {
      location_id: l.id,
      location_name: l.name,
      charged: rate?.charged ?? null,
      agent_payment: rate?.agent_payment ?? null,
      effective_from: rate?.effective_from ?? null,
    };
  });
}

/** All historical rate rows for a location, newest first. */
export async function listRateHistory(locationId: string): Promise<RateHistory[]> {
  const { data, error } = await supabase
    .from('rate_card')
    .select('*, created_by:users(display_name)')
    .eq('location_id', locationId)
    .order('effective_from', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const joined = row as RateCardRow & { created_by: { display_name: string } | null };
    return { ...joined, created_by_name: joined.created_by?.display_name ?? null };
  });
}

/** Returns the new rate_card row id (or the existing row id if no change). */
export async function upsertRateCard(
  locationId: string,
  charged: number,
  agentPayment: number,
  reason: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('upsert_rate_card', {
    p_location_id: locationId,
    p_charged: charged,
    p_agent_payment: agentPayment,
    p_reason: reason as unknown as string,
  });
  if (error) throw error;
  return data as string;
}
