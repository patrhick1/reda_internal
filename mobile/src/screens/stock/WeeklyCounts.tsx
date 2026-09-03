import { useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppBar, Button, Card, Empty, FilterChips } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { listWeeklyAgentCounts } from '@/services/stock-counts';
import { shiftCountWeek, stockCountWeek } from '@/lib/stock-count-week';
import { formatDateLagos, formatDateTimeLagos, todayLagos } from '@/lib/date';
import { colors, fonts } from '@/lib/theme';

export function WeeklyCounts({ basePath }: { basePath: '/(admin)' | '/(dispatcher)' }) {
  const router = useRouter();
  const currentWeek = stockCountWeek(todayLagos());
  const [week, setWeek] = useState(currentWeek);
  const [filter, setFilter] = useState('all');
  const q = useAsync(async () => ({ week, rows: await listWeeklyAgentCounts(week) }), [week]);
  useReloadOnFocus(q.reload);
  // A previous week's response must never appear under the new week's heading.
  const rows = q.data?.week === week ? q.data.rows : [];
  const submitted = rows.filter((r) => r.batch_id).length;
  const off = rows.filter((r) => (r.off_count ?? 0) > 0).length;
  const visible = rows.filter((r) =>
    filter === 'pending'
      ? !r.batch_id
      : filter === 'submitted'
        ? !!r.batch_id
        : filter === 'off'
          ? (r.off_count ?? 0) > 0
          : true,
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Weekly agent counts" onBack={() => router.back()} />
      <View style={{ padding: 16, gap: 12 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Button variant="secondary" size="sm" onPress={() => setWeek(shiftCountWeek(week, -1))}>
            Previous
          </Button>
          <Text style={{ fontFamily: fonts.bold }}>{formatDateLagos(week)}</Text>
          <Button
            variant="secondary"
            size="sm"
            disabled={week >= currentWeek}
            onPress={() => setWeek(shiftCountWeek(week, 1))}
          >
            Next
          </Button>
        </View>
        <Card>
          <Text style={{ fontFamily: fonts.bold, fontSize: 22 }}>
            {q.error
              ? 'Could not check submissions'
              : q.loading && rows.length === 0
                ? 'Loading…'
                : `${submitted} of ${rows.length} submitted`}
          </Text>
          {!q.error && (!q.loading || rows.length > 0) ? (
            <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary, marginTop: 6 }}>
              {rows.length - submitted} remaining · {off} with differences
            </Text>
          ) : null}
          <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary, marginTop: 6 }}>
            Saturday counts · later submissions marked late. Differences still count as submitted.
          </Text>
        </Card>
      </View>
      <View>
        <FilterChips
          options={[
            { id: 'all', label: 'All' },
            { id: 'pending', label: 'Remaining' },
            { id: 'submitted', label: 'Submitted' },
            { id: 'off', label: 'Differences' },
          ]}
          value={filter}
          onChange={setFilter}
        />
      </View>
      <FlatList
        style={{ flex: 1 }}
        data={visible}
        keyExtractor={(r) => r.agent_id}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        refreshControl={
          <RefreshControl refreshing={q.loading && rows.length > 0} onRefresh={q.reload} />
        }
        ListHeaderComponent={
          q.error ? <Empty icon="alert" title="Could not load weekly counts" sub={q.error} /> : null
        }
        ListEmptyComponent={
          q.loading ? (
            <ActivityIndicator />
          ) : !q.error ? (
            <Empty
              icon="check"
              title={
                filter === 'pending' && rows.length > 0
                  ? 'Everyone has submitted'
                  : 'No agents in this view'
              }
            />
          ) : null
        }
        ListFooterComponent={
          <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary, marginTop: 12 }}>
            Shows active agents and any inactive agents who submitted this week. Only complete agent
            self-counts fulfil the weekly requirement.
          </Text>
        }
        renderItem={({ item }) => (
          <Card
            onPress={
              item.batch_id
                ? () =>
                    router.push({
                      pathname: `${basePath}/stock/count-history`,
                      params: { holderId: item.agent_id, weekEnding: week },
                    })
                : undefined
            }
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 16 }}>{item.agent_name}</Text>
            <Text
              style={{
                fontFamily: fonts.bold,
                color: !item.batch_id
                  ? colors.textSecondary
                  : item.off_count
                    ? colors.red
                    : colors.success,
                marginTop: 6,
              }}
            >
              {!item.batch_id
                ? 'Awaiting count'
                : item.off_count
                  ? `Submitted · ${item.off_count} ${item.off_count === 1 ? 'product' : 'products'} off`
                  : item.items_count === 0
                    ? 'Submitted · no stock confirmed'
                    : 'Submitted · all match'}
              {item.is_late ? ' · Late' : ''}
            </Text>
            {item.counted_at ? (
              <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary, marginTop: 4 }}>
                {formatDateTimeLagos(item.counted_at)} · {item.items_count}{' '}
                {item.items_count === 1 ? 'product' : 'products'} counted
              </Text>
            ) : null}
          </Card>
        )}
      />
    </View>
  );
}
