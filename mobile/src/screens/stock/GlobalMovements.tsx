// Cross-holder stock-movement history — the company-wide and per-client
// oversight views (Phase 1). Both render this one screen off the
// `list_stock_movements_global` RPC:
//   • company mode (no clientId) — every holder, filterable by product, client,
//     kind, and holder.
//   • client mode (clientId set) — one vendor's SKUs across all holders; the
//     client filter is hidden and the title is the vendor name.
//
// Unlike the per-holder Movements screen there is no single "viewer" holder, so
// every row shows WHOSE shelf moved, paired transfers are collapsed server-side
// to one "From → To" row, and the subtitle copy (globalSubtitleFor) is written
// from an outside-observer perspective rather than the sign-relative one
// Movements uses. Server gate is ops-only (admin/dispatcher/rep).
//
// Pagination is keyset-cursor on (event_at, event_id), identical to Movements;
// all four filters are server-side (the list is infinite history, so a
// client-side filter would only narrow the loaded page).
import { useCallback, useMemo, useRef, useState } from 'react';
import { SectionList, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  listGlobalStockMovements,
  nextCursor,
  type GlobalMovement,
  type MovementCursor,
  type MovementEventKind,
} from '@/services/stock-movements';
import { KIND_CATEGORIES, iconFor } from '@/screens/stock/Movements';
import { listProducts, listActiveProductsByClient } from '@/services/products';
import { listClients } from '@/services/clients';
import { listUsers, isWarehousePlace } from '@/services/users';
import { useAsync } from '@/hooks/useAsync';
import { lagosDayKey, lagosDayLabel, relativeTime } from '@/lib/date';
import { AppBar, Button, Card, Empty, FilterChips, Icon, SectionHeader } from '@/components/ui';
import { Select, type SelectOption } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';

const PAGE_SIZE = 50;
const ALL = '__all__';

export type GlobalMovementsBasePath = '/(admin)' | '/(dispatcher)';

