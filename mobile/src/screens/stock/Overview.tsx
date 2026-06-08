// Shared stock overview screen — admin and dispatcher both render this via
// thin route wrappers. Redesigned to lead with hero stats + search + filter
// chips, list one entity-card per holder, and demote the three write CTAs
// (Receive / Transfer / Adjust) to a compact row + overflow sheet so most
// of the viewport belongs to the data instead of the toolbar.
//
// Permissions: action buttons are gated through the same helpers as before
// (canReceiveStock / canDoWarehouseTransfer / canAdjustAnyStock /
// canAdjustOwnStock). Dispatcher remains Transfer-only by design — the
// (dispatcher)/stock/_layout.tsx comment is authoritative on why.
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  listCurrentStock,
  groupByClient,
  type StockMatrixRow,
  type ClientStockGroup,
} from '@/services/stock';
import { listClients, type Client } from '@/services/clients';
import { listUsers, isWarehousePlace, type AppUser } from '@/services/users';
import {
  AppBar,
  Avatar,
  Button,
  Card,
  Empty,
  FilterChips,
  Icon,
  Input,
  Sheet,
  Tabs,
} from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import {
  canReceiveStock,
  canDoWarehouseTransfer,
  canTransferAgentToAgent,
  canAdjustAnyStock,
  canAdjustOwnStock,
} from '@/lib/permissions';
import { getHolderStats, getOverviewStats, type HolderStats } from '@/lib/stock-helpers';
import { useBreakpoint } from '@/lib/useBreakpoint';

type Tab = 'holder' | 'client';
type HolderFilter = 'all' | 'low' | 'negative';

type Holder = {
  user_id: string;
  display_name: string;
  role: string;
  email: string;
  isWarehouse: boolean;
  stats: HolderStats;
};

export type StockBasePath = '/(admin)' | '/(dispatcher)';

