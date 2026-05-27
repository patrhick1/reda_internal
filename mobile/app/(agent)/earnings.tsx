import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listAgentEarnings, type AgentEarningRow } from '@/services/deliveries';
import { formatNaira } from '@/lib/format';
import { AppBar, Card, Empty, SectionHeader } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export default function AgentEarnings() {
  const user = useCurrentUser();
  const { data, loading, error, reload } = useAsync(
    () => listAgentEarnings(user.userId),
    [user.userId],
  );
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const buckets = useMemo(() => bucketize(data ?? []), [data]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="My earnings" subtitle="Paid every Friday" />
      <FlatList
        data={data ?? []}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <EarningRow row={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} tintColor={colors.black} />}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <Card style={{ backgroundColor: colors.black }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: colors.textTertiary, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                This week
              </Text>
              <Text style={{ fontFamily: fonts.extrabold, fontSize: 40, color: colors.white, letterSpacing: -1.2, marginTop: 4 }}>
                {formatNaira(buckets.thisWeek)}
              </Text>
              <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
                <SubStat label="Today" value={formatNaira(buckets.today)} />
                <View style={{ width: 1, backgroundColor: '#333' }} />
                <SubStat label="This month" value={formatNaira(buckets.thisMonth)} />
              </View>
            </Card>
            <SectionHeader>Recent deliveries</SectionHeader>
          </View>
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load earnings" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}><ActivityIndicator color={colors.black} /></View>
          ) : (
            <Empty icon="package" title="No earnings yet" sub="They'll show up here once deliveries are marked delivered." />
          )
        }
      />
    </View>
  );
}

function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>{label}</Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.white, marginTop: 2 }}>{value}</Text>
    </View>
  );
}

function EarningRow({ row }: { row: AgentEarningRow }) {
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>{row.customer_name}</Text>
          <Text numberOfLines={1} style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
            {row.product_name ?? '—'}
          </Text>
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>
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

function bucketize(rows: AgentEarningRow[]) {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  const todayStr = lagos.toISOString().slice(0, 10);
  const day = lagos.getUTCDay();
  const daysToMonday = day === 0 ? 6 : day - 1;
  const startOfWeek = new Date(lagos);
  startOfWeek.setUTCDate(lagos.getUTCDate() - daysToMonday);
  const startOfWeekStr = startOfWeek.toISOString().slice(0, 10);
  const startOfMonth = new Date(lagos);
  startOfMonth.setUTCDate(1);
  const startOfMonthStr = startOfMonth.toISOString().slice(0, 10);

  let today = 0, thisWeek = 0, thisMonth = 0;
  for (const r of rows) {
    const amount = Number(r.agent_payment_snapshot);
    if (r.scheduled_date === todayStr) today += amount;
    if (r.scheduled_date >= startOfWeekStr) thisWeek += amount;
    if (r.scheduled_date >= startOfMonthStr) thisMonth += amount;
  }
  return { today, thisWeek, thisMonth };
}
