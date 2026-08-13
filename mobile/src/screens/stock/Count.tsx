import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button } from '@/components/Button';
import { VarianceRow } from '@/components/stock/VarianceRow';
import { Field } from '@/components/Field';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { isWarehousePlace } from '@/services/users';
import { useLastCount, useUsers } from '@/hooks/queries';
import { listHolderStock, type StockMatrixRow } from '@/services/stock';
import { recordStockCount } from '@/services/stock-counts';
import { resolveWarehouseHolder } from '@/lib/stock-helpers';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';
import { relativeTime } from '@/lib/date';
import { colors, fonts } from '@/lib/theme';

/**
 * Stock Count & Reconciliation Check — REPORT ONLY.
 *
 * The counter picks a holder (a warehouse shelf or a rider), types the physical
 * count per product, and the app tells them whether each matches the app number
 * and by how much. It records the count as a reference point but NEVER changes
 * the stock ledger. If a variance can't be explained, correcting it stays a
 * separate, deliberate action (the existing admin Adjustment).
 *
 * `scope` toggles who is being counted:
 *   admin / dispatcher — any holder, picked from the roster.
 *   warehouse          — the caller's OWN place, resolved and locked. Riders are
 *                        deliberately out of scope: record_stock_count's
 *                        warehouse branch only admits
 *                        `p_holder_id = coalesce(warehouse_id, self)`.
 */
export type StockCountScreenProps = { scope: 'admin' | 'dispatcher' | 'warehouse' };

type OffRow = { name: string; expected: number; counted: number; variance: number };

/** What the counter typed, snapshotted at save time. The banner reads from this
 *  rather than from the RPC's tally so a retry (see `batchId` below) can't
 *  report "0 counted" for a run the server had already accepted. */
type CountSummary = { total: number; matched: number; offs: OffRow[] };

/** Which rows the list is showing. Counted values live in state keyed by product
 *  id, so narrowing never discards a number that's already been typed. */
type RowFilter = 'all' | 'todo' | 'off';

/** The Movements screen sits at a different depth per route group — warehouse
 *  has no `/stock` segment. Mirrors movementsRoute() in HolderDetail.tsx. */
function movementsRoute(scope: StockCountScreenProps['scope']) {
  if (scope === 'warehouse') return '/(warehouse)/movements/[holderId]' as const;
  if (scope === 'admin') return '/(admin)/stock/movements/[holderId]' as const;
  return '/(dispatcher)/stock/movements/[holderId]' as const;
}

