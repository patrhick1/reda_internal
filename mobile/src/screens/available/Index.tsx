// Shared "Available orders" index — dispatcher + warehouse both render this
// via thin route wrappers. Two stacked sections:
//   1. "Total to pull today" — per-client per-product roll-up. The warehouse
//      person reads this to know which units to surface today.
//   2. "By agent" — one row per agent with available orders, summarising
//      the per-product breakdown inline. Tap a row → per-agent drilldown.
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listAvailableOrders,
  groupByAgent,
  aggregateByClientProduct,
  type AgentGroup,
  type ClientAggregate,
} from '@/services/available-orders';
import { listDeparturesToday } from '@/services/agent-departures';
import { DepartureChip } from '@/components/agent/DepartureChip';
import { AppBar, Avatar, Card, Empty, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export type AvailableBasePath = '/(dispatcher)' | '/(warehouse)';

export function AvailableOrdersIndex({ basePath }: { basePath: AvailableBasePath }) {
  const router = useRouter();
  const ordersQ = useAsync(() => listAvailableOrders(), []);
  // Which agents have left the warehouse today — surfaced as a chip per row so
  // the dispatcher/warehouse don't assign fresh orders to a rider already gone.
  const departuresQ = useAsync(() => listDeparturesToday(), []);

  useFocusEffect(
    useCallback(() => {
      ordersQ.reload();
      departuresQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const rows = useMemo(() => ordersQ.data ?? [], [ordersQ.data]);
  const agents = useMemo(() => groupByAgent(rows), [rows]);
  const clientRollup = useMemo(() => aggregateByClientProduct(rows), [rows]);
  const departures = useMemo(
    () => departuresQ.data ?? new Map<string, string>(),
    [departuresQ.data],
  );

  const totalOrders = rows.length;
  const subtitle =
    totalOrders === 0
      ? 'Nothing available right now'
      : `${totalOrders} ${totalOrders === 1 ? 'order' : 'orders'} · ${agents.length} ${
          agents.length === 1 ? 'agent' : 'agents'
        }`;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Available orders" subtitle={subtitle} onBack={() => router.back()} />

      {ordersQ.error ? (
        <Empty icon="alert" title="Could not load" sub={ordersQ.error} />
      ) : ordersQ.loading && !ordersQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(a) => a.agent_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={ordersQ.loading && !!ordersQ.data}
              onRefresh={ordersQ.reload}
              tintColor={colors.black}
            />
          }
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 12 }}>
              {clientRollup.length > 0 ? (
                <>
                  <Text style={kicker}>Total to pull today</Text>
                  <Card>
                    <View style={{ gap: 14 }}>
                      {clientRollup.map((c, idx) => (
                        <ClientBlock key={c.client_id} group={c} divider={idx > 0} />
                      ))}
                    </View>
                  </Card>
                </>
              ) : null}
              {agents.length > 0 ? <Text style={kicker}>By agent</Text> : null}
            </View>
          }
          renderItem={({ item }) => (
            <AgentRow
              group={item}
              departedAt={departures.get(item.agent_id) ?? null}
              onPress={() =>
                router.push(
                  `${basePath}/available/${item.agent_id}` as `${AvailableBasePath}/available/${string}`,
                )
              }
            />
          )}
          ListEmptyComponent={
            <Empty
              icon="truck"
              title="No available orders"
              sub="No agent has a confirmed-going order today. New orders show up here as agents confirm with customers."
            />
          }
        />
      )}
    </View>
  );
}

function ClientBlock({ group, divider }: { group: ClientAggregate; divider: boolean }) {
  return (
    <View
      style={
        divider
          ? { paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border, gap: 8 }
          : { gap: 8 }
      }
    >
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 12,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: colors.textSecondary,
        }}
      >
        {group.client_name}
      </Text>
      <View style={{ gap: 6 }}>
        {group.products.map((p) => (
          <View
            key={p.product_catalog_id}
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text
              style={{
                fontFamily: fonts.semibold,
                fontSize: 14,
                color: colors.black,
                flex: 1,
                marginRight: 8,
              }}
              numberOfLines={1}
            >
              {p.product_name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 16,
                color: colors.black,
                letterSpacing: -0.3,
              }}
            >
              {p.qty_needed}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function AgentRow({
  group,
  departedAt,
  onPress,
}: {
  group: AgentGroup;
  departedAt: string | null;
  onPress: () => void;
}) {
  const productLine = group.products
    .map((p) => `${p.qty_needed}× ${shortName(p.product_name)}`)
    .join(' · ');
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={{ display_name: group.agent_name }} size={40} />
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <Text
              style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black, flex: 1 }}
              numberOfLines={1}
            >
              {group.agent_name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 14,
                color: colors.black,
                letterSpacing: -0.2,
              }}
            >
              {group.total_orders} {group.total_orders === 1 ? 'order' : 'orders'}
            </Text>
          </View>
          {departedAt ? (
            <View style={{ marginTop: 6 }}>
              <DepartureChip departedAt={departedAt} size="sm" />
            </View>
          ) : null}
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 4,
            }}
            numberOfLines={2}
          >
            {productLine}
          </Text>
        </View>
        <Icon name="chevronRight" size={16} color={colors.textSecondary} />
      </View>
    </Card>
  );
}

function shortName(name: string): string {
  // First two tokens — keeps the per-row product list readable on small screens.
  return name.split(/\s+/).slice(0, 2).join(' ');
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
