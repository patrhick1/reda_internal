import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { listUsers, isWarehousePlace } from '@/services/users';
import { listHolderStock, type StockMatrixRow } from '@/services/stock';
import {
  recordStockCount,
  listCountsForHolder,
  type StockCountResult,
} from '@/services/stock-counts';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';
import { relativeTime } from '@/lib/date';
import { colors, fonts } from '@/lib/theme';

/**
 * Stock Count & Reconciliation Check — REPORT ONLY.
 *
 * Ops picks a holder (a warehouse shelf or a rider), types the physical count
 * per product, and the app tells them whether each matches the app number and
 * by how much. It records the count as a reference point but NEVER changes the
 * stock ledger. If a variance can't be explained, correcting it stays a
 * separate, deliberate action (the existing admin Adjustment).
 */
export type StockCountScreenProps = { scope: 'admin' | 'dispatcher' };

type OffRow = { name: string; expected: number; counted: number; variance: number };

const BASE_FOR: Record<StockCountScreenProps['scope'], '/(admin)' | '/(dispatcher)'> = {
  admin: '/(admin)',
  dispatcher: '/(dispatcher)',
};

export function StockCountScreen({ scope }: StockCountScreenProps) {
  const basePath = BASE_FOR[scope];
  const usersQ = useAsync(() => listUsers(), []);

  const [holderId, setHolderId] = useState<string | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ res: StockCountResult; offs: OffRow[] } | null>(null);

  const stockQ = useAsync(
    () => (holderId ? listHolderStock(holderId) : Promise.resolve([] as StockMatrixRow[])),
    [holderId],
  );
  const lastCountQ = useAsync(
    () => (holderId ? listCountsForHolder(holderId, 1) : Promise.resolve([])),
    [holderId],
  );

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

  const lastCountAt = lastCountQ.data?.[0]?.counted_at ?? null;

  async function handleSave() {
    setError(null);
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
      const res = await recordStockCount(newClientUuid(), holderId, items, note.trim() || null);
      const offs: OffRow[] = countedRows
        .filter((r) => r.variance !== 0)
        .map((r) => ({
          name: r.p.product_name,
          expected: r.p.quantity_on_hand,
          counted: r.counted as number,
          variance: r.variance as number,
        }));
      setResult({ res, offs });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
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
    const { res, offs } = result;
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <View style={[styles.banner, offs.length === 0 ? styles.bannerOk : styles.bannerWarn]}>
          <Text style={styles.bannerTitle}>
            {offs.length === 0
              ? `All ${res.matched} counted ${res.matched === 1 ? 'product' : 'products'} match ✓`
              : `${res.off} of ${res.recorded} ${res.off === 1 ? 'product is' : 'products are'} off`}
          </Text>
          <Text style={styles.bannerSub}>
            Count recorded — this did not change any stock. To fix a variance, re-count first, then
            make a deliberate Adjustment.
          </Text>
        </View>

        {offs.length > 0 ? (
          <View style={styles.card}>
            {offs.map((o, i) => (
              <View key={o.name} style={[styles.offRow, i > 0 && styles.offRowDivider]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pName}>{o.name}</Text>
                  <Text style={styles.pSub}>
                    App {o.expected} · Counted {o.counted}
                  </Text>
                </View>
                <Text style={[styles.variance, o.variance > 0 ? styles.varPos : styles.varNeg]}>
                  {o.variance > 0 ? '+' : ''}
                  {o.variance}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {holderId ? (
          <Button
            title="Trace movements for this holder"
            variant="secondary"
            onPress={() =>
              router.replace(
                `${basePath}/stock/movements/${holderId}` as `${'/(admin)' | '/(dispatcher)'}/stock/movements/${string}`,
              )
            }
          />
        ) : null}
        <Button
          title="Count another holder"
          variant="secondary"
          style={styles.spacer}
          onPress={() => {
            setResult(null);
            setCounted({});
            setNote('');
            setHolderId(null);
          }}
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
      <Select
        label="Holder (shelf or rider)"
        required
        value={holderId}
        options={holderOptions}
        onChange={(v) => {
          setHolderId(v);
          setCounted({});
        }}
        searchable
        searchPlaceholder="Search agent or warehouse…"
      />

      {holderIsWarehouse ? (
        <Text style={styles.hint}>
          This counts the {selectedHolder?.display_name} shelf only. Stock already issued to riders
          is counted separately per rider.
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
            <View style={styles.card}>
              {rows.map(({ p, counted: c, variance }, i) => (
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

            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {countedRows.length} counted · {matchCount} match · {offCount} off
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
  variance: { fontFamily: fonts.extrabold, fontSize: 16 },
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
  offRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  offRowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
});
