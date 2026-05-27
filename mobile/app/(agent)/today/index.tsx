import { memo, useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, type DeliveryRow } from '@/services/deliveries';
import { formatNaira } from '@/lib/format';
import {
  Card, Empty, Icon, RedaMark, SectionHeader, StatusPill,
} from '@/components/ui';
import type { STATUS_GROUPS} from '@/lib/theme';
import { colors, fonts, statusBucket } from '@/lib/theme';

const BUCKET_ACCENT: Record<keyof typeof STATUS_GROUPS, string> = {
  active: colors.red,
  soft:   colors.warning,
  done:   colors.success,
  closed: colors.closed,
};

function todayLagosLabel(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
}

export default function AgentToday() {
  const user = useCurrentUser();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, loading, error, reload } = useAsync(
    () => listDeliveries(user.role),
    [user.role],
  );
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const stats = useMemo(() => summarize(data ?? []), [data]);
  const dateLabel = todayLagosLabel();
  const firstName = user.displayName.split(' ')[0] ?? user.displayName;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Hero header */}
      <View style={{
        backgroundColor: colors.white,
        paddingHorizontal: 16,
        paddingTop: insets.top + 16,
        paddingBottom: 24,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <RedaMark size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>{dateLabel}</Text>
            <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black, letterSpacing: -0.2, marginTop: 1 }}>
              {greeting()}, {firstName}.
            </Text>
          </View>
          <View>
            <Icon name="bell" size={22} color={colors.black} />
          </View>
        </View>

        {/* Bi-stat bar — "To collect" intentionally omitted so agents don't
            walk around knowing a running sum of cash they're carrying. */}
        <View style={{
          marginTop: 18,
          flexDirection: 'row',
          backgroundColor: colors.border,
          borderRadius: 14,
          overflow: 'hidden',
          gap: 1,
        }}>
          <StatCell label="Earned today" value={formatNaira(stats.earnedToday)} accent={colors.success} />
          <StatCell label="Deliveries" value={`${stats.delivered}/${stats.total}`} accent={colors.black} />
        </View>
      </View>

      {/* List */}
      <FlatList
        data={data ?? []}
        keyExtractor={keyForDelivery}
        renderItem={({ item }) => <DeliveryCard delivery={item} onPress={() => router.push({ pathname: '/(agent)/today/[id]', params: { id: item.id! } })} />}
        ItemSeparatorComponent={SeparatorH12}
        ListHeaderComponent={
          <SectionHeader>Today · {stats.total} {stats.total === 1 ? 'stop' : 'stops'}</SectionHeader>
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60 }}><ActivityIndicator color={colors.black} /></View>
          ) : (
            <Empty icon="package" title="No deliveries today" sub="Anything Uzo assigns to you shows up here. Pull down to refresh if you're expecting one." />
          )
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, flexGrow: 1 }}
        initialNumToRender={10}
        windowSize={5}
        maxToRenderPerBatch={6}
        removeClippedSubviews
        refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={reload} tintColor={colors.black} />}
      />
    </View>
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 12 }}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.textSecondary, letterSpacing: 0.6, textTransform: 'uppercase' }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.extrabold, fontSize: 18, color: accent, letterSpacing: -0.3, marginTop: 4 }}>
        {value}
      </Text>
    </View>
  );
}

const DeliveryCard = memo(function DeliveryCard({ delivery, onPress }: { delivery: DeliveryRow; onPress: () => void }) {
  const status = delivery.current_status ?? 'pending';
  const bucket = statusBucket(status);
  const isDone = status === 'delivered';
  return (
    <Card onPress={onPress} dense style={isDone ? { opacity: 0.65 } : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 12 }}>
        <View style={{
          width: 4, borderRadius: 4, minHeight: 40,
          backgroundColor: BUCKET_ACCENT[bucket],
        }} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Text style={{ flex: 1, fontFamily: fonts.bold, fontSize: 15, color: colors.black, letterSpacing: -0.2 }} numberOfLines={1}>
              {delivery.customer_name}
            </Text>
            <StatusPill status={status} size="sm" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <Icon name="mapPin" size={12} color={colors.textSecondary} />
            <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }} numberOfLines={1}>
              {delivery.location_name ?? 'Unmatched'}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
            <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.black }} numberOfLines={1}>
              <Text style={{ fontFamily: fonts.semibold }}>{delivery.product_name ?? '—'}</Text>
              {delivery.quantity_ordered && delivery.quantity_ordered > 1 ? (
                <Text style={{ color: colors.textSecondary }}> × {delivery.quantity_ordered}</Text>
              ) : null}
            </Text>
            <Text style={{ fontFamily: fonts.extrabold, fontSize: 14, color: isDone ? colors.success : colors.black, letterSpacing: -0.2 }}>
              {isDone && delivery.agent_payment_snapshot != null
                ? `+${formatNaira(delivery.agent_payment_snapshot)}`
                : formatNaira(delivery.customer_price)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
});

function keyForDelivery(d: DeliveryRow): string { return d.id ?? Math.random().toString(); }
function SeparatorH12() { return <View style={{ height: 12 }} />; }

function summarize(rows: DeliveryRow[]): { earnedToday: number; delivered: number; total: number } {
  // agent_payment_snapshot is per-delivery, not per-unit. Do NOT multiply by quantity.
  let earnedToday = 0;
  let delivered = 0;
  for (const d of rows) {
    if (d.current_status === 'delivered') {
      delivered++;
      earnedToday += Number(d.agent_payment_snapshot ?? 0);
    }
  }
  return { earnedToday, delivered, total: rows.length };
}

function greeting(): string {
  const h = new Date(new Date().getTime() + 60 * 60 * 1000).getUTCHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}