export function GlobalMovements({
  basePath,
  clientId,
  clientName,
}: {
  basePath: GlobalMovementsBasePath;
  /** Set → per-client mode (client filter hidden, title = vendor). */
  clientId?: string;
  clientName?: string;
}) {
  const router = useRouter();
  const clientMode = !!clientId;

  const [rows, setRows] = useState<GlobalMovement[]>([]);
  const [cursor, setCursor] = useState<MovementCursor>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endOfHistory, setEndOfHistory] = useState(false);

  // Filters — all server-side. kindCat = a KIND_CATEGORIES id; the rest are ids.
  const [kindCat, setKindCat] = useState('all');
  const [productId, setProductId] = useState<string | null>(null);
  const [holderId, setHolderId] = useState<string | null>(null);
  const [clientFilterId, setClientFilterId] = useState<string | null>(null);

  // Effective vendor: fixed by the route in client mode, else the picker.
  const effectiveClientId = clientId ?? clientFilterId;

  // Filter option lists. Products narrow to the chosen/route client; clients +
  // holders only matter in company mode.
  const productsQ = useAsync(
    () => (effectiveClientId ? listActiveProductsByClient(effectiveClientId) : listProducts()),
    [effectiveClientId],
  );
  const clientsQ = useAsync(() => (clientMode ? Promise.resolve([]) : listClients()), [clientMode]);
  const holdersQ = useAsync(() => listUsers(), []);

  const filtersActive =
    kindCat !== 'all' || productId !== null || holderId !== null || clientFilterId !== null;

  const reqRef = useRef(0);

  const kindsFor = useCallback(
    (cat: string): MovementEventKind[] | null =>
      KIND_CATEGORIES.find((c) => c.id === cat)?.kinds ?? null,
    [],
  );

  const fetchPage = useCallback(
    (cur: MovementCursor) =>
      listGlobalStockMovements(cur, PAGE_SIZE, {
        clientId: effectiveClientId,
        productCatalogId: productId,
        holderId,
        kinds: kindsFor(kindCat),
      }),
    [effectiveClientId, productId, holderId, kindCat, kindsFor],
  );

  const loadFirstPage = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(null);
      if (reqRef.current !== req) return;
      setRows(page);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [fetchPage]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loading || endOfHistory) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(cursor);
      if (reqRef.current !== req) return;
      setRows((prev) => [...prev, ...page]);
      setCursor(nextCursor(page));
      setEndOfHistory(page.length < PAGE_SIZE);
    } catch (e) {
      if (reqRef.current !== req) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [fetchPage, cursor, loading, endOfHistory]);

  // Refocus — or a filter change (loadFirstPage identity changes) — resets to
  // page 1, same contract as the per-holder Movements screen.
  useFocusEffect(
    useCallback(() => {
      loadFirstPage();
    }, [loadFirstPage]),
  );

  const sections = useMemo(() => {
    const groups: { key: string; title: string; data: GlobalMovement[] }[] = [];
    let current: (typeof groups)[number] | null = null;
    for (const r of rows) {
      const key = lagosDayKey(r.event_at);
      if (!current || current.key !== key) {
        current = { key, title: lagosDayLabel(r.event_at), data: [] };
        groups.push(current);
      }
      current.data.push(r);
    }
    return groups;
  }, [rows]);

  const productOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: ALL, label: 'All products' },
      ...(productsQ.data ?? []).map((p) => ({ value: p.id, label: p.product_name })),
    ],
    [productsQ.data],
  );
  const clientOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: ALL, label: 'All clients' },
      ...(clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [clientsQ.data],
  );
  const holderOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: ALL, label: 'All holders' },
      ...(holdersQ.data ?? [])
        .filter((u) => u.is_active && (isWarehousePlace(u) || u.role === 'agent'))
        .map((u) => ({ value: u.id, label: u.display_name })),
    ],
    [holdersQ.data],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title={clientMode ? (clientName ?? 'Client') : 'All movements'}
        subtitle={clientMode ? 'Stock history' : 'Across all holders'}
        onBack={() => router.back()}
      />

      <View>
        <FilterChips
          options={KIND_CATEGORIES.map((c) => ({ id: c.id, label: c.label }))}
          value={kindCat}
          onChange={setKindCat}
        />
        <View style={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8, gap: 8 }}>
          <Select
            label="Product"
            value={productId ?? ALL}
            options={productOptions}
            onChange={(v) => setProductId(v === ALL ? null : v)}
            searchable
            searchPlaceholder="Search products"
          />
          {!clientMode ? (
            <Select
              label="Client"
              value={clientFilterId ?? ALL}
              options={clientOptions}
              onChange={(v) => {
                setClientFilterId(v === ALL ? null : v);
                // A product belongs to one client, so a vendor change can't keep
                // the old product filter — reset it here (not via an effect, which
                // would double-fire the page fetch).
                setProductId(null);
              }}
              searchable
              searchPlaceholder="Search clients"
            />
          ) : null}
          <Select
            label="Holder"
            value={holderId ?? ALL}
            options={holderOptions}
            onChange={(v) => setHolderId(v === ALL ? null : v)}
            searchable
            searchPlaceholder="Search holders"
          />
        </View>
      </View>

      <SectionList
        style={{ flex: 1 }}
        sections={sections}
        keyExtractor={(r) => `${r.source}:${r.event_id}`}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, paddingTop: 8, paddingBottom: 32, flexGrow: 1 }}
        renderSectionHeader={({ section }) => <SectionHeader>{section.title}</SectionHeader>}
        renderItem={({ item }) => (
          <GlobalMovementRow
            row={item}
            showClient={!clientMode}
            onPress={
              item.source === 'delivery' && item.delivery_id
                ? () =>
                    router.push(
                      `${basePath}/deliveries/${item.delivery_id}` as `${GlobalMovementsBasePath}/deliveries/${string}`,
                    )
                : undefined
            }
          />
        )}
        ListEmptyComponent={
          error ? (
            <Empty icon="alert" title="Could not load history" sub={error} />
          ) : loading ? null : filtersActive ? (
            <Empty
              icon="filter"
              title="No matching movements"
              sub={
                clientMode
                  ? 'Try a different product, holder, or type.'
                  : 'Try a different product, client, holder, or type.'
              }
            />
          ) : (
            <Empty
              icon="package"
              title="No movements yet"
              sub="Receives, transfers, and delivered orders will show up here."
            />
          )
        }
        ListFooterComponent={
          rows.length === 0 ? null : endOfHistory ? (
            <Text style={endCaption}>End of history</Text>
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

function GlobalMovementRow({
  row,
  showClient,
  onPress,
}: {
  row: GlobalMovement;
  showClient: boolean;
  onPress: (() => void) | undefined;
}) {
  const positive = row.quantity_delta > 0;
  const negative = row.quantity_delta < 0;
  const accent = positive ? colors.success : negative ? colors.red : colors.closed;
  const tint = positive ? colors.successSoft : negative ? colors.redSoft : colors.surface;
  const partial =
    row.source === 'delivery' &&
    row.quantity_ordered != null &&
    Math.abs(row.quantity_delta) !== row.quantity_ordered;

  return (
    <Card dense onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            backgroundColor: tint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={iconFor(row.event_kind)} size={20} color={accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
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
            {globalSubtitleFor(row)}
          </Text>
          {showClient && row.client_name ? (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11,
                color: colors.textTertiary,
                marginTop: 2,
              }}
              numberOfLines={1}
            >
              {row.client_name}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 20,
              letterSpacing: -0.4,
              color: accent,
            }}
          >
            {positive ? '+' : ''}
            {row.quantity_delta}
          </Text>
          {partial ? (
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 10,
                color: colors.textTertiary,
                marginTop: 1,
              }}
            >
              {Math.abs(row.quantity_delta)} of {row.quantity_ordered}
            </Text>
          ) : null}
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 10,
              color: colors.textTertiary,
              marginTop: 1,
            }}
          >
            {relativeTime(row.event_at)}
          </Text>
        </View>
        {onPress ? <Icon name="chevronRight" size={18} color={colors.textTertiary} /> : null}
      </View>
    </Card>
  );
}

