import { useEffect, useMemo, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select, type SelectOption } from '@/components/Select';
import { Icon } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useBulkRows } from '@/hooks/useBulkRows';
import { useCurrentUser } from '@/hooks/useAuth';
import { isWarehousePlace } from '@/services/users';
import { useUsers, useProducts } from '@/hooks/queries';
import { listHolderStock, ADJUSTMENT_REASONS, type SingleReason } from '@/services/stock';
import { useEnqueueStockAdjustment } from '@/queue/mutations';
import { useQueuedSubmit } from '@/queue/useQueuedSubmit';
import { errorMessage } from '@/lib/errors';
import { resolveWarehouseHolder } from '@/lib/stock-helpers';

// How a partial/failed bulk adjustment reads in the inline error. Each row is
// an independent queued job, so 2 of 3 can land — say so rather than implying
// the whole batch failed.
function adjustFailureMessage(failed: number, total: number, firstReason: string): string {
  return total === 1
    ? firstReason
    : `${total - failed} of ${total} applied; ${failed} failed: ${firstReason}`;
}

/**
 * Stock adjustment screen — multi-row.
 *
 * One holder, one reason, N products. Each row enqueues an independent
 * `create_stock_adjustment` job, the same shape Receive and Transfer already
 * use; nothing about adjustments was ever single-product except this form.
 * The case that forced it: an agent delivers three items off-app and every
 * one of them needed a separate pass through user → client → product → reason.
 *
 * Sign comes from the REASON, not from the typist. loss/theft/damaged always
 * remove, found always adds, and the server rejects the wrong sign anyway — so
 * rows take a plain positive quantity. `correction` is the one either-sign
 * reason, and gets an explicit Add/Remove choice for the whole batch.
 *
 * The product picker follows the direction: removing lists only what the holder
 * actually holds (with on-hand shown, and validated cumulatively across rows so
 * two rows for the same product can't overdraw it); adding lists the catalog,
 * since you can find or correct-in something the books have at zero.
 *
 * `scope` toggles two behaviors:
 *  - admin:     full holder picker (active agents + warehouse places), all
 *               adjustment reasons including `correction`.
 *  - warehouse: holder locked to the caller's PLACE (resolveWarehouseHolder —
 *               a staff id would 42501); `correction` hidden, matching the
 *               create_stock_adjustment warehouse branch.
 */
export type StockAdjustScreenProps = {
  scope: 'admin' | 'warehouse';
};

/** Which way the whole batch moves stock. Derived from the reason except for
 *  `correction`, where the operator picks. */
type Direction = 'remove' | 'add';

type AdjustRow = {
  id: string;
  productId: string | null;
  quantity: string;
};

const makeRow = (): AdjustRow => ({
  id: Math.random().toString(36).slice(2),
  productId: null,
  quantity: '',
});

/** Mirrors the sign rules inside create_stock_adjustment: loss/theft/damaged
 *  demand a negative delta, found demands a positive one, correction takes
 *  either. Keeping the mapping here means the form can't offer a combination
 *  the server would reject. */
function directionFor(reason: SingleReason | null, correctionDir: Direction): Direction | null {
  if (!reason) return null;
  if (reason === 'found') return 'add';
  if (reason === 'correction') return correctionDir;
  return 'remove';
}

