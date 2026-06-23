// Warehouse home — the staff-facing stock dashboard for the warehouse
// place they act on (via auth.users.warehouse_id) or themselves if they
// ARE the place. Redesigned 2026-06-08 to match the admin/dispatcher
// Overview pattern: hero stats + search + filter chips + a flat product
// list, with the three write CTAs (Receive / Transfer / Adjust) demoted
// to a compact row + overflow sheet. The Available orders card is kept
// because warehouse staff plan their day around it.
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listCurrentStock, type StockMatrixRow } from '@/services/stock';
import { listAvailableOrders } from '@/services/available-orders';
import { AppBar, Button, Card, Empty, FilterChips, Icon, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { canAdjustOwnStock, canDoWarehouseTransfer, canReceiveStock } from '@/lib/permissions';
import { getHolderStats, isLow, isNegative } from '@/lib/stock-helpers';

type ProductFilter = 'all' | 'low' | 'negative';

export default function WarehouseHome() {
  const router = useRouter();
  const user = useCurrentUser();
  const stockQ = useAsync(() => listCurrentStock(), []);
  const availableQ = useAsync(() => listAvailableOrders(), []);

  useFocusEffect(
    useCallback(() => {
      stockQ.reload();
      availableQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ProductFilter>('all');
  const [overflowOpen, setOverflowOpen] = useState(false);

  // The holder = the warehouse PLACE this staff member acts on. For a staff
  // user that IS the place, warehouseId is null and we fall back to userId.
  // NOTE: current_stock is NOT row-restricted to this place — the view isn't
  // security_invoker, so it returns the full matrix to any authenticated user.
  // The scoping below (holderRows) is purely client-side: this home shows only
  // the place's own stock. The cross-holder view lives on the By-client screen.
  const holderId = user.warehouseId ?? user.userId;

  const allRows = useMemo(() => stockQ.data ?? [], [stockQ.data]);
  const holderRows = useMemo(
    () => allRows.filter((r) => r.user_id === holderId),
    [allRows, holderId],
  );
  const stats = useMemo(() => getHolderStats(allRows, holderId), [allRows, holderId]);

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
        const aBad = isNegative(a.quantity_on_hand) ? -2 : isLow(a.quantity_on_hand) ? -1 : 0;
        const bBad = isNegative(b.quantity_on_hand) ? -2 : isLow(b.quantity_on_hand) ? -1 : 0;
        if (aBad !== bBad) return aBad - bBad;
        if (aBad < 0) return a.quantity_on_hand - b.quantity_on_hand;
        return a.product_name.localeCompare(b.product_name);
      });
  }, [holderRows, query, filter]);

  const showReceive = canReceiveStock(user.role);
  const showTransfer = canDoWarehouseTransfer(user.role);
  const showAdjust = canAdjustOwnStock(user.role);
  const showOverflow = showReceive || showAdjust;

  const availableRows = useMemo(() => availableQ.data ?? [], [availableQ.data]);
  const availableAgents = useMemo(
    () => new Set(availableRows.map((r) => r.agent_id)).size,
    [availableRows],
  );
  const availableUnits = useMemo(
    () => availableRows.reduce((sum, r) => sum + r.quantity_ordered, 0),
    [availableRows],
  );

  const loading = stockQ.loading || availableQ.loading;
  const reload = () => {
    stockQ.reload();
    availableQ.reload();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Stock"
        subtitle={user.displayName}
        helpTopic="receive-stock"
        right={
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/(warehouse)/movements/[holderId]',
                params: { holderId },
              })
            }
            hitSlop={8}
          >
            <Icon name="history" size={22} color={colors.black} />
          </Pressable>
        }
      />

      <FlatList
        data={visibleRows}
        keyExtractor={(r) => `${r.user_id}:${r.product_catalog_id}`}
        ListHeaderComponent={
          <View style={{ padding: 16, paddingBottom: 8, gap: 12 }}>
            {/* Hero stats — scoped to this warehouse. Tap LOW / NEGATIVE
                to filter the product list to just those rows. */}
            <Card style={{ backgroundColor: colors.black, padding: 18 }}>
              <Text style={kicker('dark')}>{(user.displayName ?? 'Warehouse').toUpperCase()}</Text>
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
                <HeroStat label="Units" value={String(stats.totalUnits)} accent={colors.white} />
                <HeroStat
                  label="Low"
                  value={String(stats.lowCount)}
                  accent={colors.warning}
                  onPress={() => setFilter((f) => (f === 'low' ? 'all' : 'low'))}
                />
                <HeroStat
                  label="Negative"
                  value={String(stats.negativeCount)}
                  accent={colors.red}
                  onPress={() => setFilter((f) => (f === 'negative' ? 'all' : 'negative'))}
                />
              </View>
              <Text
                style={{
                  marginTop: 12,
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textTertiary,
                }}
              >
                {stats.productCount} {stats.productCount === 1 ? 'product' : 'products'}
              </Text>
            </Card>

            {/* Search row — full-width input, action buttons below
                right-aligned so the search field doesn't get squeezed
                on phones. */}
            <Input
              icon="search"
              value={query}
              onChange={setQuery}
              placeholder="Search products or clients"
              autoCorrect={false}
              autoCapitalize="none"
            />
            {showTransfer || showOverflow ? (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                {showTransfer ? (
                  <Button
                    variant="primary"
                    size="sm"
                    icon="arrowRight"
                    onPress={() => router.push('/(warehouse)/transfer')}
                  >
                    Transfer
                  </Button>
                ) : null}
                {showOverflow ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="plus"
                    onPress={() => setOverflowOpen(true)}
                    accessibilityLabel="More stock actions"
                  >
                    More
                  </Button>
                ) : null}
              </View>
            ) : null}

            {/* Available orders shortcut — Mary's main planning surface. */}
            <Card dense onPress={() => router.push('/(warehouse)/available')}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="truck" size={18} color={colors.black} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                    Available orders
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    {availableRows.length === 0
                      ? 'Nothing confirmed yet today'
                      : `${availableUnits} ${availableUnits === 1 ? 'unit' : 'units'} across ${availableAgents} ${availableAgents === 1 ? 'agent' : 'agents'}`}
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={colors.textSecondary} />
              </View>
            </Card>

            {/* Agent-stock drilldown — read-only per-rider stock visibility for
                warehouse users. Transfers and returns stay in the Transfer flow. */}
            <Card dense onPress={() => router.push('/(warehouse)/agents')}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="user" size={18} color={colors.black} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                    Agent stock
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    See what each rider has on hand
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={colors.textSecondary} />
              </View>
            </Card>

            {/* Stock-by-client roll-up — how much of each vendor's product is in
                the system (warehouse + agents), to decide what to pull/send. */}
            <Card dense onPress={() => router.push('/(warehouse)/by-client')}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: colors.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="package" size={18} color={colors.black} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                    Stock by client
                  </Text>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    How much of each vendor’s stock is in the system
                  </Text>
                </View>
                <Icon name="chevronRight" size={20} color={colors.textSecondary} />
              </View>
            </Card>

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
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16 }}>
            <ProductRow row={item} />
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        ListEmptyComponent={
          loading && !stockQ.data ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : query || filter !== 'all' ? (
            <Empty icon="search" title="No matches" sub="Try clearing the search or filter." />
          ) : (
            <Empty
              icon="warehouse"
              title="No stock on hand"
              sub="Bulk intakes recorded above will appear here."
            />
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

      <Sheet open={overflowOpen} onClose={() => setOverflowOpen(false)} title="More actions">
        <View style={{ gap: 8 }}>
          {showReceive ? (
            <ActionRow
              icon="arrowDown"
              label="Receive stock"
              sub="Record a vendor intake into the warehouse"
              onPress={() => {
                setOverflowOpen(false);
                router.push('/(warehouse)/receive');
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
                router.push('/(warehouse)/adjust');
              }}
            />
          ) : null}
        </View>
      </Sheet>
    </View>
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

function kicker(theme: 'light' | 'dark' = 'light', size: 'sm' | 'md' = 'md') {
  return {
    fontFamily: fonts.bold,
    fontSize: size === 'sm' ? 10 : 11,
    color: theme === 'dark' ? colors.textTertiary : colors.textSecondary,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
  };
}
