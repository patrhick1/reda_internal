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
import { listOpenIssuesForOps } from '@/services/delivery-messages';
import { AppBar, Card, Icon } from '@/components/ui';
import { AgentWorkloadCard } from '@/components/delivery/AgentWorkloadCard';
import { IssuesAttentionBlock } from '@/components/delivery/IssuesAttentionBlock';
import { NotifyAttentionBlock } from '@/components/delivery/NotifyAttentionBlock';
import { RecentActivityCard } from '@/components/delivery/RecentActivityCard';
import { awaitsClientNotification, colors, fonts, statusBucket } from '@/lib/theme';

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
  // Actionable agent-flagged issues — same card dispatchers get on OpsDashboard.
  // RLS (is_admin_or_dispatcher) already covers reps, so this is the parity the
  // role was missing: a durable home cue that an agent needs a follow-up.
  const issuesQ = useAsync(() => listOpenIssuesForOps(), []);

  useFocusEffect(
    useCallback(() => {
      deliveriesQ.reload();
      issuesQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const deliveries = useMemo(() => deliveriesQ.data ?? [], [deliveriesQ.data]);
  const agents = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.role === 'agent' && u.is_active),
    [usersQ.data],
  );

  const stats = useMemo(() => bucketCounts(deliveries), [deliveries]);

  // Deliveries whose latest status the client hasn't been told about yet, freshest
  // first — the rep's #1 daily task. Derived from the already-loaded list (no extra
  // fetch); the same predicate backs the deliveries "To notify" filter. Collapsed
  // per customer order (siblingGroupKey, keeping the freshest racing row) so the
  // count matches the sibling-collapsed hero above it and the rep sees one entry
  // per client to message — the list's "To notify" chip stays per-row, like its
  // sibling chips.
  const toNotify = useMemo(() => {
    const freshestByGroup = new Map<string, DeliveryRow>();
    for (const d of deliveries) {
      if (!awaitsClientNotification(d)) continue;
      const key = siblingGroupKey(d);
      const cur = freshestByGroup.get(key);
      if (!cur || (d.latest_changed_at ?? '') > (cur.latest_changed_at ?? '')) {
        freshestByGroup.set(key, d);
      }
    }
    return [...freshestByGroup.values()].sort((a, b) =>
      (b.latest_changed_at ?? '').localeCompare(a.latest_changed_at ?? ''),
    );
  }, [deliveries]);

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

        {/* Awaiting client notification — the rep's #1 task: new statuses to relay
            to the client. Renders only when there's something to notify so the home
            stays tight when the queue is clear. "View all" deep-links the deliveries
            list to its matching "To notify" filter. */}
        {toNotify.length > 0 ? (
          <NotifyAttentionBlock
            rows={toNotify}
            onOpen={(deliveryId) =>
              router.push({
                pathname: `${REP_BASE}/deliveries/[id]` as `/(rep)/deliveries/[id]`,
                params: { id: deliveryId },
              })
            }
            onViewAll={() =>
              router.push({
                pathname: `${REP_BASE}/deliveries` as `/(rep)/deliveries`,
                params: { filter: 'to_notify' },
              })
            }
          />
        ) : null}

        {/* Open agent-flagged issues — same card the dispatcher dashboard shows.
            Renders only when there's something actionable so the home stays
            tight when the queue is clear. */}
        {(issuesQ.data ?? []).length > 0 ? (
          <IssuesAttentionBlock
            issues={issuesQ.data ?? []}
            onOpen={(deliveryId) =>
              router.push({
                pathname: `${REP_BASE}/deliveries/[id]` as `/(rep)/deliveries/[id]`,
                params: { id: deliveryId },
              })
            }
          />
        ) : null}

        {/* Recent activity — shared with admin */}
        <RecentActivityCard rows={deliveries} loading={deliveriesQ.loading} basePath={REP_BASE} />

        {/* Agent workload — shared with admin */}
        <AgentWorkloadCard
          deliveries={deliveries}
          agents={agents}
          loading={deliveriesQ.loading && !deliveriesQ.data}
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
