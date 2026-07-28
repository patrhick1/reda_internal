import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { FilterChips } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { isWarehousePlace } from '@/services/users';
import { useUsers, useProducts } from '@/hooks/queries';
import {
  stockMovementSummary,
  groupMovementSummary,
  listGlobalStockMovements,
  nextCursor,
  type MovementBucket,
  type MovementPeriod,
  type GlobalMovement,
} from '@/services/stock-movements';
import { todayLagos, daysAgoLagos, formatDayMonthLagos, formatDateTimeLagos } from '@/lib/date';
import { colors, fonts } from '@/lib/theme';

/**
 * Movement Summary — daily / weekly totals of the stock ledger for one product,
 * over a chosen range, optionally scoped to one holder. Answers "how much came
 * in and went out this day/week?" and, via the drillable Delivered line, "what
 * exactly was delivered?" — the reconciliation trace without a calculator.
 * Read-only.
 */
type RangeKey = '7d' | '30d' | 'month';
type MovementSummaryBasePath = '/(admin)' | '/(dispatcher)';
type DeliveryDrillKind = 'delivered' | 'delivery_returned';
type DeliveryDrill = {
  kind: DeliveryDrillKind;
  rows: GlobalMovement[] | 'loading';
};

function rangeDates(r: RangeKey): { from: string; to: string } {
  const to = todayLagos();
  if (r === '7d') return { from: daysAgoLagos(6), to };
  if (r === '30d') return { from: daysAgoLagos(29), to };
  return { from: `${to.slice(0, 8)}01`, to }; // this month: YYYY-MM-01 → today
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

type PeriodLine = {
  key: keyof Omit<MovementPeriod, 'period_start' | 'net'>;
  label: string;
};

const STOCK_CHANGE_LINES: PeriodLine[] = [
  { key: 'received', label: 'Stock received' },
  { key: 'delivered', label: 'Delivered to customers' },
  { key: 'deliveryReversed', label: 'Delivery reversals' },
  { key: 'adjustments', label: 'Adjustments' },
];

const INTERNAL_LINES: PeriodLine[] = [
  { key: 'warehouseIssues', label: 'Issued to riders' },
  { key: 'warehouseReturns', label: 'Returned to warehouse' },
  { key: 'transfers', label: 'Transfers' },
];

const HOLDER_INTERNAL_LINES: PeriodLine[] = [
  { key: 'warehouseIssues', label: 'Warehouse issues' },
  { key: 'warehouseReturns', label: 'Warehouse returns' },
  { key: 'transfers', label: 'Transfers' },
];

export function StockMovementSummaryScreen({ basePath }: { basePath: MovementSummaryBasePath }) {
  const router = useRouter();
  const productsQ = useProducts();
  const usersQ = useUsers();

  const [productId, setProductId] = useState<string | null>(null);
  const [holderId, setHolderId] = useState<string | null>(null); // null = all holders
  const [range, setRange] = useState<RangeKey>('7d');
  const [bucket, setBucket] = useState<MovementBucket>('day');
  const [deliveryDrill, setDeliveryDrill] = useState<DeliveryDrill | null>(null);

  const { from, to } = useMemo(() => rangeDates(range), [range]);

  const summaryQ = useAsync(
    () =>
      productId ? stockMovementSummary(productId, from, to, holderId, bucket) : Promise.resolve([]),
    [productId, holderId, from, to, bucket],
  );

  const productOptions = useMemo(
    () =>
      (productsQ.data ?? []).map((p) => ({
        value: p.id,
        label: p.product_name,
        sub: (p as { client_name?: string }).client_name,
      })),
    [productsQ.data],
  );
  const holderOptions = useMemo(
    () => [
      { value: '', label: 'All holders', sub: 'Company-wide activity and net change' },
      ...(usersQ.data ?? [])
        .filter((u) => u.is_active && (u.role === 'agent' || isWarehousePlace(u)))
        .map((u) => ({
          value: u.id,
          label: u.display_name,
          sub: isWarehousePlace(u) ? 'Warehouse shelf' : 'Rider',
        })),
    ],
    [usersQ.data],
  );

  const companyWide = holderId === null;
  const grouped = useMemo(
    () => groupMovementSummary(summaryQ.data ?? [], companyWide),
    [summaryQ.data, companyWide],
  );
  const productName = productOptions.find((o) => o.value === productId)?.label ?? '';

  async function openDeliveryDrill(kind: DeliveryDrillKind) {
    if (!productId) return;
    setDeliveryDrill({ kind, rows: 'loading' });
    try {
      // The RPC caps limit at 200; a busy product over a month exceeds that, so
      // page through until exhausted (up to ~1200) — otherwise the drill would
      // under-count vs the summary's Delivered total.
      const PAGE = 200;
      const MAX_PAGES = 6;
      const all: GlobalMovement[] = [];
      let cursor = null as ReturnType<typeof nextCursor>;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await listGlobalStockMovements(cursor, PAGE, {
          productCatalogId: productId,
          holderId: holderId ?? undefined,
          kinds: [kind],
          from,
          to,
        });
        all.push(...page);
        if (page.length < PAGE) break;
        cursor = nextCursor(page);
        if (!cursor) break;
      }
      setDeliveryDrill({ kind, rows: all });
    } catch {
      setDeliveryDrill({ kind, rows: [] });
    }
  }

  // ---- Delivered / reversed-delivery drill sub-view -----------------------
  if (deliveryDrill !== null) {
    const { kind, rows } = deliveryDrill;
    const isReversal = kind === 'delivery_returned';
    const totalUnits =
      rows === 'loading'
        ? 0
        : rows.reduce((s, r) => s + Math.abs(Number(r.quantity_delta ?? 0)), 0);
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>
          {isReversal ? 'Delivery reversals' : 'Delivered'} — {productName}
        </Text>
        <Text style={styles.h1sub}>
          {formatDayMonthLagos(from)} → {formatDayMonthLagos(to)}
          {rows !== 'loading' ? ` · ${totalUnits} units, ${rows.length} orders` : ''}
        </Text>
        {rows === 'loading' ? (
          <View style={styles.centerPad}>
            <ActivityIndicator color={colors.black} />
          </View>
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>
            {isReversal ? 'No delivery reversals in this range.' : 'No deliveries in this range.'}
          </Text>
        ) : (
          <View style={styles.card}>
            {rows.map((r, i) => (
              <Pressable
                key={r.event_id}
                disabled={!r.delivery_id}
                onPress={
                  r.delivery_id
                    ? () =>
                        router.push(
                          `${basePath}/deliveries/${r.delivery_id}` as `${MovementSummaryBasePath}/deliveries/${string}`,
                        )
                    : undefined
                }
                style={[styles.offRow, i > 0 && styles.rowDivider]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.pName} numberOfLines={1}>
                    {r.customer_name ?? 'Customer'}
                  </Text>
                  <Text style={styles.pSub}>
                    {formatDateTimeLagos(r.event_at)}
                    {r.holder_name ? ` · ${r.holder_name}` : ''}
                  </Text>
                </View>
                <Text style={isReversal ? styles.varPos : styles.varNeg}>{r.quantity_delta}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <Button
          title="Back to summary"
          style={styles.spacer}
          onPress={() => setDeliveryDrill(null)}
        />
      </ScrollView>
    );
  }

  // ---- Summary view --------------------------------------------------------
  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Select
        label="Product"
        required
        value={productId}
        options={productOptions}
        onChange={setProductId}
        searchable
        searchPlaceholder="Search product or vendor…"
      />
      <Select
        label="Holder"
        value={holderId ?? ''}
        options={holderOptions}
        onChange={(v) => setHolderId(v || null)}
        searchable
        searchPlaceholder="All holders, or pick one…"
      />

      <Text style={styles.chipLabel}>Range</Text>
      <FilterChips
        options={[
          { id: '7d', label: 'Last 7 days' },
          { id: '30d', label: 'Last 30 days' },
          { id: 'month', label: 'This month' },
        ]}
        value={range}
        onChange={setRange}
      />
      <Text style={styles.chipLabel}>Group by</Text>
      <FilterChips
        options={[
          { id: 'day', label: 'Day' },
          { id: 'week', label: 'Week' },
        ]}
        value={bucket}
        onChange={setBucket}
      />

      {!productId ? (
        <Text style={styles.empty}>Pick a product to see its movement summary.</Text>
      ) : summaryQ.loading && !summaryQ.data ? (
        <View style={styles.centerPad}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : (
        <>
          {/* Range roll-up */}
          <View style={styles.rollup}>
            <Text style={styles.rollupTitle}>
              {formatDayMonthLagos(from)} → {formatDayMonthLagos(to)}
            </Text>
            <PeriodLines period={grouped.total} companyWide={companyWide} />
            <View style={styles.netRow}>
              <Text style={styles.netLabel}>
                {companyWide ? 'Net company stock change' : 'Net change'}
              </Text>
              <Text style={[styles.netVal, varianceStyle(grouped.total.net)]}>
                {signed(grouped.total.net)}
              </Text>
            </View>
            {companyWide && hasInternalActivity(grouped.total) ? (
              <Text style={styles.netHint}>
                Internal movements are shown above but do not change total company stock.
              </Text>
            ) : null}
            {grouped.total.delivered !== 0 ? (
              <Button
                title={`View delivered units (${Math.abs(grouped.total.delivered)})`}
                variant="secondary"
                style={styles.spacer}
                onPress={() => openDeliveryDrill('delivered')}
              />
            ) : null}
            {grouped.total.deliveryReversed !== 0 ? (
              <Button
                title={`View reversed deliveries (${Math.abs(grouped.total.deliveryReversed)} units)`}
                variant="secondary"
                style={styles.spacer}
                onPress={() => openDeliveryDrill('delivery_returned')}
              />
            ) : null}
          </View>

          {/* Per-period breakdown */}
          {grouped.periods.length === 0 ? (
            <Text style={styles.empty}>No movements in this range.</Text>
          ) : (
            grouped.periods.map((p) => (
              <View key={p.period_start} style={styles.periodCard}>
                <Text style={styles.periodLabel}>
                  {bucket === 'week' ? 'Week of ' : ''}
                  {formatDayMonthLagos(p.period_start)}
                </Text>
                <PeriodLines period={p} companyWide={companyWide} />
                <View style={styles.netRowSm}>
                  <Text style={styles.netLabelSm}>{companyWide ? 'Company net' : 'Net'}</Text>
                  <Text style={[styles.netValSm, varianceStyle(p.net)]}>{signed(p.net)}</Text>
                </View>
              </View>
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

function hasInternalActivity(period: MovementPeriod): boolean {
  return period.warehouseIssues !== 0 || period.warehouseReturns !== 0 || period.transfers !== 0;
}

function varianceStyle(value: number) {
  if (value > 0) return styles.varPos;
  if (value < 0) return styles.varNeg;
  return styles.varZero;
}

function PeriodLines({ period, companyWide }: { period: MovementPeriod; companyWide: boolean }) {
  const stockRows = STOCK_CHANGE_LINES.filter((line) => period[line.key] !== 0);
  const internalLines = companyWide ? INTERNAL_LINES : HOLDER_INTERNAL_LINES;
  const internalRows = internalLines.filter((line) => period[line.key] !== 0);
  if (stockRows.length === 0 && internalRows.length === 0) {
    return <Text style={styles.noMoves}>No stock activity</Text>;
  }

  return (
    <View style={{ gap: 4, marginTop: 4 }}>
      <PeriodLineRows period={period} rows={stockRows} />
      {companyWide && internalRows.length > 0 ? (
        <Text style={styles.sectionLabel}>Stock moved internally</Text>
      ) : null}
      <PeriodLineRows period={period} rows={internalRows} neutral={companyWide} />
    </View>
  );
}

function PeriodLineRows({
  period,
  rows,
  neutral = false,
}: {
  period: MovementPeriod;
  rows: PeriodLine[];
  neutral?: boolean;
}) {
  return (
    <>
      {rows.map((line) => {
        const value = period[line.key];
        const displayValue = neutral
          ? `${Math.abs(value)} unit${Math.abs(value) === 1 ? '' : 's'}`
          : signed(value);
        return (
          <View key={line.key} style={styles.lineRow}>
            <Text style={styles.lineLabel}>{line.label}</Text>
            <Text style={[styles.lineVal, neutral ? styles.varNeutral : varianceStyle(value)]}>
              {displayValue}
            </Text>
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.white },
  content: { padding: 16, paddingBottom: 48 },
  centerPad: { paddingVertical: 32, alignItems: 'center' },
  chipLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  empty: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: 28,
  },
  h1: { fontFamily: fonts.bold, fontSize: 18, color: colors.black },
  h1sub: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
    marginBottom: 12,
  },
  rollup: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.black,
    borderRadius: 12,
    padding: 14,
    backgroundColor: colors.white,
  },
  rollupTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.black, marginBottom: 2 },
  periodCard: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.white,
  },
  periodLabel: { fontFamily: fonts.bold, fontSize: 13, color: colors.black },
  sectionLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.textSecondary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 8,
  },
  lineRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lineLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary },
  lineVal: { fontFamily: fonts.semibold, fontSize: 14 },
  noMoves: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  netRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  netLabel: { fontFamily: fonts.bold, fontSize: 14, color: colors.black },
  netVal: { fontFamily: fonts.extrabold, fontSize: 18 },
  netHint: {
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 16,
    color: colors.textSecondary,
    marginTop: 6,
  },
  netRowSm: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  netLabelSm: { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary },
  netValSm: { fontFamily: fonts.bold, fontSize: 14 },
  varPos: { color: colors.success },
  varNeg: { color: colors.red },
  varZero: { color: colors.textSecondary },
  varNeutral: { color: colors.black },
  spacer: { marginTop: 12 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.white,
  },
  offRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  pName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.black },
  pSub: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
