// Stock count history — the read side of physical counts.
//
// record_stock_count has been logging every count since the feature shipped,
// but nothing ever read the rows back: the count screen showed each variance
// once on its results banner and then the numbers were unreachable. This is
// that missing surface.
//
// One card per count RUN, newest first, so a 150-product warehouse count is one
// line rather than 150. Tapping a card fetches just that run's rows — the feed
// itself never carries per-product data. Grouping happens server-side in
// `list_stock_count_batches` for the same reason.
//
// Pagination is keyset-cursor on (counted_at, batch_id), and refocusing — or
// changing the holder filter — resets to page 1, mirroring Movements.tsx.
//
// Counts are REPORT-ONLY: nothing here changes stock. The one action offered is
// a deliberate Adjustment, and only for admins, because correcting a variance
// is a `correction` adjustment and that reason is admin-only server-side.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, SectionList, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  listCountsForBatch,
  listStockCountBatches,
  nextBatchCursor,
  type StockCountBatch,
  type StockCountCursor,
  type StockCountRow,
} from '@/services/stock-counts';
import { useCurrentUser } from '@/hooks/useAuth';
import { useProducts, useUsers } from '@/hooks/queries';
import { canCorrectStock } from '@/lib/permissions';
import { lagosDayKey, lagosDayLabel, relativeTime } from '@/lib/date';
import { AppBar, Button, Card, Empty, Icon, SectionHeader } from '@/components/ui';
import { Select } from '@/components/Select';
import { VarianceRow } from '@/components/stock/VarianceRow';
import { colors, fonts } from '@/lib/theme';

const PAGE_SIZE = 30;

export type CountHistoryBasePath = '/(admin)' | '/(dispatcher)' | '/(warehouse)';

export type CountHistoryProps = {
  basePath: CountHistoryBasePath;
  /** Pre-select a holder — set when arriving from a holder's detail screen. */
  initialHolderId?: string | null;
};

/** The Movements screen sits at a different depth per route group — warehouse
 *  has no `/stock` segment. Mirrors movementsRoute() in HolderDetail.tsx. */
function movementsRoute(basePath: CountHistoryBasePath) {
  if (basePath === '/(warehouse)') return '/(warehouse)/movements/[holderId]' as const;
  if (basePath === '/(admin)') return '/(admin)/stock/movements/[holderId]' as const;
  return '/(dispatcher)/stock/movements/[holderId]' as const;
}

export function CountHistory({ basePath, initialHolderId = null }: CountHistoryProps) {
  const router = useRouter();
  const user = useCurrentUser();
  const usersQ = useUsers();
  // includeInactive: a run may reference a product retired since it was counted.
  // Without this those rows would render nameless.
  const productsQ = useProducts({ includeInactive: true });

  const [rows, setRows] = useState<StockCountBatch[]>([]);
  const [cursor, setCursor] = useState<StockCountCursor>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endOfHistory, setEndOfHistory] = useState(false);
  const [holderId, setHolderId] = useState<string | null>(initialHolderId);

  // Expanded run + its lazily-fetched rows, keyed by batch so collapsing and
  // re-opening doesn't refetch.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [items, setItems] = useState<Record<string, StockCountRow[]>>({});
  const [itemsLoading, setItemsLoading] = useState<string | null>(null);

  // Monotonic request id — a slow page must not overwrite a newer filter's result.
  const reqRef = useRef(0);

  const nameOf = useCallback(
    (id: string | null) =>
      id ? ((usersQ.data ?? []).find((u) => u.id === id)?.display_name ?? 'Unknown') : 'Unknown',
    [usersQ.data],
  );
  const productName = useCallback(
    (id: string) => (productsQ.data ?? []).find((p) => p.id === id)?.product_name ?? 'Product',
    [productsQ.data],
  );
  // The Adjust screen populates its product picker per client, so a deep link
  // has to carry the client as well as the product.
  const clientOf = useCallback(
    (productCatalogId: string) =>
      (productsQ.data ?? []).find((p) => p.id === productCatalogId)?.client_id ?? null,
    [productsQ.data],
  );

  const loadFirstPage = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listStockCountBatches(null, PAGE_SIZE, { holderId });
      if (reqRef.current !== req) return;
      setRows(page);
      setCursor(nextBatchCursor(page, PAGE_SIZE));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [holderId]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loading || endOfHistory) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listStockCountBatches(cursor, PAGE_SIZE, { holderId });
      if (reqRef.current !== req) return;
      setRows((prev) => [...prev, ...page]);
      setCursor(nextBatchCursor(page, PAGE_SIZE));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [cursor, loading, endOfHistory, holderId]);

  useFocusEffect(
    useCallback(() => {
      // Refocus or a filter change resets to page 1 — otherwise someone who
      // paged deep and backed out would return to the deep-paged state.
      loadFirstPage();
    }, [loadFirstPage]),
  );

  const toggle = useCallback(
    async (batchId: string) => {
      if (expanded === batchId) {
        setExpanded(null);
        return;
      }
      setExpanded(batchId);
      if (items[batchId]) return; // already fetched
      setItemsLoading(batchId);
      try {
        const detail = await listCountsForBatch(batchId);
        setItems((prev) => ({ ...prev, [batchId]: detail }));
      } catch {
        // Non-fatal: the card stays open with an inline note. The feed itself
        // is unaffected, so don't surface this as a screen-level error.
        setItems((prev) => ({ ...prev, [batchId]: [] }));
      } finally {
        setItemsLoading(null);
      }
    },
    [expanded, items],
  );

  // Holders that have ever been counted would need another query; the full
  // holder list is already cached, so filter from that instead.
  const holderOptions = useMemo(
    () =>
      (usersQ.data ?? [])
        .filter((u) => u.role === 'agent' || u.role === 'warehouse')
        .map((u) => ({ value: u.id, label: u.display_name })),
    [usersQ.data],
  );

  const sections = useMemo(() => {
    const groups: { key: string; title: string; data: StockCountBatch[] }[] = [];
    let current: (typeof groups)[number] | null = null;
    for (const r of rows) {
      const key = lagosDayKey(r.counted_at);
      if (!current || current.key !== key) {
        current = { key, title: lagosDayLabel(r.counted_at), data: [] };
        groups.push(current);
      }
      current.data.push(r);
    }
    return groups;
  }, [rows]);

  const canAdjust = canCorrectStock(user.role);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Count history" onBack={() => router.back()} />

      <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
        <Select
          label="Holder"
          value={holderId}
          options={holderOptions}
          onChange={setHolderId}
          placeholder="All holders"
          searchable
          searchPlaceholder="Search agent or warehouse…"
        />
        {holderId ? (
          <Pressable onPress={() => setHolderId(null)} style={{ paddingBottom: 8 }}>
            <Text style={styles.clearLink}>Show all holders</Text>
          </Pressable>
        ) : null}
      </View>

      <SectionList
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 48 }}
        sections={sections}
        keyExtractor={(b) => b.batch_id}
        renderSectionHeader={({ section }) => <SectionHeader>{section.title}</SectionHeader>}
        renderItem={({ item }) => (
          <BatchCard
            batch={item}
            holderName={nameOf(item.holder_id)}
            actorName={nameOf(item.counted_by)}
            expanded={expanded === item.batch_id}
            loadingItems={itemsLoading === item.batch_id}
            rows={items[item.batch_id]}
            productName={productName}
            onToggle={() => toggle(item.batch_id)}
            onAdjust={
              // canAdjust is admin-only (a variance fix is a `correction`, and
              // that reason is admin-only server-side), so this deep link is
              // never built under the warehouse base path.
              canAdjust
                ? (productCatalogId) =>
                    router.push({
                      pathname: `${basePath}/stock/adjust`,
                      params: {
                        holderId: item.holder_id,
                        productId: productCatalogId,
                        clientId: clientOf(productCatalogId) ?? '',
                      },
                    } as never)
                : undefined
            }
            onTrace={() =>
              router.push({
                pathname: movementsRoute(basePath),
                params: { holderId: item.holder_id },
              })
            }
          />
        )}
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load count history" sub={error} />
          ) : loading ? null : holderId ? (
            <Empty
              icon="filter"
              title="No counts for this holder"
              sub="Nothing has been counted here yet. Try another holder."
            />
          ) : (
            <Empty
              icon="package"
              title="No counts yet"
              sub="Recorded stock counts will show up here."
            />
          )
        }
        ListFooterComponent={
          rows.length === 0 ? null : endOfHistory ? (
            <Text style={styles.endCap}>End of history</Text>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Button variant="secondary" full onPress={loadOlder} disabled={loading}>
                {loading ? 'Loading…' : 'Load older'}
              </Button>
            </View>
          )
        }
      />
    </View>
  );
}

