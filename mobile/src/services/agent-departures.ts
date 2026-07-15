// "Left the warehouse" — per-agent, per-day departure signal.
//
// Reads go straight to the `agent_departures` table (RLS gates visibility: ops
// see every agent, an agent sees only their own row). Writes go through the
// `set_left_warehouse` RPC (SECURITY DEFINER — enforces self/ops permission and
// audits). Neither the table nor the RPC is in database.gen.ts yet, so the
// PostgREST/rpc handles are cast, exactly like services/available-orders.ts.
import { rpcUntyped, supabase } from '@/lib/supabase';
import { todayLagos } from '@/lib/date';

type PgReadResult = { data: unknown; error: { message: string } | null };
type PgFilter = {
  eq: (col: string, val: string) => PgFilter;
  maybeSingle: () => Promise<PgReadResult>;
} & Promise<PgReadResult>;
type UntypedFrom = { from: (table: string) => { select: (cols: string) => PgFilter } };

/** All agents who have left the warehouse TODAY (Lagos), keyed agent_id →
 *  departed_at (ISO). Ops-facing: RLS returns every agent for admin/dispatcher/
 *  rep/warehouse, and only the caller's own row for an agent. */
export async function listDeparturesToday(): Promise<Map<string, string>> {
  const { data, error } = await (supabase as unknown as UntypedFrom)
    .from('agent_departures')
    .select('agent_id, departed_at')
    .eq('depart_date', todayLagos());
  if (error) throw error;
  const rows = (data ?? []) as Array<{ agent_id: string | null; departed_at: string | null }>;
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.agent_id && r.departed_at) map.set(r.agent_id, r.departed_at);
  }
  return map;
}

/** The caller-agent's own departure time for today, or null if still at the
 *  warehouse. Drives the agent's Today-screen "I've left" control. */
export async function getMyDepartureToday(agentId: string): Promise<string | null> {
  const { data, error } = await (supabase as unknown as UntypedFrom)
    .from('agent_departures')
    .select('departed_at')
    .eq('agent_id', agentId)
    .eq('depart_date', todayLagos())
    .maybeSingle();
  if (error) throw error;
  return (data as { departed_at: string | null } | null)?.departed_at ?? null;
}

/** Toggle today's departure. `left=true` marks departed (idempotent), `false`
 *  undoes it. Omit `agentId` for an agent marking themselves; ops pass an
 *  agentId to mark a rider on their behalf. Server enforces the permission. */
export async function setLeftWarehouse(left: boolean, agentId?: string): Promise<void> {
  const { error } = await rpcUntyped('set_left_warehouse', {
    p_left: left,
    p_agent_id: agentId ?? null,
  });
  if (error) throw error;
}
