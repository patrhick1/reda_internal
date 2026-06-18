// Per-agent drilldown for the "Available orders" surface. Shows two sections:
//   1. "What to give" — per-product line: Needs · Has · Gap (give/collect/ok).
//      Pulled from the available-orders rows for this agent + current_stock.
//   2. "Orders" — the actual delivery rows the agent is going to do today.
//      Each row taps through to the existing Delivery detail screen.
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listAvailableOrders,
  buildAllocation,
  type AvailableOrderRow,
  type AllocationLine,
} from '@/services/available-orders';
import { listCurrentStock } from '@/services/stock';
import { AppBar, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export type AvailableBasePath = '/(dispatcher)' | '/(warehouse)';

export function AvailableAgentDetail({ basePath }: { basePath: AvailableBasePath }) {
  const router = useRouter();
  const { agentId } = useLocalSearchParams<{ agentId: string }>();

  const ordersQ = useAsync(() => listAvailableOrders(), []);
  const stockQ = useAsync(() => listCurrentStock(), []);

  useFocusEffect(
    useCallback(() => {
      ordersQ.reload();
      stockQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const agentRows = useMemo<AvailableOrderRow[]>(
    () => (ordersQ.data ?? []).filter((r) => r.agent_id === agentId),
    [ordersQ.data, agentId],
  );
  const agentName = agentRows[0]?.agent_name ?? 'Agent';
  const allocation = useMemo<AllocationLine[]>(
    () => buildAllocation(agentRows, stockQ.data ?? [], agentId ?? ''),
    [agentRows, stockQ.data, agentId],
  );

  const totalOrders = agentRows.length;
  const subtitle =
    totalOrders === 0
      ? 'No available orders'
      : `${totalOrders} ${totalOrders === 1 ? 'order' : 'orders'}`;

  const loading = ordersQ.loading || stockQ.loading;
  const error = ordersQ.error || stockQ.error;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title={agentName} subtitle={subtitle} onBack={() => router.back()} />

      {error ? (
        <Empty icon="alert" title="Could not load" sub={error} />
      ) : loading && !ordersQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : agentRows.length === 0 ? (
        <Empty
          icon="truck"
          title="No available orders for this agent"
          sub="This agent has no confirmed-going orders today."
        />
      ) : (
        <FlatList
          data={agentRows}
          keyExtractor={(o) => o.delivery_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={loading && !!ordersQ.data}
              onRefresh={() => {
                ordersQ.reload();
                stockQ.reload();
              }}
              tintColor={colors.black}
            />
          }
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 12 }}>
              {allocation.length > 0 ? (
                <>
                  <Text style={kicker}>What to give</Text>
                  <Card>
                    <View style={{ gap: 12 }}>
                      {allocation.map((line, idx) => (
                        <AllocationRow
                          key={line.product_catalog_id}
                          line={line}
                          divider={idx > 0}
                        />
                      ))}
                    </View>
                  </Card>
                </>
              ) : null}
              <Text style={kicker}>Orders</Text>
            </View>
          }
          renderItem={({ item }) => (
            <OrderRow
              row={item}
              onPress={
                // Warehouse role group has no /deliveries route — only
                // dispatcher's drilldown gets a tappable order row.
                basePath === '/(dispatcher)'
                  ? () =>
                      router.push(
                        `${basePath}/deliveries/${item.delivery_id}` as `/(dispatcher)/deliveries/${string}`,
                      )
                  : undefined
              }
            />
          )}
        />
      )}
    </View>
  );
}

function AllocationRow({ line, divider }: { line: AllocationLine; divider: boolean }) {
  const isGive = line.action === 'give';
  const isCollect = line.action === 'collect';
  const chipBg = isGive ? colors.redSoft : isCollect ? colors.warningSoft : colors.surface;
  const chipFg = isGive ? colors.red : isCollect ? colors.warningDark : colors.textSecondary;
  const chipLabel = isGive
    ? `GIVE ${line.gap}`
    : isCollect
      ? `COLLECT ${Math.abs(line.gap)}`
      : 'OK';
  return (
    <View
      style={
        divider
          ? { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 }
          : { gap: 6 }
      }
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Text
            style={{
              fontFamily: fonts.semibold,
              fontSize: 14,
              color: colors.black,
            }}
            numberOfLines={1}
          >
            {line.product_name}
          </Text>
          {/* Vendor — disambiguates products sold by two clients so the
              warehouse knows whose stock to transfer from. */}
          {line.client_name ? (
            <Text
              style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}
              numberOfLines={1}
            >
              {line.client_name}
            </Text>
          ) : null}
        </View>
        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 999,
            backgroundColor: chipBg,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 11,
              color: chipFg,
              letterSpacing: 0.3,
            }}
          >
            {chipLabel}
          </Text>
        </View>
      </View>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 12,
          color: colors.textSecondary,
        }}
      >
        Needs {line.qty_needed} · Has {line.qty_held}
      </Text>
    </View>
  );
}

function OrderRow({ row, onPress }: { row: AvailableOrderRow; onPress: (() => void) | undefined }) {
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {row.customer_name}
            {row.location_name ? (
              <Text style={{ fontFamily: fonts.medium, color: colors.textSecondary }}>
                {' '}
                · {row.location_name}
              </Text>
            ) : null}
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
            {row.product_name} × {row.quantity_ordered}
            {row.client_name ? ` · ${row.client_name}` : ''}
          </Text>
        </View>
      </View>
    </Card>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