function BatchCard({
  batch,
  holderName,
  actorName,
  expanded,
  loadingItems,
  rows,
  productName,
  onToggle,
  onAdjust,
  onTrace,
}: {
  batch: StockCountBatch;
  holderName: string;
  actorName: string;
  expanded: boolean;
  loadingItems: boolean;
  rows: StockCountRow[] | undefined;
  productName: (id: string) => string;
  onToggle: () => void;
  /** Only supplied for roles that can actually make a correction. */
  onAdjust?: (productCatalogId: string) => void;
  onTrace: () => void;
}) {
  const clean = batch.off_count === 0;
  return (
    <Card style={{ marginBottom: 10, padding: 14 }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.holder}>{holderName}</Text>
          <Text style={styles.meta}>
            {relativeTime(batch.counted_at)} · by {actorName}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.tally, clean ? styles.tallyOk : styles.tallyOff]}>
            {clean ? 'All match' : `${batch.off_count} off`}
          </Text>
          <Text style={styles.meta}>{batch.items_count} counted</Text>
        </View>
        <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={18} color={colors.textTertiary} />
      </Pressable>

      {batch.note ? <Text style={styles.note}>{batch.note}</Text> : null}

      {expanded ? (
        <View style={{ marginTop: 8 }}>
          {loadingItems ? (
            <Text style={styles.meta}>Loading…</Text>
          ) : !rows || rows.length === 0 ? (
            <Text style={styles.meta}>Couldn&apos;t load the counted products.</Text>
          ) : (
            <>
              {rows.map((r, i) => (
                <View key={r.id}>
                  <VarianceRow
                    productName={productName(r.product_catalog_id)}
                    expected={r.expected_qty}
                    counted={r.counted_qty}
                    variance={r.variance}
                    divider={i > 0}
                  />
                  {r.variance !== 0 && onAdjust ? (
                    <Pressable onPress={() => onAdjust(r.product_catalog_id)}>
                      <Text style={styles.action}>Make an adjustment</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              <Button variant="secondary" full onPress={onTrace} style={{ marginTop: 12 }}>
                Trace movements for this holder
              </Button>
            </>
          )}
        </View>
      ) : null}
    </Card>
  );
}

const styles = {
  holder: { fontFamily: fonts.semibold, fontSize: 15, color: colors.black },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  tally: { fontFamily: fonts.bold, fontSize: 14 },
  tallyOk: { color: colors.success },
  tallyOff: { color: colors.red },
  note: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 8,
    fontStyle: 'italic' as const,
  },
  action: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.black,
    textDecorationLine: 'underline' as const,
    paddingBottom: 10,
  },
  clearLink: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary },
  endCap: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.textTertiary,
    textAlign: 'center' as const,
    marginTop: 18,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
};