export function StockCountScreen({ scope }: StockCountScreenProps) {
  const isWarehouseScope = scope === 'warehouse';
  const currentUser = useCurrentUser();
  const usersQ = useUsers();

  const [pickedHolderId, setPickedHolderId] = useState<string | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [rowFilter, setRowFilter] = useState<RowFilter>('all');
  // The product ids that matched when the chip was tapped. Without this the
  // narrowed views fight the keyboard: on "To count" a row qualifies until the
  // first digit lands, so it would vanish mid-number and swallow the rest of it.
  // Snapshotting makes a chip mean "the rows that matched when I asked" — they
  // stay put, showing their ✓ / variance, until the chip is tapped again.
  const [filterSnapshot, setFilterSnapshot] = useState<Set<string> | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CountSummary | null>(null);
  // One id per RUN, not per Save press. A timeout that hides a committed write
  // used to send the retry under a fresh uuid, so the same shelf landed twice as
  // two separate runs; reusing it makes the retry hit record_stock_count's
  // (batch_id, product) idempotency guard instead.
  const [batchId, setBatchId] = useState(() => newClientUuid());

  // Warehouse scope: the holder is the PLACE this staff member acts on, never
  // their own id — staff hold no stock and the server answers a staff id with
  // 42501. Fail loud rather than guess (see resolveWarehouseHolder).
  const warehouseHolder = useMemo(
    () =>
      isWarehouseScope
        ? resolveWarehouseHolder(
            {
              userId: currentUser.userId,
              warehouseId: currentUser.warehouseId,
              displayName: currentUser.displayName,
            },
            usersQ.data ?? undefined,
          )
        : null,
    [
      isWarehouseScope,
      currentUser.userId,
      currentUser.warehouseId,
      currentUser.displayName,
      usersQ.data,
    ],
  );
  const holderError = warehouseHolder && !warehouseHolder.ok ? warehouseHolder.reason : null;
  const holderId = isWarehouseScope
    ? warehouseHolder?.ok
      ? warehouseHolder.holderId
      : null
    : pickedHolderId;

  const stockQ = useAsync(
    () => (holderId ? listHolderStock(holderId) : Promise.resolve([] as StockMatrixRow[])),
    [holderId],
  );
  // Cached under ['stock', uid, 'counts', holderId] so recording a count
  // refreshes this line immediately instead of leaving a stale "last counted".
  const lastCountQ = useLastCount(holderId);

  // Holders: active agents + warehouse PLACES (staff never hold stock).
  const holderOptions = useMemo(
    () =>
      (usersQ.data ?? [])
        .filter((u) => u.is_active && (u.role === 'agent' || isWarehousePlace(u)))
        .map((u) => ({
          value: u.id,
          label: u.display_name,
          sub: isWarehousePlace(u) ? 'Warehouse' : 'Rider',
        })),
    [usersQ.data],
  );
  const selectedHolder = useMemo(
    () => (usersQ.data ?? []).find((u) => u.id === holderId) ?? null,
    [usersQ.data, holderId],
  );
  const holderIsWarehouse = selectedHolder ? isWarehousePlace(selectedHolder) : false;

  const products = useMemo(
    () => (stockQ.data ?? []).slice().sort((a, b) => a.product_name.localeCompare(b.product_name)),
    [stockQ.data],
  );

  // Per-row parse: blank = "not counted"; digits = a physical count (0 allowed).
  const rows = products.map((p) => {
    const raw = counted[p.product_catalog_id];
    const parsed = raw !== undefined && raw.trim() !== '' ? Number(raw) : null;
    const variance = parsed === null ? null : parsed - p.quantity_on_hand;
    return { p, counted: parsed, variance };
  });
  const countedRows = rows.filter((r) => r.counted !== null);
  const matchCount = countedRows.filter((r) => r.variance === 0).length;
  const offCount = countedRows.filter((r) => r.variance !== 0).length;
  const todoCount = rows.length - countedRows.length;

  // Search + chip narrowing. The Shomolu shelf carries ~130 products, so a flat
  // list is unworkable on a phone: "To count" is the working view during a run,
  // "Off" is the review pass before saving. Tallies above stay whole-run.
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (rowFilter !== 'all' && filterSnapshot && !filterSnapshot.has(r.p.product_catalog_id)) {
        return false;
      }
      if (!q) return true;
      return (
        r.p.product_name.toLowerCase().includes(q) || r.p.client_name.toLowerCase().includes(q)
      );
    });
    // `rows` is rebuilt every render (it reads the `counted` map), so depend on
    // its inputs rather than the array identity.
  }, [products, counted, query, rowFilter, filterSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Tapping a chip re-snapshots, so it doubles as "refresh this view". */
  function selectFilter(next: RowFilter) {
    setRowFilter(next);
    if (next === 'all') {
      setFilterSnapshot(null);
      return;
    }
    const match =
      next === 'todo'
        ? (r: (typeof rows)[number]) => r.counted === null
        : (r: (typeof rows)[number]) => r.counted !== null && r.variance !== 0;
    setFilterSnapshot(new Set(rows.filter(match).map((r) => r.p.product_catalog_id)));
  }

  /** Clear the working state that belongs to one holder's list. */
  function resetListState() {
    setCounted({});
    setQuery('');
    setRowFilter('all');
    setFilterSnapshot(null);
  }

  const lastCountAt = lastCountQ.data?.[0]?.counted_at ?? null;

  async function handleSave() {
    setError(null);
    if (holderError) {
      setError(holderError);
      return;
    }
    if (!holderId) {
      setError('Pick a holder to count');
      return;
    }
    const items = countedRows.map((r) => ({
      productCatalogId: r.p.product_catalog_id,
      countedQty: r.counted as number,
    }));
    if (items.length === 0) {
      setError('Enter at least one counted quantity');
      return;
    }
    setSaving(true);
    try {
      await recordStockCount(batchId, holderId, items, note.trim() || null);
      const offs: OffRow[] = countedRows
        .filter((r) => r.variance !== 0)
        .map((r) => ({
          name: r.p.product_name,
          expected: r.p.quantity_on_hand,
          counted: r.counted as number,
          variance: r.variance as number,
        }));
      setResult({ total: countedRows.length, matched: matchCount, offs });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  /** Reset for a fresh run — including a new batch id, so the next count is its
   *  own row in the history rather than a silent no-op against the last one. */
  function startAnotherRun() {
    setResult(null);
    setNote('');
    resetListState();
    setBatchId(newClientUuid());
    if (!isWarehouseScope) setPickedHolderId(null);
  }

  if (usersQ.loading && !usersQ.data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.black} />
      </View>
    );
  }

  // ---- Result view (after saving) -----------------------------------------
  if (result) {
    const { total, matched, offs } = result;
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <View style={[styles.banner, offs.length === 0 ? styles.bannerOk : styles.bannerWarn]}>
          <Text style={styles.bannerTitle}>
            {offs.length === 0
              ? `All ${matched} counted ${matched === 1 ? 'product' : 'products'} match ✓`
              : `${offs.length} of ${total} ${offs.length === 1 ? 'product is' : 'products are'} off`}
          </Text>
          <Text style={styles.bannerSub}>
            Count recorded — this did not change any stock. To fix a variance, re-count first, then
            make a deliberate Adjustment.
          </Text>
        </View>

        {offs.length > 0 ? (
          <View style={styles.card}>
            {offs.map((o, i) => (
              <VarianceRow
                key={o.name}
                productName={o.name}
                expected={o.expected}
                counted={o.counted}
                variance={o.variance}
                divider={i > 0}
              />
            ))}
          </View>
        ) : null}

        {holderId ? (
          <Button
            title="Trace movements for this holder"
            variant="secondary"
            onPress={() =>
              router.replace({ pathname: movementsRoute(scope), params: { holderId } })
            }
          />
        ) : null}
        <Button
          // Warehouse scope only ever counts its own shelf, so the reset is a
          // fresh run on the same place rather than a different holder.
          title={isWarehouseScope ? 'Start another count' : 'Count another holder'}
          variant="secondary"
          style={styles.spacer}
          onPress={startAnotherRun}
        />
        <Button title="Done" style={styles.spacer} onPress={() => router.back()} />
      </ScrollView>
    );
  }

  // ---- Count entry view ----------------------------------------------------
  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {isWarehouseScope ? (
        <View style={styles.lockedHolderBox}>
          <Text style={styles.lockedHolderLabel}>Counting stock for</Text>
          {holderError ? (
            <Text style={styles.errorText}>{holderError}</Text>
          ) : (
            <Text style={styles.lockedHolderValue}>
              {warehouseHolder?.ok ? warehouseHolder.placeName : currentUser.displayName}
            </Text>
          )}
        </View>
      ) : (
        <Select
          label="Holder (shelf or rider)"
          required
          value={holderId}
          options={holderOptions}
          onChange={(v) => {
            setPickedHolderId(v);
            resetListState();
          }}
          searchable
          searchPlaceholder="Search agent or warehouse…"
        />
      )}

      {holderIsWarehouse ? (
        <Text style={styles.hint}>
          This counts the {selectedHolder?.display_name} shelf only — stock already issued to riders
          isn&apos;t included.
          {isWarehouseScope ? ' Riders are counted by an admin or dispatcher.' : ''}
        </Text>
      ) : null}
      {lastCountAt ? (
        <Text style={styles.hint}>Last counted {relativeTime(lastCountAt)}.</Text>
      ) : null}

      {holderId ? (
        stockQ.loading && !stockQ.data ? (
          <View style={styles.centerPad}>
            <ActivityIndicator color={colors.black} />
          </View>
        ) : products.length === 0 ? (
          <Text style={styles.empty}>
            This holder currently holds no stock in the app. Nothing to count.
          </Text>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Enter what you physically counted</Text>

            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search products or clients"
              placeholderTextColor={colors.textSecondary}
              autoCorrect={false}
              autoCapitalize="none"
            />
            <View style={styles.chipRow}>
              <Chip
                label={`All ${rows.length}`}
                active={rowFilter === 'all'}
                onPress={() => selectFilter('all')}
              />
              <Chip
                label={`To count ${todoCount}`}
                active={rowFilter === 'todo'}
                onPress={() => selectFilter('todo')}
              />
              <Chip
                label={`Off ${offCount}`}
                active={rowFilter === 'off'}
                onPress={() => selectFilter('off')}
              />
            </View>
            {rowFilter !== 'all' ? (
              <Text style={styles.hint}>
                Showing what matched when you tapped the filter — tap it again to refresh.
              </Text>
            ) : null}

            {visibleRows.length === 0 ? (
              <Text style={styles.empty}>
                {rowFilter === 'todo'
                  ? 'Every product here has been counted.'
                  : rowFilter === 'off'
                    ? 'Nothing counted so far is off.'
                    : 'No products match that search.'}
              </Text>
            ) : (
              <View style={styles.card}>
                {visibleRows.map(({ p, counted: c, variance }, i) => (
                  <View key={p.product_catalog_id} style={[styles.row, i > 0 && styles.rowDivider]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pName} numberOfLines={1}>
                        {p.product_name}
                      </Text>
                      <Text style={styles.pSub} numberOfLines={1}>
                        {p.client_name} · App: {p.quantity_on_hand}
                      </Text>
                    </View>
                    <TextInput
                      style={styles.countInput}
                      value={counted[p.product_catalog_id] ?? ''}
                      onChangeText={(t) =>
                        setCounted((s) => ({
                          ...s,
                          [p.product_catalog_id]: t.replace(/[^0-9]/g, ''),
                        }))
                      }
                      keyboardType="number-pad"
                      placeholder="—"
                      placeholderTextColor={colors.textSecondary}
                      maxLength={6}
                    />
                    <View style={styles.statusCell}>
                      {c === null ? (
                        <Text style={styles.statusMuted}>—</Text>
                      ) : variance === 0 ? (
                        <Text style={styles.statusOk}>✓</Text>
                      ) : (
                        <Text
                          style={[
                            styles.statusOff,
                            (variance ?? 0) > 0 ? styles.varPos : styles.varNeg,
                          ]}
                        >
                          {(variance ?? 0) > 0 ? '+' : ''}
                          {variance}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {countedRows.length} of {rows.length} counted · {matchCount} match · {offCount} off
              </Text>
            </View>

            <Field
              label="Note"
              value={note}
              onChangeText={setNote}
              multiline
              placeholder="Optional — e.g. month-end count"
            />
          </>
        )
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button
        title="Save count"
        onPress={handleSave}
        loading={saving}
        disabled={!holderId || countedRows.length === 0}
      />
      <Text style={styles.saveNote}>Recording a count won&apos;t change the app&apos;s stock.</Text>
      <Button
        title="Cancel"
        variant="secondary"
        style={styles.spacer}
        onPress={() => router.back()}
      />
    </ScrollView>
  );
}

/** Local to this screen rather than the shared ui FilterChips: that one is
 *  full-bleed (it owns its own horizontal padding for edge-to-edge lists) and
 *  this list sits inside an already-padded ScrollView. */
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.chipHit]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.white },
  content: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  centerPad: { paddingVertical: 32, alignItems: 'center' },
  sectionLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 4,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    backgroundColor: colors.white,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  pName: { fontFamily: fonts.semibold, fontSize: 14, color: colors.black },
  pSub: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  countInput: {
    width: 64,
    height: 40,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    textAlign: 'center',
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.black,
    paddingVertical: 0,
  },
  statusCell: { width: 40, alignItems: 'center' },
  statusMuted: { fontFamily: fonts.medium, fontSize: 14, color: colors.border },
  statusOk: { fontFamily: fonts.bold, fontSize: 16, color: colors.success },
  statusOff: { fontFamily: fonts.bold, fontSize: 14 },
  varPos: { color: colors.success },
  varNeg: { color: colors.red },
  summary: {
    marginTop: 10,
    marginBottom: 4,
    paddingVertical: 8,
    alignItems: 'center',
  },
  summaryText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary },
  hint: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginBottom: 10 },
  search: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.black,
    marginBottom: 8,
  },
  chipRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  chipActive: { backgroundColor: colors.black, borderColor: colors.black },
  chipHit: { opacity: 0.85 },
  chipText: { fontFamily: fonts.bold, fontSize: 12, color: colors.textSecondary },
  chipTextActive: { color: colors.white },
  lockedHolderBox: {
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface,
    marginBottom: 12,
  },
  lockedHolderLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  lockedHolderValue: { fontFamily: fonts.semibold, fontSize: 16, color: colors.black },
  empty: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: 28,
  },
  errorBox: { backgroundColor: colors.redSoft, padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: colors.red, fontFamily: fonts.medium, fontSize: 14 },
  saveNote: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: 8,
  },
  spacer: { marginTop: 12 },
  banner: { borderRadius: 12, padding: 14, marginBottom: 14 },
  bannerOk: { backgroundColor: colors.successSoft },
  bannerWarn: { backgroundColor: colors.warningSoft },
  bannerTitle: { fontFamily: fonts.bold, fontSize: 15, color: colors.black },
  bannerSub: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 4 },
});