export function StockOverview({ basePath }: { basePath: StockBasePath }) {
  const router = useRouter();
  const user = useCurrentUser();
  const stockQ = useAsync(() => listCurrentStock(), []);
  const usersQ = useAsync(() => listUsers(), []);
  const clientsQ = useAsync<Client[]>(() => listClients(), []);

  useFocusEffect(
    useCallback(() => {
      stockQ.reload();
      usersQ.reload();
      clientsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const [tab, setTab] = useState<Tab>('holder');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HolderFilter>('all');
  const [overflowOpen, setOverflowOpen] = useState(false);

  const rows = useMemo(() => stockQ.data ?? [], [stockQ.data]);
  // Holder list seeded from warehouse PLACES so empty warehouses still
  // appear as cards (they're operationally important even at zero stock).
  // Warehouse STAFF (warehouse_id set) hold no stock — they act on a
  // place's books — so they must not show up as their own cards.
  const warehouseUsers = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.is_active && isWarehousePlace(u)),
    [usersQ.data],
  );

  const allHolders = useMemo<Holder[]>(
    () => buildHolders(rows, warehouseUsers),
    [rows, warehouseUsers],
  );

  // Overview-wide aggregate stats for the hero card.
  const overviewStats = useMemo(() => getOverviewStats(rows), [rows]);

  // Apply search query + filter chip to derive the visible holder set.
  const visibleHolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allHolders.filter((h) => {
      if (filter === 'low' && h.stats.lowCount === 0) return false;
      if (filter === 'negative' && h.stats.negativeCount === 0) return false;
      if (!q) return true;
      // Match holder name OR any of their top problem product names OR any
      // of their actual stock rows. Last covers "Pureflow" jumping to any
      // holder with a Pureflow row even if it's not a problem.
      if (h.display_name.toLowerCase().includes(q)) return true;
      if (h.stats.topProblems.some((p) => p.product_name.toLowerCase().includes(q))) return true;
      return rows.some((r) => r.user_id === h.user_id && r.product_name.toLowerCase().includes(q));
    });
  }, [allHolders, query, filter, rows]);

  const clientGroups = useMemo<ClientStockGroup[]>(
    () => mergeClientsWithStockGroups(groupByClient(rows), clientsQ.data ?? []),
    [rows, clientsQ.data],
  );

  const loading = stockQ.loading || usersQ.loading || clientsQ.loading;
  const error = stockQ.error || usersQ.error || clientsQ.error;
  const reload = () => {
    stockQ.reload();
    usersQ.reload();
    clientsQ.reload();
  };

  const showReceive = canReceiveStock(user.role);
  const showTransfer = canDoWarehouseTransfer(user.role) || canTransferAgentToAgent(user.role);
  const showAdjust = canAdjustAnyStock(user.role) || canAdjustOwnStock(user.role);
  // Overflow sheet only meaningful if there's ≥2 actions OR a non-transfer
  // action that wouldn't fit beside the primary Transfer button.
  const showOverflow = showReceive || showAdjust;

  // Responsive: 1-col on phones, 2 on tablets/narrow web, 3 on full web.
  // Key swap is required when numColumns changes on a FlatList (RN rule).
  const breakpoint = useBreakpoint();
  const numColumns = breakpoint === 'lg' ? 3 : breakpoint === 'md' ? 2 : 1;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Stock" onBack={() => router.back()} helpTopic="stock" />

      {/* Hero stats — replaces the "19 holders" subtitle with something
          actionable. Tapping LOW / NEGATIVE sets the filter so users can
          drill from the aggregate to the affected holders in one tap. */}
      <View style={{ padding: 16, paddingBottom: 8 }}>
        <HeroStatsCard
          stats={overviewStats}
          holderCount={allHolders.length}
          onTapLow={() => setFilter((f) => (f === 'low' ? 'all' : 'low'))}
          onTapNegative={() => setFilter((f) => (f === 'negative' ? 'all' : 'negative'))}
        />
      </View>

      {/* Search + action row. Transfer is primary (most-used). Overflow `+`
          opens a sheet with Receive + Adjust (each gated separately). */}
      <View
        style={{
          paddingHorizontal: 16,
          paddingBottom: 12,
          flexDirection: 'row',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        <View style={{ flex: 1 }}>
          <Input
            icon="search"
            value={query}
            onChange={setQuery}
            placeholder="Search products or holders"
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>
        {showTransfer ? (
          <View style={{ marginTop: 2 }}>
            <Button
              variant="primary"
              icon="arrowRight"
              onPress={() =>
                router.push(`${basePath}/stock/transfer` as `${StockBasePath}/stock/transfer`)
              }
            >
              Transfer
            </Button>
          </View>
        ) : null}
        {showOverflow ? (
          <View style={{ marginTop: 2 }}>
            <Button
              variant="secondary"
              icon="plus"
              onPress={() => setOverflowOpen(true)}
              accessibilityLabel="More stock actions"
            >
              {''}
            </Button>
          </View>
        ) : null}
      </View>

      <Tabs<Tab>
        value={tab}
        tabs={[
          { id: 'holder', label: 'By holder' },
          { id: 'client', label: 'By client' },
        ]}
        onChange={setTab}
      />

      {tab === 'holder' ? (
        <FilterChips<HolderFilter>
          value={filter}
          options={[
            { id: 'all', label: 'All', count: allHolders.length },
            { id: 'low', label: 'Low', count: overviewStats.lowHolderCount },
            { id: 'negative', label: 'Negative', count: overviewStats.negativeHolderCount },
          ]}
          onChange={setFilter}
        />
      ) : null}

      {error ? (
        <Empty icon="alert" title="Could not load" sub={error} />
      ) : loading && !stockQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : tab === 'holder' ? (
        visibleHolders.length === 0 ? (
          <Empty
            icon={query || filter !== 'all' ? 'search' : 'warehouse'}
            title={query || filter !== 'all' ? 'No matches' : 'No stock anywhere'}
            sub={
              query || filter !== 'all'
                ? 'Try clearing the search or filter.'
                : showReceive
                  ? "Tap '+' above to record a Receive — that's the usual starting point."
                  : 'No stock is being held by any warehouse or agent right now.'
            }
          />
        ) : (
          <FlatList
            // key swap so RN re-mounts the list when column count changes
            key={`holder-grid-${numColumns}`}
            data={visibleHolders}
            keyExtractor={(h) => h.user_id}
            numColumns={numColumns}
            renderItem={({ item }) => (
              <View style={{ flex: 1, paddingHorizontal: 6 }}>
                <HolderCard
                  holder={item}
                  onPress={() =>
                    router.push({
                      pathname: `${basePath}/stock/holder/[holderId]` as const,
                      params: { holderId: item.user_id },
                    })
                  }
                />
              </View>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            columnWrapperStyle={numColumns > 1 ? { paddingHorizontal: 10 } : undefined}
            contentContainerStyle={{
              paddingHorizontal: numColumns > 1 ? 0 : 16,
              paddingBottom: 32,
            }}
            refreshControl={
              <RefreshControl
                refreshing={loading && !!stockQ.data}
                onRefresh={reload}
                tintColor={colors.black}
              />
            }
          />
        )
      ) : clientGroups.length === 0 ? (
        <Empty
          icon="package"
          title="No clients yet"
          sub="Add a client in Catalog before recording stock."
        />
      ) : (
        <FlatList
          data={clientGroups}
          keyExtractor={(c) => c.client_id}
          renderItem={({ item }) => (
            <ClientCard
              group={item}
              onPress={() =>
                router.push(
                  `${basePath}/stock/client/${item.client_id}` as `${StockBasePath}/stock/client/${string}`,
                )
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={loading && !!stockQ.data}
              onRefresh={reload}
              tintColor={colors.black}
            />
          }
        />
      )}

      {/* Overflow sheet — Receive + Adjustment. Each row only renders when
          its permission helper returns true so the sheet is empty-safe. */}
      <Sheet open={overflowOpen} onClose={() => setOverflowOpen(false)} title="More actions">
        <View style={{ gap: 8 }}>
          {showReceive ? (
            <ActionRow
              icon="arrowDown"
              label="Receive stock"
              sub="Record a vendor intake into the warehouse"
              onPress={() => {
                setOverflowOpen(false);
                router.push(`${basePath}/stock/receive` as `${StockBasePath}/stock/receive`);
              }}
            />
          ) : null}
          {showAdjust ? (
            <ActionRow
              icon="edit"
              label="Adjustment"
              sub="Correction, loss, theft, damaged, or found"
              onPress={() => {
                setOverflowOpen(false);
                router.push(`${basePath}/stock/adjust` as `${StockBasePath}/stock/adjust`);
              }}
            />
          ) : null}
        </View>
      </Sheet>
    </View>
  );
}

// --- Hero card ---------------------------------------------------------------

function HeroStatsCard({
  stats,
  holderCount,
  onTapLow,
  onTapNegative,
}: {
  stats: ReturnType<typeof getOverviewStats>;
  holderCount: number;
  onTapLow: () => void;
  onTapNegative: () => void;
}) {
  return (
    <Card style={{ backgroundColor: colors.black, padding: 18 }}>
      <Text style={kicker('dark')}>Stock</Text>
      <View
        style={{
          marginTop: 12,
          flexDirection: 'row',
          borderRadius: 10,
          overflow: 'hidden',
          backgroundColor: '#222',
          gap: 1,
        }}
      >
        <HeroStat label="Units" value={formatNumber(stats.totalUnits)} accent={colors.white} />
        <HeroStat
          label="Low"
          value={String(stats.lowCount)}
          accent={colors.warning}
          onPress={onTapLow}
        />
        <HeroStat
          label="Negative"
          value={String(stats.negativeCount)}
          accent={colors.red}
          onPress={onTapNegative}
        />
      </View>
      <View style={{ marginTop: 14, flexDirection: 'row', gap: 18, paddingHorizontal: 2 }}>
        <BreakdownItem label="Holders" value={holderCount} />
      </View>
    </Card>
  );
}

function HeroStat({
  label,
  value,
  accent,
  onPress,
}: {
  label: string;
  value: string;
  accent: string;
  onPress?: () => void;
}) {
  const inner = (
    <View
      style={{ flex: 1, backgroundColor: colors.black, paddingHorizontal: 12, paddingVertical: 14 }}
    >
      <Text style={kicker('dark', 'sm')}>{label}</Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 26,
          color: accent,
          marginTop: 4,
          letterSpacing: -0.4,
        }}
      >
        {value}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.85 : 1 })}
    >
      {inner}
    </Pressable>
  ) : (
    inner
  );
}

