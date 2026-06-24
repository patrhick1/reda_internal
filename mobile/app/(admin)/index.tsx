import { useCallback, useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { usePendingLocationChangesCount } from '@/hooks/usePendingLocationChangesCount';
import {
  countNegativeMarginDeliveries,
  listDeliveries,
  siblingGroupKey,
  type DeliveryRow,
} from '@/services/deliveries';
import { listBotInbound } from '@/services/bot';
import { listUsers } from '@/services/users';
import { listOpenIssuesForOps } from '@/services/delivery-messages';
import { AppBar, Card, Icon, SectionHeader } from '@/components/ui';
import { AgentWorkloadCard } from '@/components/delivery/AgentWorkloadCard';
import { IssuesAttentionBlock } from '@/components/delivery/IssuesAttentionBlock';
import { RecentActivityCard } from '@/components/delivery/RecentActivityCard';
import { colors, fonts, statusBucket, isAssignedActive } from '@/lib/theme';
import { type IconName } from '@/components/ui';

function todayHeaderDate(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export default function AdminHome() {
  const user = useCurrentUser();
  const router = useRouter();
  const todayQ = useAsync(() => listDeliveries(user.role), [user.role]);
  const reviewQ = useAsync(() => listBotInbound('needs_review', 100), []);
  const issuesQ = useAsync(() => listOpenIssuesForOps(), []);
  const usersQ = useAsync(() => listUsers(), []);
  const negMarginQ = useAsync(() => countNegativeMarginDeliveries(), []);

  useFocusEffect(
    useCallback(() => {
      todayQ.reload();
      reviewQ.reload();
      issuesQ.reload();
      negMarginQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const stats = useMemo(() => summarize(todayQ.data ?? []), [todayQ.data]);
  const reviewCount = (reviewQ.data ?? []).length;
  const negMarginCount = negMarginQ.data ?? 0;
  const pendingZoneCount = usePendingLocationChangesCount();
  const openIssues = issuesQ.data ?? [];
  const agents = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.role === 'agent' && u.is_active),
    [usersQ.data],
  );
  const firstName = user.displayName.split(' ')[0] ?? user.displayName;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title={`Hi, ${firstName}`}
        subtitle={`${todayHeaderDate()} · Admin`}
        right={
          <TouchableOpacity onPress={() => router.push('/(admin)/settings')} hitSlop={8}>
            <Icon name="settings" size={20} color={colors.black} />
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}>
        {/* Today's ops hero — count + completed + rate at a glance */}
        <Card style={{ backgroundColor: colors.black, padding: 18 }}>
          <Text style={kicker('dark')}>Today</Text>
          <View
            style={{
              marginTop: 12,
              flexDirection: 'row',
              borderRadius: 10,
              overflow: 'hidden',
              backgroundColor: '#222',
              gap: 1,
            }}
          >
            <HeroStat label="Orders" value={String(stats.total)} accent={colors.white} />
            <HeroStat label="Completed" value={String(stats.delivered)} accent={colors.success} />
            <HeroStat label="Rate" value={stats.rateLabel} accent={colors.red} />
          </View>
          {/* The four chips sum to ORDERS so the hero card double-acts as a
              budget: Completed + Active + Unassigned + Closed = total.
              Completed is listed first to mirror the HeroStat focus order. */}
          <View
            style={{
              marginTop: 14,
              flexDirection: 'row',
              flexWrap: 'wrap',
              rowGap: 8,
              columnGap: 18,
              paddingHorizontal: 2,
            }}
          >
            <BreakdownItem label="Completed" value={stats.delivered} />
            <BreakdownItem label="Active" value={stats.active} />
            <BreakdownItem label="Unassigned" value={stats.unassigned} />
            <BreakdownItem label="Closed" value={stats.closed} />
          </View>
        </Card>

        {/* Needs attention */}
        {reviewCount > 0 ||
        stats.stale > 0 ||
        openIssues.length > 0 ||
        pendingZoneCount > 0 ||
        negMarginCount > 0 ? (
          <>
            <SectionHeader>Needs attention</SectionHeader>
            <View style={{ gap: 8 }}>
              {openIssues.length > 0 ? (
                <IssuesAttentionBlock
                  issues={openIssues}
                  onOpen={(deliveryId) =>
                    router.push({
                      pathname: '/(admin)/deliveries/[id]',
                      params: { id: deliveryId },
                    })
                  }
                />
              ) : null}
              {reviewCount > 0 ? (
                <AttentionRow
                  icon="alert"
                  iconBg={colors.redSoft}
                  iconColor={colors.red}
                  title={`${reviewCount} ${reviewCount === 1 ? 'item needs' : 'items need'} review`}
                  sub="Unmatched addresses or failed bot ingestion"
                  onPress={() => router.push('/(admin)/needs-review')}
                />
              ) : null}
              {pendingZoneCount > 0 ? (
                <AttentionRow
                  icon="mapPin"
                  iconBg={colors.warningSoft}
                  iconColor={colors.warningDark}
                  title={`${pendingZoneCount} zone ${pendingZoneCount === 1 ? 'change' : 'changes'} to approve`}
                  sub="Agent delivered elsewhere — raises their pay"
                  onPress={() => router.push('/(admin)/location-approvals')}
                />
              ) : null}
              {negMarginCount > 0 ? (
                <AttentionRow
                  icon="alert"
                  iconBg={colors.redSoft}
                  iconColor={colors.red}
                  title={`${negMarginCount} negative-margin ${negMarginCount === 1 ? 'order' : 'orders'}`}
                  sub="Reda pays the agent more than it collects — correct the charges"
                  onPress={() => router.push('/(admin)/negative-margin')}
                />
              ) : null}
              {stats.stale > 0 ? (
                <AttentionRow
                  icon="history"
                  iconBg={colors.warningSoft}
                  iconColor={colors.warningDark}
                  title={`${stats.stale} soft-failed today`}
                  sub="Customer unreachable or rescheduled"
                  onPress={() => router.push('/(admin)/deliveries')}
                />
              ) : null}
            </View>
          </>
        ) : null}

        {/* Quick actions */}
        <SectionHeader>Quick actions</SectionHeader>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <QuickAction
            icon="plus"
            label="New delivery"
            accent={colors.red}
            onPress={() => router.push('/(admin)/deliveries/new')}
          />
          <QuickAction
            icon="truck"
            label="Pickup / Waybill"
            accent={colors.black}
            onPress={() => router.push('/(admin)/waybill-new')}
          />
          <QuickAction
            icon="calendar"
            label="End of day"
            accent={colors.black}
            onPress={() => router.push('/(admin)/eod')}
          />
          <QuickAction
            icon="warehouse"
            label="Stock"
            accent={colors.black}
            onPress={() => router.push('/(admin)/stock')}
          />
          <QuickAction
            icon="box"
            label="Catalog"
            accent={colors.black}
            onPress={() => router.push('/(admin)/catalog')}
          />
          <QuickAction
            icon="users"
            label="Rep performance"
            accent={colors.black}
            onPress={() => router.push('/(admin)/rep-performance')}
          />
        </View>

        {/* Recent activity */}
        <RecentActivityCard rows={todayQ.data ?? []} loading={todayQ.loading} basePath="/(admin)" />

        {/* Agent workload — shared with rep dashboard */}
        <AgentWorkloadCard
          deliveries={todayQ.data ?? []}
          agents={agents}
          loading={todayQ.loading && !todayQ.data}
          onAgentPress={(agentId) =>
            router.navigate({ pathname: '/(admin)/deliveries', params: { agent: agentId } })
          }
        />
      </ScrollView>
    </View>
  );
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.black, paddingHorizontal: 12, paddingVertical: 14 }}
    >
      <Text style={kicker('dark', 'sm')}>{label}</Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 26,
          color: accent,
          marginTop: 4,
          letterSpacing: -0.4,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function BreakdownItem({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 10,
          color: colors.textTertiary,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.white }}>{value}</Text>
    </View>
  );
}

