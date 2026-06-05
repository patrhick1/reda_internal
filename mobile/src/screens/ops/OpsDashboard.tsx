// Dispatcher home dashboard. The rep home is RepDashboard (separate file)
// because reps also surface a Recent-activity list; dispatchers don't.
import { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, siblingGroupKey, type DeliveryRow } from '@/services/deliveries';
import { listBotInbound } from '@/services/bot';
import { listAvailableOrders } from '@/services/available-orders';
import { listOpenIssuesForOps } from '@/services/delivery-messages';
import { AppBar, Card, FAB, Icon } from '@/components/ui';
import { IssuesAttentionBlock } from '@/components/delivery/IssuesAttentionBlock';
import { colors, fonts, statusBucket } from '@/lib/theme';

type OpsBasePath = '/(dispatcher)';

function shortDate(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function OpsDashboard({ basePath }: { basePath: OpsBasePath }) {
  const user = useCurrentUser();
  const router = useRouter();
  const deliveriesQ = useAsync(() => listDeliveries(user.role), [user.role]);
  const reviewQ = useAsync(() => listBotInbound('needs_review', 100), []);
  const availableQ = useAsync(() => listAvailableOrders(), []);
  // Actionable agent-flagged issues — wrong_address / payment_dispute /
  // product_issue / other. Auto-seeded cant_reach_client threads are filtered
  // out server-side so this card doesn't double up with the soft-fail count.
  const issuesQ = useAsync(() => listOpenIssuesForOps(), []);

  useFocusEffect(
    useCallback(() => {
      deliveriesQ.reload();
      reviewQ.reload();
      availableQ.reload();
      issuesQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const deliveries = useMemo(() => deliveriesQ.data ?? [], [deliveriesQ.data]);
  const stats = useMemo(() => bucketCounts(deliveries), [deliveries]);
  const reviewCount = (reviewQ.data ?? []).length;
  const unassignedCount = deliveries.filter((d) => !d.assigned_agent_id).length;
  const openIssues = issuesQ.data ?? [];
  const availableRows = useMemo(() => availableQ.data ?? [], [availableQ.data]);
  const availableAgents = useMemo(
    () => new Set(availableRows.map((r) => r.agent_id)).size,
    [availableRows],
  );
  const availableUnits = useMemo(
    () => availableRows.reduce((sum, r) => sum + r.quantity_ordered, 0),
    [availableRows],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Operations"
        subtitle={shortDate()}
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

          {/* Status bar */}
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

        {/* Open agent-flagged issues — same card admin home shows. Renders
            only when there's something actionable so the dashboard stays
            tight when ops is caught up. */}
        {openIssues.length > 0 ? (
          <IssuesAttentionBlock
            issues={openIssues}
            onOpen={(deliveryId) =>
              router.push({
                pathname: `${basePath}/deliveries/[id]` as `${OpsBasePath}/deliveries/[id]`,
                params: { id: deliveryId },
              })
            }
          />
        ) : null}

        {/* Needs review (black CTA) */}
        {reviewCount > 0 || unassignedCount > 0 ? (
          <Card
            style={{ backgroundColor: colors.black }}
            onPress={() => router.push(`${basePath}/review` as `${OpsBasePath}/review`)}
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

        {/* Available orders — Mary's main work surface. One tap → per-client
            product totals + per-agent breakdown so she can plan stock
            allocation for today. Replaces the agent-workload section Uzo
            said the dispatcher doesn't use. */}
        <Card
          dense
          onPress={() => router.push(`${basePath}/available` as `${OpsBasePath}/available`)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="truck" size={18} color={colors.black} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                Available orders
              </Text>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textSecondary,
                  marginTop: 2,
                }}
              >
                {availableRows.length === 0
                  ? 'Nothing confirmed yet today'
                  : `${availableUnits} ${availableUnits === 1 ? 'unit' : 'units'} across ${availableAgents} ${availableAgents === 1 ? 'agent' : 'agents'}`}
              </Text>
            </View>
            <Icon name="chevronRight" size={20} color={colors.textSecondary} />
          </View>
        </Card>

        {/* Stock shortcut — read-only view of warehouse + agent holdings. */}
        <Card dense onPress={() => router.push(`${basePath}/stock` as `${OpsBasePath}/stock`)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="warehouse" size={18} color={colors.black} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                Stock
              </Text>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textSecondary,
                  marginTop: 2,
                }}
              >
                Warehouse holdings, by agent or by client
              </Text>
            </View>
            <Icon name="chevronRight" size={20} color={colors.textSecondary} />
          </View>
        </Card>
      </ScrollView>

      <FAB
        icon="plus"
        label="Create"
        onPress={() => router.push(`${basePath}/deliveries/new` as `${OpsBasePath}/deliveries/new`)}
      />
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

/** Sibling-collapsed bucket counts. Race-assigned siblings count as one
 *  customer order. Per group outcome (priority): done → active → soft → closed.
 *  total = unique chains scheduled today. */
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
