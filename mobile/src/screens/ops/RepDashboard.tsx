// Rep home dashboard. Mirrors the dispatcher dashboard (OpsDashboard)
// but adds the shared Recent-activity list so reps can see today's
// delivery updates at a glance — their job is delivery success, not
// agent coordination, so this list is the most useful surface to lead
// with after the hero and the needs-review CTA.
//
// Kept as a separate file from OpsDashboard intentionally: no role flag
// inside a shared component. If rep and dispatcher diverge further the
// two files evolve independently; if they converge again we extract more
// shared building blocks then.
import { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, siblingGroupKey, type DeliveryRow } from '@/services/deliveries';
import { listUsers } from '@/services/users';
import { listBotInbound } from '@/services/bot';
import { AppBar, Card, Icon } from '@/components/ui';
import { AgentWorkloadCard } from '@/components/delivery/AgentWorkloadCard';
import { RecentActivityCard } from '@/components/delivery/RecentActivityCard';
import { colors, fonts, statusBucket } from '@/lib/theme';

const REP_BASE = '/(rep)' as const;

function shortDate(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function RepDashboard() {
  const user = useCurrentUser();
  const router = useRouter();
  const deliveriesQ = useAsync(() => listDeliveries(user.role), [user.role]);
  const usersQ = useAsync(() => listUsers(), []);
  const reviewQ = useAsync(() => listBotInbound('needs_review', 100), []);

  useFocusEffect(
    useCallback(() => {
      deliveriesQ.reload();
      reviewQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const deliveries = useMemo(() => deliveriesQ.data ?? [], [deliveriesQ.data]);
  const agents = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.role === 'agent' && u.is_active),
    [usersQ.data],
  );

  const stats = useMemo(() => bucketCounts(deliveries), [deliveries]);
  const reviewCount = (reviewQ.data ?? []).length;
  const unassignedCount = deliveries.filter((d) => !d.assigned_agent_id).length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Operations"
        subtitle={`${shortDate()} · ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} active`}
        right={<Icon name="bell" size={20} color={colors.black} />}
      />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 96, gap: 12 }}>
        {/* Big number — unique customer orders today, sibling-collapsed */}
        <Card>
          <Text style={kicker}>Today</Text>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 32,
              color: colors.black,
              letterSpacing: -0.8,
              marginTop: 4,
            }}
          >
            {stats.total}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {stats.total === 1 ? 'order' : 'orders'}
          </Text>

          <View
            style={{
              marginTop: 14,
              flexDirection: 'row',
              height: 8,
              borderRadius: 4,
              overflow: 'hidden',
              backgroundColor: colors.surface,
            }}
          >
            {[
              { c: colors.red, v: stats.active },
              { c: colors.warning, v: stats.soft },
              { c: colors.success, v: stats.done },
              { c: colors.closed, v: stats.closed },
            ].map((s, i) => (
              <View key={i} style={{ backgroundColor: s.c, flex: s.v || 0.001 }} />
            ))}
          </View>
          <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            <Legend label="Active" n={stats.active} color={colors.red} />
            <Legend label="Soft fail" n={stats.soft} color={colors.warning} />
            <Legend label="Delivered" n={stats.done} color={colors.success} />
            <Legend label="Closed" n={stats.closed} color={colors.closed} />
          </View>
        </Card>

        {/* Needs review (black CTA) */}
        {reviewCount > 0 || unassignedCount > 0 ? (
          <Card
            style={{ backgroundColor: colors.black }}
            onPress={() => router.push(`${REP_BASE}/review`)}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: 11,
                    color: colors.textTertiary,
                    letterSpacing: 0.8,
                    textTransform: 'uppercase',
                  }}
                >
                  Needs review
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.extrabold,
                    fontSize: 24,
                    color: colors.white,
                    letterSpacing: -0.4,
                    marginTop: 4,
                  }}
                >
                  {reviewCount + unassignedCount}{' '}
                  {reviewCount + unassignedCount === 1 ? 'item' : 'items'}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textTertiary,
                    marginTop: 4,
                  }}
                >
                  {reviewCount} unmatched · {unassignedCount} unassigned
                </Text>
              </View>
              <View
                style={{
                  backgroundColor: colors.red,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="chevronRight" size={22} color={colors.white} />
              </View>
            </View>
          </Card>
        ) : null}

        {/* Recent activity — shared with admin */}
        <RecentActivityCard rows={deliveries} loading={deliveriesQ.loading} basePath={REP_BASE} />

        {/* Agent workload — shared with admin */}
        <AgentWorkloadCard
          deliveries={deliveries}
          agents={agents}
          loading={deliveriesQ.loading && !deliveriesQ.data}
          basePath={REP_BASE}
        />
      </ScrollView>
    </View>
  );
}

function Legend({ label, n, color }: { label: string; n: number; color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: colors.black }}>{n}</Text>
    </View>
  );
}

function bucketCounts(rows: DeliveryRow[]): {
  active: number;
  soft: number;
  done: number;
  closed: number;
  total: number;
} {
  const groups = new Map<string, DeliveryRow[]>();
  for (const r of rows) {
    const key = siblingGroupKey(r);
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r);
  }

  let active = 0,
    soft = 0,
    done = 0,
    closed = 0;
  for (const group of groups.values()) {
    if (group.some((d) => d.current_status === 'delivered')) {
      done++;
      continue;
    }
    const buckets = group.map((d) => statusBucket(d.current_status));
    if (buckets.some((b) => b === 'active')) {
      active++;
      continue;
    }
    if (buckets.some((b) => b === 'soft')) {
      soft++;
      continue;
    }
    closed++;
  }
  return { active, soft, done, closed, total: groups.size };
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
