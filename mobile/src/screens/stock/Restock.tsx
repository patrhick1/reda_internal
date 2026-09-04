// Restock — "what do we need to order?", answered in DAYS OF COVER.
//
// The question this screen exists for is NOT the one CoverageToday answers.
// Coverage asks "can we serve the orders already booked for today?"; a product
// can pass that and still need ordering. That gap is what went unreported on
// 2026-09-01: the Water Filter had 5 units against exactly 5 units of booked
// orders, so coverage stayed silent — while the product was shipping ~12 a day
// and had under half a day of stock left.
//
// The old low-stock rule (0 < qty <= 3, per holder row) missed it from the
// other side. Against live stock that rule flagged 7 products needing nothing
// (Opulent Dubai: 1 unit, 24 days of cover) and missed 7 that did — most at
// ZERO warehouse stock, invisible because the rule required qty > 0.
//
// So the ranking here is time, not units: warehouse stock divided by units
// shipped per selling day. 34 units of a product moving 20/day is a shortage;
// 1 unit of a product moving 1/month is not. Riders' bags are excluded — a
// rider holding 1-3 units is a normal day's round.
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useRestockSignal } from '@/hooks/queries';
import { DEFAULT_LEAD_DAYS, type RestockRow, type RestockTier } from '@/services/stock-restock';
import { AppBar, Card, Empty, FilterChips, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

type RestockFilter = 'action' | 'out' | 'reorder' | 'all';

/** Tier presentation. Order matters: it is also the sort rank. */
const TIER_META: Record<RestockTier, { label: string; tone: string; bg: string; rank: number }> = {
  out: { label: 'Out', tone: colors.red, bg: colors.redSoft, rank: 0 },
  critical: { label: 'Today', tone: colors.red, bg: colors.redSoft, rank: 1 },
  reorder: { label: 'Reorder', tone: colors.warningDark, bg: colors.warningSoft, rank: 2 },
  ok: { label: 'OK', tone: colors.success, bg: colors.successSoft, rank: 3 },
};

/** "0.4 days" means nothing to a person mid-shift; "half a day" does. */
function coverLabel(row: RestockRow): string {
  if (row.warehouse_qty <= 0) return 'Nothing left';
  const d = row.days_cover;
  if (d < 0.75) return 'Under a day left';
  if (d < 1.5) return 'About a day left';
  if (d < 2.5) return 'About 2 days left';
  return `About ${Math.round(d)} days left`;
}

export function Restock() {
  const router = useRouter();
  const restockQ = useRestockSignal();
  const rows = useMemo(() => restockQ.data ?? [], [restockQ.data]);

  useReloadOnFocus(() => {
    restockQ.refetchIfStale();
  });

  const [filter, setFilter] = useState<RestockFilter>('action');

  const stats = useMemo(
    () => ({
      outCount: rows.filter((r) => r.tier === 'out').length,
      criticalCount: rows.filter((r) => r.tier === 'critical').length,
      reorderCount: rows.filter((r) => r.tier === 'reorder').length,
      actionCount: rows.filter((r) => r.tier !== 'ok').length,
    }),
    [rows],
  );

  // The RPC already returns worst-first (cover asc, then rate desc so an empty
  // shelf on a fast mover outranks an empty shelf on a slow one). Only the
  // "All" view needs re-ranking, to keep the healthy tail readable.
  const visibleRows = useMemo(() => {
    if (filter === 'out') return rows.filter((r) => r.tier === 'out' || r.tier === 'critical');
    if (filter === 'reorder') return rows.filter((r) => r.tier === 'reorder');
    if (filter === 'action') return rows.filter((r) => r.tier !== 'ok');
    return rows
      .slice()
      .sort(
        (a, b) =>
          TIER_META[a.tier].rank - TIER_META[b.tier].rank ||
          a.days_cover - b.days_cover ||
          a.product_name.localeCompare(b.product_name),
      );
  }, [rows, filter]);

  const loading = restockQ.loading && !restockQ.data;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Restock" subtitle="Warehouse — days of cover" onBack={() => router.back()} />

      <FlatList
        data={visibleRows}
        keyExtractor={(r) => r.product_catalog_id}
        ListHeaderComponent={
          <View style={{ padding: 16, paddingBottom: 4, gap: 12 }}>
            <Card style={{ backgroundColor: colors.black, padding: 18 }}>
              <Text style={kicker}>NEEDS ORDERING</Text>
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
                <Stat
                  label="Out"
                  value={stats.outCount}
                  accent={stats.outCount > 0 ? colors.red : colors.white}
                />
                <Stat
                  label="Today"
                  value={stats.criticalCount}
                  accent={stats.criticalCount > 0 ? colors.red : colors.white}
                />
                <Stat
                  label="Reorder"
                  value={stats.reorderCount}
                  accent={stats.reorderCount > 0 ? colors.warning : colors.white}
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
                {`Ranked by how long the warehouse will last at recent selling speed. "Reorder" means under ${DEFAULT_LEAD_DAYS} days — less than a restock takes to arrive.`}
              </Text>
            </Card>

            <FilterChips<RestockFilter>
              value={filter}
              options={[
                { id: 'action', label: 'Needs action', count: stats.actionCount },
                { id: 'out', label: 'Out / today', count: stats.outCount + stats.criticalCount },
                { id: 'reorder', label: 'Reorder', count: stats.reorderCount },
                { id: 'all', label: 'All', count: rows.length },
              ]}
              onChange={setFilter}
            />
          </View>
        }
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <RestockCard row={item} />
          </View>
        )}
        ListEmptyComponent={
          loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : restockQ.error ? (
            <Empty icon="alert" title="Could not load the restock list" sub={restockQ.error} />
          ) : filter === 'action' || filter === 'out' ? (
            <Empty
              icon="check"
              title="Nothing to order"
              sub="Every product that's selling has more than a restock cycle of stock."
            />
          ) : (
            <Empty icon="package" title="Nothing here" sub="Try another filter." />
          )
        }
        contentContainerStyle={{ paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={restockQ.fetching && !!restockQ.data}
            onRefresh={restockQ.reload}
            tintColor={colors.black}
          />
        }
      />
    </View>
  );
}

function RestockCard({ row }: { row: RestockRow }) {
  const meta = TIER_META[row.tier];
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
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
            {row.client_name ? `${row.client_name} · ` : ''}
            {`${row.warehouse_qty} in warehouse · ${row.rate_per_day}/day`}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: meta.bg,
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 4,
            }}
          >
            {row.tier !== 'ok' ? <Icon name="alert" size={12} color={meta.tone} /> : null}
            <Text style={{ fontFamily: fonts.bold, fontSize: 12, color: meta.tone }}>
              {meta.label}
            </Text>
          </View>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}>
            {coverLabel(row)}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.black, paddingHorizontal: 12, paddingVertical: 14 }}
    >
      <Text style={{ ...kicker, fontSize: 10 }}>{label.toUpperCase()}</Text>
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
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textTertiary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