export function StockAdjustScreen({ scope }: StockAdjustScreenProps) {
  const currentUser = useCurrentUser();
  const usersQ = useUsers();
  // Inactive included: a retired product's leftover units still get lost,
  // damaged or corrected off the books, and the server allows writing them
  // DOWN. `found` is the one reason that must stay active-only (below).
  const productsQ = useProducts({ includeInactive: true });

  // Optional deep-link prefill from the count history, so "Make an adjustment"
  // on a variance lands here with the holder and product already chosen. The
  // legacy `clientId` param is accepted and ignored — the picker is no longer
  // scoped per client, so it has nothing left to do.
  const params = useLocalSearchParams<{
    holderId?: string;
    productId?: string;
    clientId?: string;
  }>();

  const [holderId, setHolderId] = useState<string | null>(params.holderId ?? null);
  const [reason, setReason] = useState<SingleReason | null>(null);
  const [correctionDir, setCorrectionDir] = useState<Direction>('remove');
  const [notes, setNotes] = useState('');
  const { rows, setRows, addRow, removeRow, updateRow, resetRows } =
    useBulkRows<AdjustRow>(makeRow);

  const enqueueAdj = useEnqueueStockAdjustment();
  // Owns submit state + "stay on-screen until the queued jobs settle".
  const { submitting, setSubmitting, error, setError, finish, retrying } =
    useQueuedSubmit(adjustFailureMessage);

  const activeUsers = useMemo(
    () =>
      (usersQ.data ?? []).filter((u) => u.is_active && (u.role === 'agent' || isWarehousePlace(u))),
    [usersQ.data],
  );

  // Warehouse scope: resolve the PLACE this caller acts on (fail loud rather
  // than defaulting to the caller's own id, which the server rejects).
  const warehouseHolder = useMemo(
    () =>
      scope === 'warehouse'
        ? resolveWarehouseHolder(
            {
              userId: currentUser.userId,
              warehouseId: currentUser.warehouseId,
              displayName: currentUser.displayName,
            },
            usersQ.data ?? undefined,
          )
        : null,
    [scope, currentUser.userId, currentUser.warehouseId, currentUser.displayName, usersQ.data],
  );
  const effectiveHolderId =
    scope === 'warehouse' ? (warehouseHolder?.ok ? warehouseHolder.holderId : null) : holderId;
  const placeName = warehouseHolder?.ok ? warehouseHolder.placeName : currentUser.displayName;
  const holderError = warehouseHolder && !warehouseHolder.ok ? warehouseHolder.reason : null;

  const direction = directionFor(reason, correctionDir);

  // The holder's on-hand: the option list when removing, context when adding.
  const holderStockQ = useAsync(
    () => (effectiveHolderId ? listHolderStock(effectiveHolderId) : Promise.resolve([])),
    [effectiveHolderId],
  );

  // One option list per direction, plus the lookups validation and labels need.
  // Removing can only touch what's actually held; adding spans the catalog,
  // because a `found` or a positive `correction` is precisely the case where
  // the books say zero.
  const { productOptions, onHandById, productNameById } = useMemo(() => {
    const onHand = new Map<string, number>();
    const name = new Map<string, string>();
    for (const r of holderStockQ.data ?? []) {
      onHand.set(r.product_catalog_id, r.quantity_on_hand);
      name.set(r.product_catalog_id, r.product_name);
    }
    for (const p of productsQ.data ?? []) name.set(p.id, p.product_name);

    const options: SelectOption<string>[] = [];
    if (direction === 'remove') {
      for (const r of holderStockQ.data ?? []) {
        if (r.quantity_on_hand <= 0) continue;
        options.push({
          value: r.product_catalog_id,
          label: r.product_name,
          sub: `${r.client_name} · ${r.quantity_on_hand} on hand`,
        });
      }
    } else if (direction === 'add') {
      for (const p of productsQ.data ?? []) {
        // Nobody may "find" more of a product the catalog has retired — the
        // server raises on it. A positive `correction` is still allowed.
        if (reason === 'found' && !p.is_active) continue;
        const n = onHand.get(p.id) ?? 0;
        const bits = [p.client_name];
        if (n > 0) bits.push(`${n} on hand`);
        if (!p.is_active) bits.push('discontinued');
        options.push({ value: p.id, label: p.product_name, sub: bits.join(' · ') });
      }
    }
    return { productOptions: options, onHandById: onHand, productNameById: name };
  }, [holderStockQ.data, productsQ.data, direction, reason]);

  // Honour the deep-linked product once the options it belongs to have arrived.
  // Guarded by a ref so it fires once and never fights a later manual change.
  const prefillDoneRef = useRef(!params.productId);
  useEffect(() => {
    if (prefillDoneRef.current) return;
    if (productOptions.length === 0) return;
    const pid = params.productId;
    if (!pid || !productOptions.some((o) => o.value === pid)) return;
    prefillDoneRef.current = true;
    setRows((rs) => (rs[0] ? [{ ...rs[0], productId: pid }, ...rs.slice(1)] : rs));
  }, [productOptions, params.productId, setRows]);

  // Changing the holder or the direction invalidates picked products (they
  // belong to the old option set) — clear the rows. Ref-guarded so it only
  // fires on a real change, not on mount over a deep-linked prefill.
  const prevScopeRef = useRef(`${effectiveHolderId ?? ''}|${direction ?? ''}`);
  useEffect(() => {
    const key = `${effectiveHolderId ?? ''}|${direction ?? ''}`;
    if (prevScopeRef.current !== key) {
      prevScopeRef.current = key;
      resetRows();
    }
  }, [effectiveHolderId, direction, resetRows]);

  async function handleSubmit() {
    setError(null);
    if (scope === 'warehouse' && warehouseHolder && !warehouseHolder.ok) {
      return setError(warehouseHolder.reason);
    }
    if (!effectiveHolderId) return setError('Pick whose stock is being adjusted');
    if (!reason || !direction) return setError('Pick a reason');

    const validRows: { productId: string; qty: number }[] = [];
    // Running total per product, so the same product across two rows is checked
    // against on-hand cumulatively rather than row-by-row.
    const neededByProduct = new Map<string, number>();
    for (const r of rows) {
      const empty = !r.productId && !r.quantity;
      if (empty) continue;
      if (!r.productId) return setError('Each row needs a product');
      const q = Number(r.quantity);
      if (!Number.isInteger(q) || q <= 0) {
        return setError('Each row needs a positive whole-number quantity');
      }
      if (direction === 'remove') {
        const running = (neededByProduct.get(r.productId) ?? 0) + q;
        neededByProduct.set(r.productId, running);
        const onHand = onHandById.get(r.productId) ?? 0;
        if (running > onHand) {
          const name = productNameById.get(r.productId) ?? 'A product';
          return setError(
            running > q
              ? `${name}: rows need ${running} but only ${onHand} on hand`
              : `${name}: only ${onHand} on hand`,
          );
        }
      }
      validRows.push({ productId: r.productId, qty: q });
    }
    if (validRows.length === 0) return setError('Add at least one row');

    setSubmitting(true);
    try {
      const reasonLabel = ADJUSTMENT_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const holderLabel =
        scope === 'warehouse'
          ? placeName
          : (activeUsers.find((u) => u.id === effectiveHolderId)?.display_name ?? 'holder');
      const ids: string[] = [];
      for (const row of validRows) {
        const delta = direction === 'remove' ? -row.qty : row.qty;
        const label = `${reasonLabel} · ${delta > 0 ? '+' : ''}${delta} ${
          productNameById.get(row.productId) ?? 'product'
        } · ${holderLabel}`;
        ids.push(
          await enqueueAdj(
            {
              agentId: effectiveHolderId,
              productCatalogId: row.productId,
              quantityDelta: delta,
              reason,
              notes: notes.trim() || null,
            },
            label,
          ),
        );
      }
      finish(ids);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (usersQ.loading || productsQ.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const isWarehouseScope = scope === 'warehouse';
  // Warehouse path drops `correction` — that's the books-override escape hatch
  // and the SQL guard refuses it for non-admin callers anyway.
  const reasonOptions = ADJUSTMENT_REASONS.filter(
    (r) => scope === 'admin' || r.value !== 'correction',
  ).map((r) => ({
    value: r.value,
    label: r.label,
    sub:
      r.sign === 'negative'
        ? 'Removes stock'
        : r.sign === 'positive'
          ? 'Adds stock'
          : 'Adds or removes',
  }));
  const holderOptions = activeUsers.map((u) => ({
    value: u.id,
    label: u.display_name,
    sub: isWarehousePlace(u) ? 'Warehouse' : 'Rider',
  }));
  const filledCount = rows.filter((r) => r.productId && Number(r.quantity) > 0).length;

  const productPlaceholder = !effectiveHolderId
    ? 'Pick a holder first'
    : !direction
      ? 'Pick a reason first'
      : holderStockQ.loading
        ? 'Loading…'
        : productOptions.length === 0
          ? direction === 'remove'
            ? 'This holder has no stock to remove'
            : 'No products'
          : 'Search product or client';

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {isWarehouseScope ? (
        <View style={styles.lockedDestBox}>
          <Text style={styles.lockedDestLabel}>Adjusting stock for</Text>
          {holderError ? (
            <Text style={styles.errorText}>{holderError}</Text>
          ) : (
            <Text style={styles.lockedDestValue}>{placeName}</Text>
          )}
        </View>
      ) : (
        <Select
          label="User (agent / warehouse)"
          required
          value={holderId}
          options={holderOptions}
          onChange={setHolderId}
          searchable
          searchPlaceholder="Search agent or warehouse…"
          placeholder="Pick whose stock is being adjusted"
        />
      )}

      <Select
        label="Reason"
        required
        value={reason}
        options={reasonOptions}
        onChange={(v) => setReason(v)}
        placeholder="Pick a reason"
      />

      {/* `correction` is the only either-sign reason, so it's the only one that
          has to ask. Batch-level, because a sitting is all write-offs or all
          write-ons — mixing the two is two deliberate passes. */}
      {reason === 'correction' ? (
        <View style={styles.dirRow}>
          <DirChip
            label="Remove stock"
            active={correctionDir === 'remove'}
            onPress={() => setCorrectionDir('remove')}
          />
          <DirChip
            label="Add stock"
            active={correctionDir === 'add'}
            onPress={() => setCorrectionDir('add')}
          />
        </View>
      ) : null}

      {direction ? (
        <Text style={styles.hint}>
          {direction === 'remove'
            ? 'Quantities are how many to take OFF the books.'
            : 'Quantities are how many to put ON the books.'}
        </Text>
      ) : null}

      {rows.map((row, i) => (
        <View key={row.id} style={styles.rowCard}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowTitle}>Item {i + 1}</Text>
            {rows.length > 1 ? (
              <Pressable onPress={() => removeRow(row.id)} hitSlop={6}>
                <Icon name="x" size={18} color="#a02d1b" />
              </Pressable>
            ) : null}
          </View>
          <Select
            label="Product"
            required
            searchable
            searchPlaceholder="Search product or client"
            value={row.productId}
            options={productOptions}
            onChange={(v) => updateRow(row.id, { productId: v })}
            disabled={productOptions.length === 0}
            placeholder={productPlaceholder}
          />
          <Field
            label={direction === 'add' ? 'Quantity to add' : 'Quantity to remove'}
            required
            value={row.quantity}
            onChangeText={(v) => updateRow(row.id, { quantity: v.replace(/[^0-9]/g, '') })}
            keyboardType="number-pad"
            autoCapitalize="none"
          />
        </View>
      ))}

      <Button
        title="+ Add another item"
        onPress={addRow}
        variant="secondary"
        style={styles.addRow}
        disabled={productOptions.length === 0}
      />

      <Field
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="Optional — why the books are changing"
      />

      {error || usersQ.error || productsQ.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? usersQ.error ?? productsQ.error}</Text>
        </View>
      ) : null}

      <Button
        title={`Apply ${filledCount} ${filledCount === 1 ? 'adjustment' : 'adjustments'}`}
        onPress={handleSubmit}
        loading={submitting}
        disabled={!!holderError || filledCount === 0}
      />
      {retrying ? (
        <Text style={styles.retryNote}>
          Still trying to reach the server — tap Cancel to finish in the background.
        </Text>
      ) : null}
      <Button
        title="Cancel"
        onPress={() => router.back()}
        variant="secondary"
        style={styles.cancel}
      />
    </ScrollView>
  );
}

function DirChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.dirChip, active && styles.dirChipActive]}
    >
      <Text style={[styles.dirChipText, active && styles.dirChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  errorBox: {
    backgroundColor: '#fdecea',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    marginTop: 4,
  },
  errorText: { color: '#a02d1b', fontSize: 14 },
  retryNote: { fontSize: 12, color: '#666', textAlign: 'center', marginTop: 10 },
  hint: { fontSize: 12, color: '#666', marginTop: -4, marginBottom: 4, fontStyle: 'italic' },
  dirRow: { flexDirection: 'row', gap: 8, marginBottom: 12, marginTop: -4 },
  dirChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  dirChipActive: { backgroundColor: '#111', borderColor: '#111' },
  dirChipText: { fontSize: 13, fontWeight: '700', color: '#666' },
  dirChipTextActive: { color: '#fff' },
  rowCard: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#fafafa',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  rowTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#666',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  addRow: { marginTop: 12 },
  cancel: { marginTop: 12 },
  lockedDestBox: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#fafafa',
    marginBottom: 12,
  },
  lockedDestLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  lockedDestValue: { fontSize: 16, fontWeight: '600', color: '#111' },
});
