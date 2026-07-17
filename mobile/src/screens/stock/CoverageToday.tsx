// Stock coverage — "can today's open orders actually be fulfilled?" One row
// per product with open (non-terminal) delivery orders today, comparing demand
// against fleet stock (warehouse place + riders) and what's already committed
// (orders the customer confirmed — status available/available_evening).
//
// Reached from the admin "Needs attention" row, the dispatcher dashboard card,
// and the warehouse home strip (basePath keeps back-navigation right for each).
// Agents never see this screen — they get the per-order badge instead.
//
// Same underlying RPC/cache as the badges (useStockCoverage under ['stock']),
// so a receive/transfer or a confirmation refreshes this screen and every
// badge together.
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useStockCoverage } from '@/hooks/queries';
import { fetchCoverageClientNames, type CoverageRow } from '@/services/stock-coverage';
import { AppBar, Card, Empty, FilterChips, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

type CoverageFilter = 'all' | 'short' | 'out';

const isOut = (r: CoverageRow) => r.on_hand_total <= 0;
const isShort = (r: CoverageRow) => r.on_hand_total < r.qty_open;

// No basePath prop (unlike HolderDetail): the screen has no outbound links —
// back-navigation is router.back(), which lands in the right group for all
// three wrappers.
export function CoverageToday() {
  const router = useRouter();
  const coverageQ = useStockCoverage();
  const rows = useMemo(() => coverageQ.data ?? [], [coverageQ.data]);

  // Vendor names resolved client-side (kept off the agent-callable RPC — see
  // fetchCoverageClientNames). Keyed on the id set so it refetches only when
  // the product mix changes, not on every count refresh.
  const idsKey = useMemo(
    () =>
      rows
        .map((r) => r.product_catalog_id)
        .sort()
        .join(','),
    [rows],
  );
  const namesQ = useAsync(
    () => fetchCoverageClientNames(idsKey ? idsKey.split(',') : []),
    [idsKey],
  );

  useReloadOnFocus(() => {
    coverageQ.refetchIfStale();
  });

  const [filter, setFilter] = useState<CoverageFilter>('all');

  const stats = useMemo(() => {
    const short = rows.filter(isShort);
    return {
      outCount: rows.filter(isOut).length,
      shortCount: short.length,
      ordersAffected: short.reduce((s, r) => s + r.orders_open, 0),
    };
  }, [rows]);

  // Worst first: biggest shortfall on top, covered products (browsing "All")
  // alphabetical at the bottom.
  const visibleRows = useMemo(() => {
    return rows
      .filter((r) => (filter === 'out' ? isOut(r) : filter === 'short' ? isShort(r) : true))
      .sort((a, b) => {
        const gapA = a.qty_open - a.on_hand_total;
        const gapB = b.qty_open - b.on_hand_total;
        const shortA = isShort(a) ? 1 : 0;
        const shortB = isShort(b) ? 1 : 0;
        if (shortA !== shortB) return shortB - shortA;
        if (shortA && gapA !== gapB) return gapB - gapA;
        return a.product_name.localeCompare(b.product_name);
      });
  }, [rows, filter]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Stock coverage"
        subtitle="Today's open orders vs stock on hand"
        onBack={() => router.back()}
      />
      {coverageQ.loading && rows.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : coverageQ.error ? (
        <Empty icon="alert" title="Could not load" sub={coverageQ.error} />
      ) : rows.length === 0 ? (
        <Empty icon="check" title="No open orders" sub="Nothing to cover for today yet." />
      ) : (
        <FlatList
          data={visibleRows}
          keyExtractor={(r) => r.product_catalog_id}
          contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 10 }}
          refreshControl={
            <RefreshControl
              refreshing={coverageQ.fetching}
              onRefresh={() => {
                void coverageQ.reload();
              }}
              tintColor={colors.black}
            />
          }
          ListHeaderComponent={
            <View style={{ gap: 12, marginBottom: 6 }}>
              {/* Hero: the shortage picture at a glance. */}
              <Card style={{ backgroundColor: colors.black, padding: 18 }}>
                <View style={{ flexDirection: 'row', gap: 24 }}>
                  <HeroStat
                    label="Out"
                    value={stats.outCount}
                    accent={stats.outCount > 0 ? colors.red : colors.white}
                  />
                  <HeroStat
                    label="Short"
                    value={stats.shortCount}
                    accent={stats.shortCount > 0 ? colors.warning : colors.white}
                  />
                  <HeroStat
                    label="Orders affected"
                    value={stats.ordersAffected}
                    accent={colors.white}
                  />
                </View>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 11,
                    color: colors.textTertiary,
                    marginTop: 12,
                  }}
                >
                  {`Committed = the customer already said yes. On hand − committed is what's still safely promisable.`}
                </Text>
              </Card>
              <FilterChips<CoverageFilter>
                options={[
                  { id: 'all', label: 'All', count: rows.length },
                  { id: 'short', label: 'Short', count: stats.shortCount },
                  { id: 'out', label: 'Out', count: stats.outCount },
                ]}
                value={filter}
                onChange={setFilter}
              />
            </View>
          }
          ListEmptyComponent={
            <Empty
              icon="check"
              title={filter === 'out' ? 'Nothing fully out' : 'Nothing short'}
              sub="Every product with open orders is covered."
            />
          }
          renderItem={({ item }) => (
            <ProductCoverageCard
              row={item}
              clientName={namesQ.data?.get(item.product_catalog_id) ?? ''}
            />
          )}
        />
      )}
    </View>
  );
}

function HeroStat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <View>
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 10,
          color: colors.textTertiary,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 24,
          color: accent,
          marginTop: 2,
          letterSpacing: -0.4,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function ProductCoverageCard({ row, clientName }: { row: CoverageRow; clientName: string }) {
  const gap = row.qty_open - row.on_hand_total;
  const out = isOut(row);
  const short = isShort(row);
  const agentsOnHand = row.on_hand_total - row.on_hand_warehouse;
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
            {row.product_name}
          </Text>
          {clientName ? (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 1,
              }}
            >
              {clientName}
            </Text>
          ) : null}
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 6,
            }}
          >
            {`Needed ${row.qty_open} (${row.orders_open} ${row.orders_open === 1 ? 'order' : 'orders'}) · committed ${row.qty_committed} · on hand ${Math.max(0, row.on_hand_total)}`}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textTertiary,
              marginTop: 2,
            }}
          >
            {`Warehouse ${Math.max(0, row.on_hand_warehouse)} · with riders ${Math.max(0, agentsOnHand)}`}
            {row.on_hand_total < 0 ? `  (book: ${row.on_hand_total})` : ''}
          </Text>
        </View>
        {short ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: out ? colors.redSoft : colors.warningSoft,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            <Icon name="alert" size={12} color={out ? colors.red : colors.warningDark} />
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 12,
                color: out ? colors.red : colors.warningDark,
              }}
            >
              {out ? 'Out' : `−${gap}`}
            </Text>
          </View>
        ) : (
          <View
            style={{
              backgroundColor: colors.successSoft,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: colors.successDark }}>
              Covered
            </Text>
          </View>
        )}
      </View>
    </Card>
  );
}
