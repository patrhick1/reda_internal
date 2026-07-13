// Per-agent drilldown for the "Available orders" surface. Shows two sections:
//   1. "What to give" — per-product line: Needs · Has · Gap (give/collect/ok).
//      Pulled from the available-orders rows for this agent + current_stock.
//   2. "Orders" — the actual delivery rows the agent is going to do today.
//      Each row taps through to the existing Delivery detail screen.
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import {
  listAvailableOrders,
  getAvailableOrderRawMessage,
  buildAllocation,
  type AvailableOrderRow,
  type AllocationLine,
} from '@/services/available-orders';
import { listCurrentStock } from '@/services/stock';
import { AppBar, Card, Empty, Icon } from '@/components/ui';
import { RawMessageSheet } from '@/components/sheets/RawMessageSheet';
import { colors, fonts } from '@/lib/theme';

export type AvailableBasePath = '/(dispatcher)' | '/(warehouse)';

export function AvailableAgentDetail({ basePath }: { basePath: AvailableBasePath }) {
  const router = useRouter();
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const isWarehouse = basePath === '/(warehouse)';
  // Warehouse rows have no Detail route to tap into, so tapping a row opens a
  // sheet with the order's original WhatsApp message instead. `sheetOpen` drives
  // visibility separately from `rawMsgRow` so the selected row stays mounted
  // through the close animation (no empty-state flash as the sheet slides out).
  // The raw text isn't shipped with the list (egress) — it's fetched on tap into
  // `rawMsgText`, with `rawMsgLoading` gating the sheet's spinner; `latestRawReq`
  // guards against a slow fetch for row A landing after the user opens row B.
  const [rawMsgRow, setRawMsgRow] = useState<AvailableOrderRow | null>(null);
  const [rawMsgText, setRawMsgText] = useState<string | null>(null);
  const [rawMsgLoading, setRawMsgLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const latestRawReq = useRef<string | null>(null);

  const openRawMessage = useCallback((row: AvailableOrderRow) => {
    latestRawReq.current = row.delivery_id;
    setRawMsgRow(row);
    setRawMsgText(null);
    setSheetOpen(true);
    // Manual orders have no bot text — skip the round-trip and show the sheet's
    // "added manually" empty state immediately.
    if (!row.has_raw_message) {
      setRawMsgLoading(false);
      return;
    }
    setRawMsgLoading(true);
    getAvailableOrderRawMessage(row.delivery_id)
      .then((text) => {
        if (latestRawReq.current === row.delivery_id) setRawMsgText(text);
      })
      .catch(() => {
        if (latestRawReq.current === row.delivery_id) setRawMsgText(null);
      })
      .finally(() => {
        if (latestRawReq.current === row.delivery_id) setRawMsgLoading(false);
      });
  }, []);

  const ordersQ = useAsync(() => listAvailableOrders(), []);
  const stockQ = useAsync(() => listCurrentStock(), []);

  useReloadOnFocus(() => {
    ordersQ.reload();
    stockQ.reload();
  });

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
              // Dispatcher drills into the full Delivery detail; warehouse (no
              // such route) opens the raw-WhatsApp-message sheet for the order.
              onPress={
                isWarehouse
                  ? () => openRawMessage(item)
                  : () =>
                      router.push(
                        `${basePath}/deliveries/${item.delivery_id}` as `/(dispatcher)/deliveries/${string}`,
                      )
              }
              showMessageHint={isWarehouse && item.has_raw_message}
            />
          )}
        />
      )}

      <RawMessageSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        customerName={rawMsgRow?.customer_name ?? ''}
        message={rawMsgText}
        loading={rawMsgLoading}
      />
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

function OrderRow({
  row,
  onPress,
  showMessageHint = false,
}: {
  row: AvailableOrderRow;
  onPress: (() => void) | undefined;
  /** Show a trailing message icon hinting the row is tappable to read the
   *  original WhatsApp message (warehouse drilldown). */
  showMessageHint?: boolean;
}) {
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
        {showMessageHint ? <Icon name="message" size={16} color={colors.textTertiary} /> : null}
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
