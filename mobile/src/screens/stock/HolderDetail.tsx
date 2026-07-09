// Per-holder stock detail. Reached by tapping a HolderCard on the Stock
// Overview. Shows that holder's products with search/filter, prev/next
// arrows to jump between holders, and a history icon that links to the
// existing Movements screen for this holder.
//
// Note on prev/next: v1 uses arrow buttons that `router.replace` to the
// next holder's URL. That works identically on mobile and web. A future
// enhancement could add horizontal swipe-pager UX on mobile only — left
// as tech debt; the codebase doesn't have a carousel primitive yet, and
// the arrow-button flow is keyboard-accessible on web (Tab + Enter).
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { listCurrentStock, type StockMatrixRow } from '@/services/stock';
import { listUsers, isWarehousePlace, type AppUser } from '@/services/users';
import { AppBar, Card, Empty, FilterChips, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { getHolderStats, isLow, isNegative, type HolderStats } from '@/lib/stock-helpers';

type ProductFilter = 'all' | 'low' | 'negative';

export type DetailBasePath = '/(admin)' | '/(dispatcher)' | '/(warehouse)';

export function HolderDetail({
  holderId,
  basePath,
  showMovementsLink = true,
}: {
  holderId: string;
  basePath: DetailBasePath;
  /** Hide the history icon when there's no Movements route under the caller's
   *  base path. Warehouse home doesn't have one wired today, etc. */
  showMovementsLink?: boolean;
}) {
  const router = useRouter();
  const stockQ = useAsync(() => listCurrentStock(), []);
  const usersQ = useAsync(() => listUsers(), []);

  useReloadOnFocus(() => {
    stockQ.reload();
    usersQ.reload();
  });

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProductFilter>('all');

  const rows = useMemo(() => stockQ.data ?? [], [stockQ.data]);
  const orderedHolders = useMemo(
    () => buildOrderedHolderIds(rows, usersQ.data ?? []),
    [rows, usersQ.data],
  );
  const currentIndex = orderedHolders.indexOf(holderId);
  const prevHolderId = currentIndex > 0 ? orderedHolders[currentIndex - 1] : null;
  const nextHolderId =
    currentIndex >= 0 && currentIndex < orderedHolders.length - 1
      ? orderedHolders[currentIndex + 1]
      : null;

  const holder = useMemo(
    () => (usersQ.data ?? []).find((u) => u.id === holderId) ?? null,
    [usersQ.data, holderId],
  );
  const holderRows = useMemo(() => rows.filter((r) => r.user_id === holderId), [rows, holderId]);
  const stats = useMemo<HolderStats>(() => getHolderStats(rows, holderId), [rows, holderId]);

  // Filter the product rows in scope down to what matches search + chip.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return holderRows
      .filter((r) => {
        if (filter === 'low' && !isLow(r.quantity_on_hand)) return false;
        if (filter === 'negative' && !isNegative(r.quantity_on_hand)) return false;
        if (!q) return true;
        return r.product_name.toLowerCase().includes(q) || r.client_name.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Worst-first within visible: negative (most-negative first), then
        // low (smallest first), then healthy (alpha).
        const aBad = isNegative(a.quantity_on_hand) ? -2 : isLow(a.quantity_on_hand) ? -1 : 0;
        const bBad = isNegative(b.quantity_on_hand) ? -2 : isLow(b.quantity_on_hand) ? -1 : 0;
        if (aBad !== bBad) return aBad - bBad;
        if (aBad < 0) return a.quantity_on_hand - b.quantity_on_hand;
        return a.product_name.localeCompare(b.product_name);
      });
  }, [holderRows, query, filter]);

  const loading = stockQ.loading || usersQ.loading;
  const error = stockQ.error || usersQ.error;

  const goPrev = () => {
    if (!prevHolderId) return;
    router.replace({
      pathname: holderRoute(basePath),
      params: { holderId: prevHolderId },
    });
  };
  const goNext = () => {
    if (!nextHolderId) return;
    router.replace({
      pathname: holderRoute(basePath),
      params: { holderId: nextHolderId },
    });
  };

  const subtitle = holder
    ? `${roleLabel(holder.role)}${holder.email ? ` · ${holder.email}` : ''}`
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title={holder?.display_name ?? 'Holder'}
        subtitle={subtitle}
        onBack={() => router.back()}
        right={
          showMovementsLink && holder ? (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: movementsRoute(basePath),
                  params: { holderId },
                })
              }
              hitSlop={8}
            >
              <Icon name="history" size={22} color={colors.black} />
            </Pressable>
          ) : null
        }
      />

      {/* Prev / Next nav strip — only render when there's > 1 holder
          available. On warehouse with 1 holder visible, this is empty. */}
      {orderedHolders.length > 1 ? (
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colors.white,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Pressable
            onPress={goPrev}
            disabled={!prevHolderId}
            style={{ opacity: prevHolderId ? 1 : 0.3, padding: 4 }}
            hitSlop={8}
          >
            <Icon name="chevronLeft" size={22} color={colors.black} />
          </Pressable>
          <Text
            style={{
              flex: 1,
              textAlign: 'center',
              fontFamily: fonts.semibold,
              fontSize: 11,
              color: colors.textSecondary,
              letterSpacing: 0.6,
            }}
          >
            {currentIndex + 1} of {orderedHolders.length}
          </Text>
          <Pressable
            onPress={goNext}
            disabled={!nextHolderId}
            style={{ opacity: nextHolderId ? 1 : 0.3, padding: 4 }}
            hitSlop={8}
          >
            <Icon name="chevronRight" size={22} color={colors.black} />
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={visibleRows}
        keyExtractor={(r) => `${r.user_id}:${r.product_catalog_id}`}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 12 }}>
            {/* Mini stats strip — 4 cells, same layout idiom as admin
                home, scoped to this holder. */}
            <Card style={{ padding: 14 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 18 }}>
                <Stat label="Units" value={stats.totalUnits} />
                <Stat label="Products" value={stats.productCount} />
                <Stat label="Low" value={stats.lowCount} tone="warning" />
                <Stat label="Negative" value={stats.negativeCount} tone="red" />
              </View>
            </Card>
            <Input
              icon="search"
              value={query}
              onChange={setQuery}
              placeholder="Search products or clients"
              autoCorrect={false}
              autoCapitalize="none"
            />
            <FilterChips<ProductFilter>
              value={filter}
              options={[
                { id: 'all', label: 'All', count: holderRows.length },
                { id: 'low', label: 'Low', count: stats.lowCount },
                { id: 'negative', label: 'Negative', count: stats.negativeCount },
              ]}
              onChange={setFilter}
            />
          </View>
        }
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading && !stockQ.data ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : query || filter !== 'all' ? (
            <Empty icon="search" title="No matches" sub="Try clearing the search or filter." />
          ) : (
            <Empty
              icon="package"
              title="No stock on hand"
              sub="Receives, transfers, and corrections will land here."
            />
          )
        }
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16 }}>
            <ProductRow row={item} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={loading && !!stockQ.data}
            onRefresh={() => {
              stockQ.reload();
              usersQ.reload();
            }}
            tintColor={colors.black}
          />
        }
        ListHeaderComponentStyle={{ marginBottom: 8 }}
      />
    </View>
  );
}

