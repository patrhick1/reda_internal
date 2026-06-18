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
}: {
  deliveries: DeliveryRow[];
  agents: AppUser[];
  loading: boolean;
}) {
  // Busiest agents float to the top so the zero-workload rows don't push
  // the actionable ones below the fold. Alphabetical tiebreaker keeps the
  // order stable when totals match.
  const rows: AgentRow[] = useMemo(() => {
    const out = agents.map((a) => {
      const aDels = deliveries.filter((d) => d.assigned_agent_id === a.id);
      const done = aDels.filter((d) => d.current_status === 'delivered').length;
      const pending = aDels.filter((d) => d.current_status === 'pending').length;
      const available = aDels.filter((d) =>
        ['available', 'available_evening'].includes(d.current_status ?? ''),
      ).length;
      const total = aDels.length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return { agent: a, total, done, pending, available, pct };
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
            <Card key={agent.id} dense>
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
