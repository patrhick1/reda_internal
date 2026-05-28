import { useCallback, useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, siblingGroupKey, type DeliveryRow } from '@/services/deliveries';
import { listBotInbound } from '@/services/bot';
import { listUsers } from '@/services/users';
import {
  ISSUE_LABELS,
  listOpenIssuesForOps,
  type OpenIssueRow,
} from '@/services/delivery-messages';
import { AppBar, Card, Icon, SectionHeader, StatusPill } from '@/components/ui';
import { AgentWorkloadCard } from '@/components/delivery/AgentWorkloadCard';
import { RecentActivityCard } from '@/components/delivery/RecentActivityCard';
import { colors, fonts, statusBucket } from '@/lib/theme';
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

  useFocusEffect(
    useCallback(() => {
      todayQ.reload();
      reviewQ.reload();
      issuesQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const stats = useMemo(() => summarize(todayQ.data ?? []), [todayQ.data]);
  const reviewCount = (reviewQ.data ?? []).length;
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
          <View style={{ marginTop: 14, flexDirection: 'row', gap: 18, paddingHorizontal: 2 }}>
            <BreakdownItem label="Active" value={stats.active} />
            <BreakdownItem label="Closed" value={stats.closed} />
            <BreakdownItem label="Rolled" value={stats.rolled} />
          </View>
        </Card>

        {/* Needs attention */}
        {reviewCount > 0 || stats.stale > 0 || openIssues.length > 0 ? (
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
        </View>

        {/* Recent activity */}
        <RecentActivityCard rows={todayQ.data ?? []} loading={todayQ.loading} basePath="/(admin)" />

        {/* Agent workload — shared with rep dashboard */}
        <AgentWorkloadCard
          deliveries={todayQ.data ?? []}
          agents={agents}
          loading={todayQ.loading && !todayQ.data}
          basePath="/(admin)"
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

function IssuesAttentionBlock({
  issues,
  onOpen,
}: {
  issues: OpenIssueRow[];
  onOpen: (deliveryId: string) => void;
}) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
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
          <Icon name="alert" size={18} color={colors.red} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
            {issues.length} open {issues.length === 1 ? 'issue' : 'issues'} from agents
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            Tap a row to open
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 4, gap: 6 }}>
        {issues.map((row) => (
          <TouchableOpacity
            key={row.delivery_id}
            onPress={() => onOpen(row.delivery_id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: colors.surface,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}
                numberOfLines={1}
              >
                {row.customer_name ?? 'Customer'}
              </Text>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textSecondary,
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                {row.issue_type ? ISSUE_LABELS[row.issue_type] : 'Issue'}
                {row.agent_name ? ` · ${row.agent_name}` : ''}
              </Text>
            </View>
            {row.current_status ? (
              <StatusPill status={row.current_status} variant="subtle" size="sm" />
            ) : null}
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ))}
      </View>
    </Card>
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
 *  Per group outcome (priority order): delivered → active → rolled → closed.
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
    rolled = 0,
    closed = 0,
    stale = 0;
  for (const group of groups.values()) {
    if (group.some((d) => d.current_status === 'delivered')) {
      delivered++;
      continue;
    }
    const buckets = group.map((d) => statusBucket(d.current_status));
    const hasActive = buckets.some((b) => b === 'active');
    const hasSoft = buckets.some((b) => b === 'soft');
    if (hasActive || hasSoft) {
      active++;
      if (hasSoft) stale++;
      continue;
    }
    if (group.some((d) => d.current_status === 'rolled_over')) {
      rolled++;
      continue;
    }
    closed++;
  }
  const total = groups.size;
  const rateLabel = total === 0 ? '—' : `${Math.round((delivered / total) * 100)}%`;
  return { delivered, active, rolled, closed, stale, total, rateLabel };
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
