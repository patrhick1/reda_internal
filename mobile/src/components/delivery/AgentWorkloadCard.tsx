import { useMemo } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Avatar, Card, SectionHeader } from '@/components/ui';
import type { DeliveryRow } from '@/services/deliveries';
import type { AppUser } from '@/services/users';
import { colors, fonts } from '@/lib/theme';

type AgentRow = {
  agent: AppUser;
  total: number;
  done: number;
  // Counted separately: `pending` is truly awaiting action; `available` is
  // customer-confirmed-reachable (available + available_evening). Lumping them
  // read as misleadingly high "pending".
  pending: number;
  available: number;
  pct: number;
};

/** "3/9 delivered · 2 available · 1 pending", dropping zero segments. */
function workloadSummary(done: number, total: number, available: number, pending: number): string {
  const parts = [`${done}/${total} delivered`];
  if (available > 0) parts.push(`${available} available`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(' · ');
}

export function AgentWorkloadCard({
  deliveries,
  agents,
  loading,
  onAgentPress,
}: {
  deliveries: DeliveryRow[];
  agents: AppUser[];
  loading: boolean;
  /** When provided, each agent row becomes tappable and calls this with the
   *  agent's id — callers route to their own deliveries list narrowed to that
   *  agent (?agent=). Omitted (e.g. a future read-only context) → rows are
   *  static, no Pressable wrapper. */
  onAgentPress?: (agentId: string) => void;
}) {
  // Busiest agents float to the top so the zero-workload rows don't push
  // the actionable ones below the fold. Alphabetical tiebreaker keeps the
  // order stable when totals match.
  const rows: AgentRow[] = useMemo(() => {
    // Single pass over deliveries → per-agent tallies, instead of re-scanning
    // the full list (and allocating sub-arrays) once per agent. O(A+D) not O(A×D).
    type Tally = { total: number; done: number; pending: number; available: number };
    const tally = new Map<string, Tally>();
    for (const d of deliveries) {
      const id = d.assigned_agent_id;
      if (!id) continue;
      let t = tally.get(id);
      if (!t) {
        t = { total: 0, done: 0, pending: 0, available: 0 };
        tally.set(id, t);
      }
      t.total++;
      const s = d.current_status;
      if (s === 'delivered') t.done++;
      else if (s === 'pending') t.pending++;
      else if (s === 'available' || s === 'available_evening') t.available++;
    }
    const out = agents.map((a) => {
      const t = tally.get(a.id) ?? { total: 0, done: 0, pending: 0, available: 0 };
      const pct = t.total > 0 ? Math.round((t.done / t.total) * 100) : 0;
      return {
        agent: a,
        total: t.total,
        done: t.done,
        pending: t.pending,
        available: t.available,
        pct,
      };
    });
    out.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (a.agent.display_name ?? '').localeCompare(b.agent.display_name ?? '');
    });
    return out;
  }, [agents, deliveries]);

  return (
    <>
      <SectionHeader>Agent workload</SectionHeader>
      {loading && agents.length === 0 ? (
        <ActivityIndicator color={colors.black} />
      ) : agents.length === 0 ? (
        <Card>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              textAlign: 'center',
              paddingVertical: 8,
            }}
          >
            No active agents yet.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 8 }}>
          {rows.map(({ agent, total, done, pending, available, pct }) => (
            <Card
              key={agent.id}
              dense
              onPress={onAgentPress ? () => onAgentPress(agent.id) : undefined}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Avatar user={agent} size={40} />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
                    numberOfLines={1}
                  >
                    {agent.display_name}
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    {workloadSummary(done, total, available, pending)}
                  </Text>
                  <View
                    style={{
                      marginTop: 6,
                      height: 4,
                      backgroundColor: colors.surface,
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        height: '100%',
                        width: `${pct}%`,
                        backgroundColor: colors.success,
                      }}
                    />
                  </View>
                </View>
                <Text
                  style={{
                    fontFamily: fonts.extrabold,
                    fontSize: 18,
                    color: colors.black,
                    letterSpacing: -0.4,
                  }}
                >
                  {pct}%
                </Text>
              </View>
            </Card>
          ))}
        </View>
      )}
    </>
  );
}