function BreakdownItem({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 10,
          color: colors.textTertiary,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.white }}>{value}</Text>
    </View>
  );
}

// --- Holder card -------------------------------------------------------------

function HolderCard({ holder, onPress }: { holder: Holder; onPress: () => void }) {
  const { stats } = holder;
  const out = stats.totalUnits === 0 && stats.productCount === 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {holder.isWarehouse ? (
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                backgroundColor: colors.black,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="warehouse" size={20} color={colors.white} />
            </View>
          ) : (
            <Avatar user={{ display_name: holder.display_name }} size={40} />
          )}
          <View style={{ flex: 1 }}>
            <Text
              style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}
              numberOfLines={1}
            >
              {holder.display_name}
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
                : `${stats.productCount} ${stats.productCount === 1 ? 'product' : 'products'} · ${stats.lowCount} low${stats.negativeCount > 0 ? ` · ${stats.negativeCount} negative` : ''}`}
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
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </View>
        {/* Needs-attention strip — only render when there's something to flag,
            keeps healthy cards visually tight. Pills sorted most-negative
            first via the helper. */}
        {stats.topProblems.length > 0 ? (
          <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {stats.topProblems.map((p) => (
              <ProblemChip
                key={p.product_catalog_id}
                qty={p.quantity_on_hand}
                name={p.product_name}
              />
            ))}
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

function ProblemChip({ qty, name }: { qty: number; name: string }) {
  const negative = qty < 0;
  const shortName = name.split(/\s+/).slice(0, 2).join(' ');
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        backgroundColor: negative ? colors.redSoft : colors.warningSoft,
        borderColor: negative ? '#FCA5A5' : '#FCD34D',
      }}
    >
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 11,
          color: negative ? colors.red : colors.warningDark,
        }}
      >
        {shortName}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 11,
          color: negative ? colors.red : colors.warningDark,
        }}
      >
        {qty}
      </Text>
    </View>
  );
}

