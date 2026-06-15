import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, type DeliveryRow } from '@/services/deliveries';
import { formatNaira } from '@/lib/format';
import { Button, Card, Empty, Icon, RedaMark, SectionHeader, StatusPill } from '@/components/ui';
import { BulkMarkDeliveredSheet } from '@/components/sheets/BulkMarkDeliveredSheet';
import { canBulkDeliverRow, canBulkMarkDelivered } from '@/lib/permissions';
import type { STATUS_GROUPS } from '@/lib/theme';
import { colors, fonts, statusBucket } from '@/lib/theme';

const BUCKET_ACCENT: Record<keyof typeof STATUS_GROUPS, string> = {
  active: colors.red,
  soft: colors.warning,
  done: colors.success,
  closed: colors.closed,
};

function todayLagosLabel(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export default function AgentToday() {
  const user = useCurrentUser();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, loading, error, reload } = useAsync(() => listDeliveries(user.role), [user.role]);
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  const canBulk = canBulkMarkDelivered(user.role);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  // Orders whose "mark delivered" job was just enqueued but hasn't drained yet.
  // We suppress re-selecting them so the agent can't double-enqueue a delivery
  // that's already in flight (the list still shows its pre-delivery status
  // until the queue drains + a reload lands).
  const [pendingDeliveredIds, setPendingDeliveredIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const enterSelect = useCallback((seedId: string | null) => {
    setSelectMode(true);
    setSelectedIds(seedId ? new Set([seedId]) : new Set());
  }, []);
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedRows = useMemo<DeliveryRow[]>(() => {
    if (!selectMode || selectedIds.size === 0 || !data) return [];
    return data.filter((d) => d.id && selectedIds.has(d.id));
  }, [data, selectMode, selectedIds]);

  const onBulkConfirmed = useCallback(
    (count: number) => {
      setBulkSheetOpen(false);
      // Capture the submitted ids BEFORE exitSelect clears the selection, so
      // we can suppress re-selecting them while their jobs are in flight.
      setPendingDeliveredIds((prev) => {
        const next = new Set(prev);
        for (const d of selectedRows) if (d.id) next.add(d.id);
        return next;
      });
      exitSelect();
      reload();
      Alert.alert('Done', `Marking ${count} ${count === 1 ? 'order' : 'orders'} delivered…`);
    },
    [exitSelect, reload, selectedRows],
  );

  // Stop suppressing an order once fresh data shows it's no longer eligible —
  // i.e. its delivered job landed (it's now terminal, so canBulkDeliverRow is
  // false anyway). Rows still eligible stay suppressed (job in flight). The set
  // is in-memory, so a dead-lettered job's suppression also lifts on restart.
  useEffect(() => {
    if (!data) return;
    setPendingDeliveredIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        const row = data.find((d) => d.id === id);
        if (row && canBulkDeliverRow(row)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const stats = useMemo(() => summarize(data ?? []), [data]);
  const dateLabel = todayLagosLabel();
  const firstName = user.displayName.split(' ')[0] ?? user.displayName;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Hero header */}
      <View
        style={{
          backgroundColor: colors.white,
          paddingHorizontal: 16,
          paddingTop: insets.top + 16,
          paddingBottom: 24,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <RedaMark size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              {dateLabel}
            </Text>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 16,
                color: colors.black,
                letterSpacing: -0.2,
                marginTop: 1,
              }}
            >
              {greeting()}, {firstName}.
            </Text>
          </View>
          <View>
            <Icon name="bell" size={22} color={colors.black} />
          </View>
        </View>

        {/* Bi-stat bar — "To collect" intentionally omitted so agents don't
            walk around knowing a running sum of cash they're carrying. */}
        <View
          style={{
            marginTop: 18,
            flexDirection: 'row',
            backgroundColor: colors.border,
            borderRadius: 14,
            overflow: 'hidden',
            gap: 1,
          }}
        >
          <StatCell
            label="Earned today"
            value={formatNaira(stats.earnedToday)}
            accent={colors.success}
          />
          <StatCell
            label="Deliveries"
            value={`${stats.delivered}/${stats.total}`}
            accent={colors.black}
          />
        </View>
      </View>

      {/* List */}
      <FlatList
        data={data ?? []}
        keyExtractor={keyForDelivery}
        renderItem={({ item }) => {
          const itemId = item.id ?? null;
          const selectable =
            canBulk && canBulkDeliverRow(item) && !(itemId && pendingDeliveredIds.has(itemId));
          return (
            <DeliveryCard
              delivery={item}
              selectMode={selectMode}
              selectable={selectable}
              selected={!!itemId && selectedIds.has(itemId)}
              onPress={() => {
                if (selectMode) {
                  if (selectable && itemId) toggleSelected(itemId);
                  return;
                }
                router.push({ pathname: '/(agent)/today/[id]', params: { id: item.id! } });
              }}
              onLongPress={
                canBulk && selectable && itemId
                  ? () => {
                      if (!selectMode) enterSelect(itemId);
                      else toggleSelected(itemId);
                    }
                  : undefined
              }
            />
          );
        }}
        ItemSeparatorComponent={SeparatorH12}
        ListHeaderComponent={
          <SectionHeader>
            Today · {stats.total} {stats.total === 1 ? 'stop' : 'stops'}
          </SectionHeader>
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60 }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="package"
              title="No deliveries today"
              sub="Anything Reda assigns to you shows up here. Pull down to refresh if you're expecting one."
            />
          )
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: selectMode ? 110 : 32,
          flexGrow: 1,
        }}
        initialNumToRender={10}
        windowSize={5}
        maxToRenderPerBatch={6}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            refreshing={loading && !!data}
            onRefresh={reload}
            tintColor={colors.black}
          />
        }
      />

      {selectMode ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: colors.white,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Button variant="secondary" onPress={exitSelect}>
            Cancel
          </Button>
          <View style={{ flex: 1 }}>
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={() => setBulkSheetOpen(true)}
              disabled={selectedIds.size === 0}
            >
              {selectedIds.size === 0 ? 'Select orders' : `Mark ${selectedIds.size} delivered`}
            </Button>
          </View>
        </View>
      ) : null}

      <BulkMarkDeliveredSheet
        open={bulkSheetOpen}
        selected={selectedRows}
        onClose={() => setBulkSheetOpen(false)}
        onConfirmed={onBulkConfirmed}
      />
    </View>
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 12 }}
    >
      <Text
        style={{
          fontFamily: fonts.semibold,
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
          fontSize: 18,
          color: accent,
          letterSpacing: -0.3,
          marginTop: 4,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

const DeliveryCard = memo(function DeliveryCard({
  delivery,
  onPress,
  onLongPress,
  selectMode,
  selectable,
  selected,
}: {
  delivery: DeliveryRow;
  onPress: () => void;
  onLongPress?: () => void;
  /** True when the screen is in multi-select mode (bulk Mark delivered). */
  selectMode: boolean;
  /** True when this row is eligible for bulk delivered (open + has location).
   *  Ineligible rows render dimmed with no checkbox and can't be selected. */
  selectable: boolean;
  selected: boolean;
}) {
  const status = delivery.current_status ?? 'pending';
  const bucket = statusBucket(status);
  const isDone = status === 'delivered';
  const dimmed = isDone || (selectMode && !selectable);
  return (
    <Card
      onPress={onPress}
      onLongPress={onLongPress}
      dense
      style={dimmed ? { opacity: 0.55 } : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 12 }}>
        {selectMode ? (
          <View
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled: !selectable }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: !selectable ? colors.border : selected ? colors.black : colors.border,
              backgroundColor: selected ? colors.black : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              alignSelf: 'center',
            }}
          >
            {selected ? <Icon name="check" size={14} color={colors.white} /> : null}
          </View>
        ) : null}
        <View
          style={{
            width: 4,
            borderRadius: 4,
            minHeight: 40,
            backgroundColor: BUCKET_ACCENT[bucket],
          }}
        />
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontFamily: fonts.bold,
                fontSize: 15,
                color: colors.black,
                letterSpacing: -0.2,
              }}
              numberOfLines={1}
            >
              {delivery.customer_name}
            </Text>
            <StatusPill status={status} size="sm" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <Icon name="mapPin" size={12} color={colors.textSecondary} />
            <Text
              style={{
                flex: 1,
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.textSecondary,
              }}
              numberOfLines={1}
            >
              {delivery.location_name ?? 'Unmatched'}
            </Text>
          </View>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 8,
            }}
          >
            <Text
              style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.black }}
              numberOfLines={1}
            >
              <Text style={{ fontFamily: fonts.semibold }}>{delivery.product_name ?? '—'}</Text>
              {delivery.quantity_ordered && delivery.quantity_ordered > 1 ? (
                <Text style={{ color: colors.textSecondary }}> × {delivery.quantity_ordered}</Text>
              ) : null}
            </Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 14,
                color: isDone ? colors.success : colors.black,
                letterSpacing: -0.2,
              }}
            >
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

function keyForDelivery(d: DeliveryRow): string {
  return d.id ?? Math.random().toString();
}
function SeparatorH12() {
  return <View style={{ height: 12 }} />;
}

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