function AttentionRow({
  icon,
  iconBg,
  iconColor,
  title,
  sub,
  onPress,
}: {
  icon: IconName;
  iconBg: string;
  iconColor: string;
  title: string;
  sub: string;
  onPress: () => void;
}) {
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: iconBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={18} color={iconColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>{title}</Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {sub}
          </Text>
        </View>
        <Icon name="chevronRight" size={20} color={colors.textSecondary} />
      </View>
    </Card>
  );
}

function QuickAction({
  icon,
  label,
  accent,
  onPress,
}: {
  icon: IconName;
  label: string;
  accent: string;
  onPress: () => void;
}) {
  return (
    <View style={{ width: '48.5%' }}>
      <Card dense onPress={onPress}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={18} color={accent} />
          </View>
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>{label}</Text>
        </View>
      </Card>
    </View>
  );
}

/** Group sibling rows (same race-assignment) into one logical order, so the
 *  hero stats reflect unique customer orders rather than raw row count.
 *  Per group outcome (priority order):
 *    delivered → active → unassigned → rolled → closed
 *  `active` is **strict**: the group has at least one row that is in the
 *  active bucket AND has an assigned agent (mirrors `isAssignedActive` so
 *  the home matches the Deliveries list's Active filter exactly).
 *  `unassigned` catches the morning queue — groups whose active-bucket rows
 *  are all sitting unassigned, waiting to be routed.
 *  `stale` is the subset of `active` chains with at least one soft-fail row,
 *  kept for the Needs Attention block. */
function summarize(rows: DeliveryRow[]) {
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

  let delivered = 0,
    active = 0,
    unassigned = 0,
    rolled = 0,
    closed = 0,
    stale = 0;
  for (const group of groups.values()) {
    if (group.some((d) => d.current_status === 'delivered')) {
      delivered++;
      continue;
    }
    const hasAssignedActive = group.some((d) => isAssignedActive(d));
    const hasSoft = group.some((d) => statusBucket(d.current_status) === 'soft');
    if (hasAssignedActive || hasSoft) {
      active++;
      if (hasSoft) stale++;
      continue;
    }
    // No assigned-active row and no soft row. If the group still has any
    // active-bucket row sitting unassigned, it's queue work.
    const hasActiveBucket = group.some((d) => statusBucket(d.current_status) === 'active');
    if (hasActiveBucket) {
      unassigned++;
      continue;
    }
    if (group.some((d) => d.current_status === 'rolled_over')) {
      rolled++;
      continue;
    }
    closed++;
  }
  const total = groups.size;
  // Completion rate is measured against orders actually in play today —
  // delivered + active — NOT the full order count. The huge morning
  // "unassigned" rollover queue hasn't been dispatched yet, so counting it
  // in the denominator tanks the rate to a misleading single digit. This
  // answers "of what the agents are working, how much is done?".
  const inPlay = delivered + active;
  const rateLabel = inPlay === 0 ? '—' : `${Math.round((delivered / inPlay) * 100)}%`;
  return { delivered, active, unassigned, rolled, closed, stale, total, rateLabel };
}

function kicker(theme: 'light' | 'dark' = 'light', size: 'sm' | 'md' = 'md') {
  return {
    fontFamily: fonts.bold,
    fontSize: size === 'sm' ? 10 : 11,
    color: theme === 'dark' ? colors.textTertiary : colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  };
}