// --- Action row (used inside the overflow Sheet) ----------------------------

function ActionRow({
  icon,
  label,
  sub,
  onPress,
}: {
  icon: 'arrowDown' | 'edit';
  label: string;
  sub: string;
  onPress: () => void;
}) {
  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={icon} size={18} color={colors.black} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>{label}</Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {sub}
          </Text>
        </View>
        <Icon name="chevronRight" size={18} color={colors.textTertiary} />
      </View>
    </Card>
  );
}

// --- Client card (unchanged, kept for the "By client" tab) ------------------

function ClientCard({ group, onPress }: { group: ClientStockGroup; onPress: () => void }) {
  const out = group.total_qty === 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
              {group.client_name}
            </Text>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 2,
              }}
            >
              {out
                ? 'Nothing in stock right now'
                : `${group.products_count} ${group.products_count === 1 ? 'product' : 'products'} · ${group.warehouse_qty} warehouse · ${group.agents_qty} with agents`}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 20,
                letterSpacing: -0.5,
                color: out ? colors.red : colors.black,
              }}
            >
              {group.total_qty}
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
              total
            </Text>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </View>
      </Card>
    </Pressable>
  );
}

// --- Builders / utilities ----------------------------------------------------

/** Build the holder list — one entry per holder seen in the stock matrix,
 *  plus every active warehouse PLACE so empty warehouses still surface. */
function buildHolders(rows: StockMatrixRow[], warehouseUsers: AppUser[]): Holder[] {
  const map = new Map<string, Holder>();

  for (const w of warehouseUsers) {
    map.set(w.id, {
      user_id: w.id,
      display_name: w.display_name,
      role: w.role,
      email: w.email,
      isWarehouse: true,
      stats: getHolderStats(rows, w.id),
    });
  }

  for (const r of rows) {
    if (map.has(r.user_id)) continue;
    map.set(r.user_id, {
      user_id: r.user_id,
      display_name: r.user_display_name,
      role: r.user_role,
      email: r.user_email,
      isWarehouse: r.user_role === 'warehouse',
      stats: getHolderStats(rows, r.user_id),
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.isWarehouse && !b.isWarehouse) return -1;
    if (b.isWarehouse && !a.isWarehouse) return 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

function mergeClientsWithStockGroups(
  stockGroups: ClientStockGroup[],
  clients: Client[],
): ClientStockGroup[] {
  const byId = new Map(stockGroups.map((g) => [g.client_id, g]));
  for (const c of clients) {
    if (byId.has(c.id)) continue;
    byId.set(c.id, {
      client_id: c.id,
      client_name: c.name,
      products: [],
      total_qty: 0,
      warehouse_qty: 0,
      agents_qty: 0,
      products_count: 0,
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.client_name.localeCompare(b.client_name));
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function kicker(theme: 'light' | 'dark' = 'light', size: 'sm' | 'md' = 'md') {
  return {
    fontFamily: fonts.bold,
    fontSize: size === 'sm' ? 10 : 11,
    color: theme === 'dark' ? colors.textTertiary : colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  };
}
