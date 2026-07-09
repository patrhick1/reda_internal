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
import {
  listDeliveries,
  listPostponed,
  siblingGroupKey,
  type DeliveryRow,
} from '@/services/deliveries';
import { listUsers } from '@/services/users';
import { listDeparturesToday } from '@/services/agent-departures';
import { listOpenIssuesForOps, opsUnreadAgentCounts } from '@/services/delivery-messages';
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
  // Cross-date postponed slice: postpone moves scheduled_date forward in place, so
  // future-dated postponed orders fall outside the today-scoped deliveries fetch.
  // Pulled separately so they still surface in "To notify" (Uzo, 2026-06-20).
  const postponedQ = useAsync(() => listPostponed(user.role), [user.role]);
  const usersQ = useAsync(() => listUsers(), []);
  // Actionable agent-flagged issues — same card dispatchers get on OpsDashboard,
  // minus 'not my route': that's a reassign-only flag handled by admins/
  // dispatchers, hidden from reps so they can't consume it (not_my_route_admin_only.sql).
  const issuesQ = useAsync(() => listOpenIssuesForOps({ excludeNotMyRoute: true }), []);
  // Unread agent messages keyed by delivery_id (deliberate contact only — see
  // opsUnreadAgentCounts). Read state is team-shared, so this is "unread by the
  // ops team", matching the per-row chip on the deliveries list. 'not my route'
  // excluded for reps to match the issues card above.
  const unreadQ = useAsync(() => opsUnreadAgentCounts({ excludeNotMyRoute: true }), []);
  // Riders who've left the warehouse today — shown as a chip on each agent's
  // workload row so reps know who's in transit before relaying a message.
  const departuresQ = useAsync(() => listDeparturesToday(), []);

  useFocusEffect(
    useCallback(() => {
      deliveriesQ.reload();
      postponedQ.reload();
      issuesQ.reload();
      unreadQ.reload();
      departuresQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const deliveries = useMemo(() => deliveriesQ.data ?? [], [deliveriesQ.data]);
  const agents = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.role === 'agent' && u.is_active),
    [usersQ.data],
  );
  const departures = useMemo(
    () => departuresQ.data ?? new Map<string, string>(),
    [departuresQ.data],
  );

  const stats = useMemo(() => bucketCounts(deliveries), [deliveries]);

  // Deliveries with an unread agent message. Mirrors the deliveries list's
  // "All" pool: today's rows plus the cross-date postponed slice, deduped by id.
  // That keeps this home card's count aligned with the Unread chip it opens.
  const unreadDeliveries = useMemo(() => {
    const map = unreadQ.data;
    if (!map || map.size === 0) return [];
    const seen = new Set<string>();
    const rows: DeliveryRow[] = [];
    for (const d of [...deliveries, ...(postponedQ.data ?? [])]) {
      if (!d.id || seen.has(d.id) || (map.get(d.id) ?? 0) <= 0) continue;
      seen.add(d.id);
      rows.push(d);
    }
    return rows;
  }, [deliveries, postponedQ.data, unreadQ.data]);
  const unreadMsgTotal = useMemo(
    () => unreadDeliveries.reduce((s, d) => s + (unreadQ.data?.get(d.id ?? '') ?? 0), 0),
    [unreadDeliveries, unreadQ.data],
  );

  // Deliveries whose latest status the client hasn't been told about yet, freshest
  // first — the rep's #1 daily task. Built from the loaded today-list PLUS the
  // cross-date postponed slice (one extra query) so future-dated postponed orders
  // still surface here; the same predicate backs the deliveries "To notify" filter.
  // Collapsed per customer order (siblingGroupKey, keeping the freshest racing row) so the
  // count matches the sibling-collapsed hero above it and the rep sees one entry
  // per client to message — the list's "To notify" chip stays per-row, like its
  // sibling chips.
  const toNotify = useMemo(() => {
    const freshestByGroup = new Map<string, DeliveryRow>();
    // Today's rows + the cross-date postponed slice (future-dated postponed orders
    // aren't in `deliveries`). Both gated by awaitsClientNotification; any overlap
    // (today's postponed sits in both) collapses by sibling group below.
    for (const d of [...deliveries, ...(postponedQ.data ?? [])]) {
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
  }, [deliveries, postponedQ.data]);

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

        {/* Unread agent messages — durable cue that an agent has replied on a
            delivery thread. Renders only when there's something unread; tapping
            deep-links to the deliveries "Unread" filter. Team-shared read state. */}
        {unreadDeliveries.length > 0 ? (
          <Card
            dense
            onPress={() =>
              router.push({
                pathname: `${REP_BASE}/deliveries` as `/(rep)/deliveries`,
                params: { filter: 'unread' },
              })
            }
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: colors.redSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="message" size={18} color={colors.red} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                  {unreadDeliveries.length} unread{' '}
                  {unreadDeliveries.length === 1 ? 'delivery' : 'deliveries'} from agents
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                >
                  {unreadMsgTotal} unread {unreadMsgTotal === 1 ? 'message needs' : 'messages need'}{' '}
                  a look
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={colors.textSecondary} />
            </View>
          </Card>
        ) : null}

        {/* Recent activity — shared with admin */}
        <RecentActivityCard rows={deliveries} loading={deliveriesQ.loading} basePath={REP_BASE} />

        {/* Agent workload — shared with admin */}
        <AgentWorkloadCard
          deliveries={deliveries}
          agents={agents}
          departedAtByAgent={departures}
          loading={deliveriesQ.loading && !deliveriesQ.data}
          onAgentPress={(agentId) =>
            router.navigate({
              pathname: `${REP_BASE}/deliveries` as `/(rep)/deliveries`,
              params: { agent: agentId },
            })
          }
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
