import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listAgentEarnings, type AgentEarningRow } from '@/services/deliveries';
import { listAgentEarningsSummary } from '@/services/reconciliation';
import { formatNaira } from '@/lib/format';
import { AppBar, Card, Empty, SectionHeader } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export default function AgentEarnings() {
  const user = useCurrentUser();
  const { data, loading, error, reload } = useAsync(
    () => listAgentEarnings(user.userId),
    [user.userId],
  );

  // Agents remit DAILY, not weekly (per Uzo, 2026-06-20), so the remit card is
  // scoped to TODAY only — (today, today) is an inclusive single-day range.
  // agent_earnings_summary already gates on is_admin_or_dispatcher() OR
  // u.id = auth.uid(), so this returns a single row — the caller's own — with
  // today's collected / earnings / remit aggregated.
  const week = useMemo(() => lagosWeekRange(), []);
  const remitQ = useAsync(() => listAgentEarningsSummary(week.today, week.today), [week.today]);

  useFocusEffect(
    useCallback(() => {
      reload();
      remitQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reload]),
  );

  const buckets = useMemo(() => bucketize(data ?? []), [data]);
  // Single-row response keyed to the caller; defensive fallbacks keep the
  // card rendering during the first load and on the rare empty-week case.
  const remit = remitQ.data?.[0];
  const collected = Number(remit?.total_collected ?? 0);
  const youKeep = Number(remit?.total_earnings ?? 0);
  const toRemit = Number(remit?.total_remit ?? 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="My earnings" subtitle="Paid every Friday" />
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <EarningRow row={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={loading && !!data}
            onRefresh={reload}
            tintColor={colors.black}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <Card style={{ backgroundColor: colors.black }}>
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 11,
                  color: colors.textTertiary,
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                }}
              >
                Today
              </Text>
              <Text
                style={{
                  fontFamily: fonts.extrabold,
                  fontSize: 40,
                  color: colors.white,
                  letterSpacing: -1.2,
                  marginTop: 4,
                }}
              >
                {formatNaira(buckets.today)}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
                <SubStat label="This week" value={formatNaira(buckets.thisWeek)} />
                <View style={{ width: 1, backgroundColor: '#333' }} />
                <SubStat label="This month" value={formatNaira(buckets.thisMonth)} />
              </View>
            </Card>
            <Card>
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 11,
                  color: colors.textSecondary,
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                }}
              >
                Remit today
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  marginTop: 10,
                  alignItems: 'flex-start',
                }}
              >
                <RemitTile label="Collected" value={formatNaira(collected)} />
                <View style={{ width: 1, backgroundColor: colors.border, marginHorizontal: 12 }} />
                <RemitTile
                  label="You keep"
                  value={formatNaira(youKeep)}
                  valueColor={colors.success}
                />
                <View style={{ width: 1, backgroundColor: colors.border, marginHorizontal: 12 }} />
                <RemitTile label="To remit" value={formatNaira(toRemit)} valueColor={colors.red} />
              </View>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 11,
                  color: colors.textTertiary,
                  marginTop: 10,
                }}
              >
                {remitQ.loading && !remit
                  ? 'Loading…'
                  : 'Cash + transfer you collected, minus your delivery pay.'}
              </Text>
            </Card>
            <SectionHeader>Recent deliveries</SectionHeader>
          </View>
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load earnings" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="package"
              title="No earnings yet"
              sub="They'll show up here once deliveries are marked delivered."
            />
          )
        }
      />
    </View>
  );
}

function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.white, marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}

function RemitTile({
  label,
  value,
  valueColor = colors.black,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 10,
          color: colors.textSecondary,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 16,
          color: valueColor,
          marginTop: 4,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function EarningRow({ row }: { row: AgentEarningRow }) {
  return (
    <Card dense>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
            {row.customer_name}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {row.product_name ?? '—'}
          </Text>
          <Text
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              color: colors.textTertiary,
              marginTop: 2,
            }}
          >
            {row.scheduled_date}
          </Text>
        </View>
        <Text style={{ fontFamily: fonts.extrabold, fontSize: 16, color: colors.success }}>
          +{formatNaira(row.agent_payment_snapshot)}
        </Text>
      </View>
    </Card>
  );
}

/** Lagos work-week (Mon → today, inclusive) as YYYY-MM-DD strings. Reused by
 *  the per-row bucketizer and by the remit RPC call so they always agree on
 *  what "this week" means. */
function lagosWeekRange(): { start: string; today: string; startOfMonth: string } {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  const today = lagos.toISOString().slice(0, 10);
  const day = lagos.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(lagos);
  monday.setUTCDate(lagos.getUTCDate() - daysToMonday);
  const startOfMonth = new Date(lagos);
  startOfMonth.setUTCDate(1);
  return {
    start: monday.toISOString().slice(0, 10),
    today,
    startOfMonth: startOfMonth.toISOString().slice(0, 10),
  };
}

function bucketize(rows: AgentEarningRow[]) {
  const r = lagosWeekRange();
  let today = 0,
    thisWeek = 0,
    thisMonth = 0;
  for (const row of rows) {
    const amount = Number(row.agent_payment_snapshot);
    if (row.scheduled_date === r.today) today += amount;
    if (row.scheduled_date >= r.start) thisWeek += amount;
    if (row.scheduled_date >= r.startOfMonth) thisMonth += amount;
  }
  return { today, thisWeek, thisMonth };
}