// --- Stat cell ---------------------------------------------------------------

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warning' | 'red';
}) {
  const color =
    tone === 'red' && value > 0
      ? colors.red
      : tone === 'warning' && value > 0
        ? colors.warningDark
        : colors.black;
  return (
    <View style={{ minWidth: 60 }}>
      <Text
        style={{
          fontFamily: fonts.bold,
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
          fontSize: 22,
          letterSpacing: -0.4,
          color,
          marginTop: 2,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

// --- Product row -------------------------------------------------------------

function ProductRow({ row }: { row: StockMatrixRow }) {
  const negative = isNegative(row.quantity_on_hand);
  const low = isLow(row.quantity_on_hand);
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {row.product_name}
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
            {row.client_name}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: fonts.extrabold,
            fontSize: 20,
            letterSpacing: -0.4,
            color: negative ? colors.red : low ? colors.warningDark : colors.black,
          }}
        >
          {row.quantity_on_hand}
        </Text>
      </View>
    </Card>
  );
}

// --- Builders / utilities ----------------------------------------------------

function roleLabel(role: string): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'dispatcher':
      return 'Dispatcher';
    case 'rep':
      return 'Rep';
    case 'agent':
      return 'Agent';
    case 'warehouse':
      return 'Warehouse';
    default:
      return role;
  }
}

function holderRoute(basePath: DetailBasePath) {
  if (basePath === '/(warehouse)') return '/(warehouse)/holder/[holderId]' as const;
  if (basePath === '/(admin)') return '/(admin)/stock/holder/[holderId]' as const;
  return '/(dispatcher)/stock/holder/[holderId]' as const;
}

function movementsRoute(basePath: DetailBasePath) {
  if (basePath === '/(warehouse)') return '/(warehouse)/movements/[holderId]' as const;
  if (basePath === '/(admin)') return '/(admin)/stock/movements/[holderId]' as const;
  return '/(dispatcher)/stock/movements/[holderId]' as const;
}

/** Ordered list of holder ids the prev/next arrows step through. Must mirror
 *  the Overview list (buildHolders): seed active warehouse PLACES + active
 *  agents (so zero-stock agents are in the sequence too), plus any other holder
 *  that appears in the stock matrix; sort warehouses first, then holders-with-
 *  stock above cleared-out empties, alpha within each. `withStock` keys off
 *  appearing in `rows` (which are non-zero by construction) — equivalent to
 *  buildHolders' `productCount > 0`. */
function buildOrderedHolderIds(rows: StockMatrixRow[], users: AppUser[]): string[] {
  const withStock = new Set(rows.map((r) => r.user_id));
  const byId = new Map<string, { id: string; name: string; isWarehouse: boolean }>();

  for (const u of users) {
    if (!u.is_active) continue;
    if (!(isWarehousePlace(u) || u.role === 'agent')) continue;
    byId.set(u.id, { id: u.id, name: u.display_name, isWarehouse: isWarehousePlace(u) });
  }
  for (const r of rows) {
    if (byId.has(r.user_id)) continue;
    byId.set(r.user_id, {
      id: r.user_id,
      name: r.user_display_name,
      isWarehouse: r.user_role === 'warehouse',
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      if (a.isWarehouse !== b.isWarehouse) return a.isWarehouse ? -1 : 1;
      const aHas = withStock.has(a.id);
      const bHas = withStock.has(b.id);
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((h) => h.id);
}
