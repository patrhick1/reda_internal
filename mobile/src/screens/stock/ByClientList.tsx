// Shared read-only "Stock by client" list — the per-vendor roll-up of the full
// stock matrix (warehouse + agents), mirroring the StockOverview "By client"
// tab. Surfaced to the warehouse app so warehouse staff can see how much of each
// vendor's product is in the system before pulling more out (Uzo, 2026-06-22).
//
// Data access is already in place: current_stock is readable across all holders
// (the view isn't security_invoker), and warehouse can read clients (the
// is_warehouse RLS policy), so the warehouse-vs-agents split is complete for
// them. basePath is the route group the per-client detail lives under — only the
// warehouse uses this today; admin/dispatcher get the same data via the
// StockOverview "By client" tab.
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import {
  groupByClient,
  mergeClientsWithStockGroups,
  type ClientStockGroup,
} from '@/services/stock';
import { useClients, useStockMatrix } from '@/hooks/queries';
import { AppBar, Empty } from '@/components/ui';
import { ClientStockCard } from '@/components/stock/ClientStockCard';
import { colors } from '@/lib/theme';

export type ByClientBasePath = '/(warehouse)';

export function StockByClientList({ basePath }: { basePath: ByClientBasePath }) {
  const router = useRouter();
  // [Egress Phase 3] Cached global matrix, shared with Stock Overview + the
  // Agent-stock list (one fetch across all three) instead of its own full pull.
  const stockQ = useStockMatrix();
  const clientsQ = useClients();

  useReloadOnFocus(() => {
    stockQ.refetchIfStale();
    clientsQ.reload();
  });

  // Merge every active client over the stock groups so "do we have any Decency?"
  // resolves to an explicit "Nothing in stock" card rather than a missing row.
  const groups = useMemo<ClientStockGroup[]>(
    () => mergeClientsWithStockGroups(groupByClient(stockQ.data ?? []), clientsQ.data ?? []),
    [stockQ.data, clientsQ.data],
  );

  const loading = stockQ.loading || clientsQ.loading;
  const error = stockQ.error || clientsQ.error;
  const reload = () => {
    stockQ.reload();
    clientsQ.reload();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Stock by client" onBack={() => router.back()} />
      {error ? (
        <Empty icon="alert" title="Could not load" sub={error} />
      ) : loading && !stockQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : (
        <FlatList
          data={groups}
          keyExtractor={(c) => c.client_id}
          renderItem={({ item }) => (
            <ClientStockCard
              group={item}
              onPress={() =>
                router.push(
                  `${basePath}/by-client/${item.client_id}` as `${ByClientBasePath}/by-client/${string}`,
                )
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={stockQ.fetching && !!stockQ.data}
              onRefresh={reload}
              tintColor={colors.black}
            />
          }
          ListEmptyComponent={
            <Empty
              icon="package"
              title="No clients yet"
              sub="Add a client in Catalog before recording stock."
            />
          }
        />
      )}
    </View>
  );
}