/** Outside-observer subtitle (no single viewer holder). Always names the holder
 *  whose shelf moved; paired transfers (collapsed to the source leg) read
 *  "<holder> → <counterparty>"; deliveries read "<holder> → <customer>". */
function globalSubtitleFor(row: GlobalMovement): string {
  const holder = row.holder_name ?? 'Unknown holder';
  const actor = row.actor_name && row.actor_name !== holder ? ` · by ${row.actor_name}` : '';
  const to = row.counterparty_holder_name ?? 'Unknown party';
  switch (row.event_kind) {
    case 'bulk_intake':
      return `Received into ${holder}${actor}`;
    case 'warehouse_issue':
      return `Issued · ${holder} → ${to}${actor}`;
    case 'warehouse_return':
      return `Returned · ${holder} → ${to}${actor}`;
    case 'transfer':
      return `Transfer · ${holder} → ${to}${actor}`;
    case 'delivered':
      return `Delivered · ${holder} → ${row.customer_name ?? 'customer'}`;
    case 'correction':
      return `Correction · ${holder}${actor}`;
    case 'loss':
      return `Loss · ${holder}${actor}`;
    case 'theft':
      return `Theft · ${holder}${actor}`;
    case 'damaged':
      return `Damaged · ${holder}${actor}`;
    case 'found':
      return `Found · ${holder}${actor}`;
    default:
      return holder;
  }
}

const endCaption = {
  fontFamily: fonts.medium,
  fontSize: 11,
  color: colors.textTertiary,
  textAlign: 'center' as const,
  marginTop: 18,
  letterSpacing: 0.6,
  textTransform: 'uppercase' as const,
};
