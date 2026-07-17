import { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useCurrentUser } from '@/hooks/useAuth';
import { usePendingLocationChangesCount } from '@/hooks/usePendingLocationChangesCount';
import { countNegativeMarginDeliveries, type DeliveryRow } from '@/services/deliveries';
import { getTodayDeliveryRate, getDeliveryRateHistory } from '@/services/reconciliation';
import { countNeedsReview } from '@/services/bot';
import { useUsers, useDeliveriesList, useStockCoverage } from '@/hooks/queries';
import { listOpenIssuesForOps } from '@/services/delivery-messages';
import { AppBar, Card, Icon, SectionHeader } from '@/components/ui';
import { AgentWorkloadCard } from '@/components/delivery/AgentWorkloadCard';
import { IssuesAttentionBlock } from '@/components/delivery/IssuesAttentionBlock';
import { RecentActivityCard } from '@/components/delivery/RecentActivityCard';
import { RateTrendCard } from '@/components/delivery/RateTrendCard';
import { colors, fonts, statusBucket, isAssignedActive } from '@/lib/theme';
import { todayLagos } from '@/lib/date';
import { addDays, rateColor } from '@/lib/rate-trend';
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
  // Shares the deliveries-list cache (audit Phase 2.4b) with the admin
  // Deliveries tab — one cached today-list fetch feeds both the home hero and
  // the list. Stale-aware on focus.
  const todayQ = useDeliveriesList(user.role);
  const reviewQ = useAsync(() => countNeedsReview(), []);
  const issuesQ = useAsync(() => listOpenIssuesForOps(), []);
  const usersQ = useUsers();
  const negMarginQ = useAsync(() => countNegativeMarginDeliveries(), []);
  // Feeds both the "Available" chip and the "Rate" hero. Measured server-side
  // against orders the customer was actually engaged on (ever reached Available in
  // status history), not the raw order count — so unreachable leads the vendor
  // never convinced don't tank it. See getTodayDeliveryRate /
  // scripts/today-delivery-rate.sql.
  const rateQ = useAsync(() => getTodayDeliveryRate(), []);
  // Last 7 days for the home trend strip (tap → full history). Tiny payload
  // (≤7 rows); reads immutable status history so past days never move.
  const today = todayLagos();
  const trendQ = useAsync(() => getDeliveryRateHistory(addDays(today, -6), today), [today]);
  // Stock coverage — products whose fleet on-hand can't cover today's open
  // demand. Drives the "Needs attention" row; cached under ['stock'] so stock
  // moves and confirmations auto-refresh it.
  const coverageQ = useStockCoverage();

  useReloadOnFocus(() => {
    todayQ.refetchIfStale();
    reviewQ.reload();
    issuesQ.reload();
    negMarginQ.reload();
    rateQ.reload();
    trendQ.reload();
    coverageQ.refetchIfStale();
  });

  const stats = useMemo(() => summarize(todayQ.data ?? []), [todayQ.data]);
  // Label + banded colour (Greg's scale: <50 red, 50-74 orange, 75-89 green,
  // 90+ light green) — the hero was previously ALWAYS brand-red, which made a
  // healthy 84% read like a problem.
  const rate = useMemo(() => {
    const r = rateQ.data;
    const pct = !r || r.available === 0 ? null : Math.round((r.delivered / r.available) * 100);
    return { label: pct == null ? '—' : `${pct}%`, color: rateColor(pct, 'dark', colors.white) };
  }, [rateQ.data]);
  const reviewCount = reviewQ.data ?? 0;
  const negMarginCount = negMarginQ.data ?? 0;
  const pendingZoneCount = usePendingLocationChangesCount();
  const openIssues = issuesQ.data ?? [];
  // Products whose fleet stock can't cover today's open demand. `ordersAffected`
  // sums per-product order counts, so a multi-product order short on two
  // products counts twice — fine for an attention headline.
  const shortStock = useMemo(() => {
    const short = (coverageQ.data ?? []).filter((r) => r.on_hand_total < r.qty_open);
    return { count: short.length, ordersAffected: short.reduce((s, r) => s + r.orders_open, 0) };
  }, [coverageQ.data]);
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
            <HeroStat label="Rate" value={rate.label} accent={rate.color} />
          </View>
          {/* Completed / Active / Unassigned / Closed are disjoint status buckets
              that sum to ORDERS. "Available" is the odd one out on purpose: it's the
              rate denominator — orders that ever reached Available (or delivered) —
              so it OVERLAPS Completed/Active and is NOT part of that sum. It sits
              here so the rate reads at a glance: Completed ÷ Available = Rate. */}
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
            <BreakdownItem label="Available" value={rateQ.data?.available ?? 0} />
            <BreakdownItem label="Unassigned" value={stats.unassigned} />
            <BreakdownItem label="Closed" value={stats.closed} />
          </View>
        </Card>

        {/* Delivery-rate trend — 7-day strip, tap for the 30-day history. */}
        <RateTrendCard
          days={trendQ.data ?? []}
          today={today}
          loading={trendQ.loading && !trendQ.data}
          onPress={() => router.push('/(admin)/rate-history')}
        />

        {/* Needs attention */}
        {reviewCount > 0 ||
        openIssues.length > 0 ||
        pendingZoneCount > 0 ||
        negMarginCount > 0 ||
        shortStock.count > 0 ? (
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
              {shortStock.count > 0 ? (
                <AttentionRow
                  icon="warehouse"
                  iconBg={colors.redSoft}
                  iconColor={colors.red}
                  title={`${shortStock.count} ${shortStock.count === 1 ? 'product' : 'products'} can't cover today`}
                  sub={`${shortStock.ordersAffected} orders affected — see what's short`}
                  onPress={() => router.push('/(admin)/stock-coverage')}
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
 *  are all sitting unassigned, waiting to be routed. */
function summarize(rows: DeliveryRow[]) {
  const groups = new Map<string, DeliveryRow[]>();
  for (const r of rows) {
    const key = r.sibling_group_key;
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
    closed = 0;
  for (const group of groups.values()) {
    if (group.some((d) => d.current_status === 'delivered')) {
      delivered++;
      continue;
    }
    const hasAssignedActive = group.some((d) => isAssignedActive(d));
    const hasSoft = group.some((d) => statusBucket(d.current_status) === 'soft');
    if (hasAssignedActive || hasSoft) {
      active++;
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
  // NB: the "Rate" hero is NOT computed here. It's measured server-side against
  // orders that ever reached Available (getTodayDeliveryRate), so unreachable leads
  // don't tank it. These grouped counts still drive Orders / Completed / Active /
  // Unassigned / Closed.
  return { delivered, active, unassigned, rolled, closed, total };
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
