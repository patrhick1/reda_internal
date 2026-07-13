// Warehouse-facing read-only view of stock currently held by agents. This is a
// narrower companion to the admin/dispatcher Stock Overview: warehouse staff can
// answer "who has this stock?" without getting the full ops stock dashboard.
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { listCurrentStock, type StockMatrixRow } from '@/services/stock';
import { listUsers, type AppUser } from '@/services/users';
import { AppBar, Avatar, Card, Empty, FilterChips, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { getHolderStats, type HolderStats } from '@/lib/stock-helpers';

type AgentFilter = 'all' | 'low' | 'negative';

type AgentHolder = {
  user_id: string;
  display_name: string;
  email: string;
  stats: HolderStats;
};

export function AgentStockList() {
  const router = useRouter();
  const stockQ = useAsync(() => listCurrentStock(), []);
  const usersQ = useAsync(() => listUsers(), []);

  useReloadOnFocus(() => {
    stockQ.reload();
    usersQ.reload();
  });

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AgentFilter>('all');

  const rows = useMemo(() => stockQ.data ?? [], [stockQ.data]);
  const agents = useMemo(() => buildAgentHolders(rows, usersQ.data ?? []), [rows, usersQ.data]);
  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter === 'low' && a.stats.lowCount === 0) return false;
      if (filter === 'negative' && a.stats.negativeCount === 0) return false;
      if (!q) return true;
      if (a.display_name.toLowerCase().includes(q)) return true;
      return rows.some(
        (r) =>
          r.user_id === a.user_id &&
          (r.product_name.toLowerCase().includes(q) || r.client_name.toLowerCase().includes(q)),
      );
    });
  }, [agents, filter, query, rows]);

  const totals = useMemo(() => {
    let units = 0;
    let withStock = 0;
    let low = 0;
    let negative = 0;
    for (const a of agents) {
      units += a.stats.totalUnits;
      if (a.stats.productCount > 0) withStock++;
      if (a.stats.lowCount > 0) low++;
      if (a.stats.negativeCount > 0) negative++;
    }
    return { units, withStock, low, negative };
  }, [agents]);

  const loading = stockQ.loading || usersQ.loading;
  const error = stockQ.error || usersQ.error;
  const reload = () => {
    stockQ.reload();
    usersQ.reload();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Agent stock"
        subtitle="Stock currently with riders"
        onBack={() => router.back()}
      />
      {error ? (
        <Empty icon="alert" title="Could not load" sub={error} />
      ) : loading && !stockQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : (
        <FlatList
          data={visibleAgents}
          keyExtractor={(a) => a.user_id}
          ListHeaderComponent={
            <View style={{ padding: 16, paddingBottom: 8, gap: 12 }}>
              <Card style={{ backgroundColor: colors.black, padding: 18 }}>
                <Text style={kicker('dark')}>With agents</Text>
                <Text
                  style={{
                    fontFamily: fonts.extrabold,
                    fontSize: 32,
                    color: colors.white,
                    letterSpacing: -0.8,
                    marginTop: 4,
                  }}
                >
                  {totals.units}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textTertiary,
                    marginTop: 4,
                  }}
                >
                  {totals.withStock} {totals.withStock === 1 ? 'agent' : 'agents'} currently hold
                  stock
                </Text>
              </Card>
              <Input
                icon="search"
                value={query}
                onChange={setQuery}
                placeholder="Search agents, products, or clients"
                autoCorrect={false}
                autoCapitalize="none"
              />
              <FilterChips<AgentFilter>
                value={filter}
                options={[
                  { id: 'all', label: 'All', count: agents.length },
                  { id: 'low', label: 'Low', count: totals.low },
                  { id: 'negative', label: 'Negative', count: totals.negative },
                ]}
                onChange={setFilter}
              />
            </View>
          }
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 16 }}>
              <AgentCard
                agent={item}
                onPress={() =>
                  router.push({
                    pathname: '/(warehouse)/holder/[holderId]',
                    params: { holderId: item.user_id },
                  })
                }
              />
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          ListEmptyComponent={
            query || filter !== 'all' ? (
              <Empty icon="search" title="No matches" sub="Try clearing the search or filter." />
            ) : (
              <Empty icon="user" title="No agents" sub="Active agents will appear here." />
            )
          }
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={loading && !!stockQ.data}
              onRefresh={reload}
              tintColor={colors.black}
            />
          }
        />
      )}
    </View>
  );
}

function AgentCard({ agent, onPress }: { agent: AgentHolder; onPress: () => void }) {
  const { stats } = agent;
  const out = stats.productCount === 0;
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={{ display_name: agent.display_name }} size={40} />
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {agent.display_name}
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
            {out
              ? 'No stock currently held'
              : `${stats.productCount} ${stats.productCount === 1 ? 'product' : 'products'}${stats.lowCount > 0 ? ` · ${stats.lowCount} low` : ''}${stats.negativeCount > 0 ? ` · ${stats.negativeCount} negative` : ''}`}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 22,
              letterSpacing: -0.5,
              color: stats.negativeCount > 0 ? colors.red : colors.black,
            }}
          >
            {stats.totalUnits}
          </Text>
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 10,
              color: colors.textSecondary,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            units
          </Text>
        </View>
        <Icon name="chevronRight" size={18} color={colors.textTertiary} />
      </View>
    </Card>
  );
}

function buildAgentHolders(rows: StockMatrixRow[], users: AppUser[]): AgentHolder[] {
  const map = new Map<string, AgentHolder>();
  for (const u of users) {
    if (u.is_active && u.role === 'agent') {
      map.set(u.id, {
        user_id: u.id,
        display_name: u.display_name,
        email: u.email,
        stats: getHolderStats(rows, u.id),
      });
    }
  }
  for (const r of rows) {
    if (r.user_role !== 'agent' || map.has(r.user_id)) continue;
    map.set(r.user_id, {
      user_id: r.user_id,
      display_name: r.user_display_name,
      email: r.user_email,
      stats: getHolderStats(rows, r.user_id),
    });
  }
  return Array.from(map.values()).sort((a, b) => {
    const aHas = a.stats.productCount > 0;
    const bHas = b.stats.productCount > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

function kicker(theme: 'light' | 'dark' = 'light') {
  return {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: theme === 'dark' ? colors.textTertiary : colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  };
}
