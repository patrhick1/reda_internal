import { useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
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
import { listHolderStock } from '@/services/stock';
import { useEnqueueStockAdjustment } from '@/queue/mutations';
import { useQueuedSubmit } from '@/queue/useQueuedSubmit';
import { errorMessage } from '@/lib/errors';
import { resolveWarehouseHolder } from '@/lib/stock-helpers';

// How a partial/failed bulk intake reads in the inline error.
function receiveFailureMessage(failed: number, total: number, firstReason: string): string {
  return total === 1
    ? firstReason
    : `${total - failed} of ${total} recorded; ${failed} failed: ${firstReason}`;
}

/**
 * Bulk vendor intake screen. Each row enqueues an independent
 * `create_stock_adjustment` job with reason='bulk_intake' against a
 * destination user.
 *
 * `scope` toggles two behaviors:
 *  - admin:     destination is a picker over (active agents + warehouses).
 *               Mirrors the original /(admin)/stock/receive.tsx exactly.
 *  - warehouse: destination is locked to the caller (the warehouse user
 *               IS the place where intake lands). Picker hidden, hint
 *               reworded accordingly. Mirrors the server-side guard
 *               `p_agent_id = auth.uid()` in create_stock_adjustment.
 *
 * Product selection is a single searchable picker over ALL active products
 * (searchable by product or client name) — intake adds new stock, so it is NOT
 * limited to what's on hand. The destination's current on-hand is shown as
 * context where it carries the product, so the operator never has to know which
 * client owns it.
 */
type ReceiveRow = {
  id: string;
  productId: string | null;
  quantity: string;
};

const makeRow = (): ReceiveRow => ({
  id: Math.random().toString(36).slice(2),
  productId: null,
  quantity: '',
});

export type StockReceiveScreenProps = {
  scope: 'admin' | 'warehouse';
};

export function StockReceiveScreen({ scope }: StockReceiveScreenProps) {
  const currentUser = useCurrentUser();
  const usersQ = useUsers();
  const productsQ = useProducts();

  // Holders only: agents + warehouse PLACES. Warehouse STAFF (linked to a
  // place) are never holders — they act on their place's books — so they're
  // excluded from destination lists.
  const activeUsers = useMemo(
    () =>
      (usersQ.data ?? []).filter((u) => u.is_active && (u.role === 'agent' || isWarehousePlace(u))),
    [usersQ.data],
  );
  const warehouseUsers = useMemo(
    () => activeUsers.filter((u) => u.role === 'warehouse'),
    [activeUsers],
  );

  // Admin scope: a pickable destination. Warehouse scope derives the place
  // (warehouseHolder) so it can't silently fall back to the caller's own id.
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const enqueueAdj = useEnqueueStockAdjustment();
  // Owns submit state + "stay on-screen until the queued jobs settle".
  const { submitting, setSubmitting, error, setError, finish, retrying } =
    useQueuedSubmit(receiveFailureMessage);

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
  const effectiveDestinationId =
    scope === 'warehouse' ? (warehouseHolder?.ok ? warehouseHolder.holderId : null) : destinationId;
  const placeName = warehouseHolder?.ok ? warehouseHolder.placeName : currentUser.displayName;
  const holderError = warehouseHolder && !warehouseHolder.ok ? warehouseHolder.reason : null;

  // Admin path: auto-select the only active warehouse if there's exactly one.
  // Warehouse path: destination is already locked to caller; no auto-select.
  useEffect(() => {
    if (scope === 'warehouse') return;
    if (destinationId) return;
    const only = warehouseUsers[0];
    if (warehouseUsers.length === 1 && only) {
      setDestinationId(only.id);
    }
  }, [scope, warehouseUsers, destinationId]);

  const { rows, addRow, removeRow, updateRow } = useBulkRows<ReceiveRow>(makeRow);

  // Current on-hand at the destination — shown as context next to each product.
  // Intake still lists ALL products (you can receive something held at 0), so a
  // failure here just drops the context, it doesn't block the picker.
  const destStockQ = useAsync(
    () => (effectiveDestinationId ? listHolderStock(effectiveDestinationId) : Promise.resolve([])),
    [effectiveDestinationId],
  );

  // One option list over all active products, with the destination on-hand
  // folded into the sub. Both product and client name are searchable.
  const { productOptions, productNameById } = useMemo(() => {
    const onHand = new Map<string, number>();
    for (const r of destStockQ.data ?? []) onHand.set(r.product_catalog_id, r.quantity_on_hand);
    const options: SelectOption<string>[] = [];
    const name = new Map<string, string>();
    for (const p of productsQ.data ?? []) {
      name.set(p.id, p.product_name);
      const n = onHand.get(p.id) ?? 0;
      options.push({
        value: p.id,
        label: p.product_name,
        sub: n > 0 ? `${p.client_name} · ${n} on hand` : p.client_name,
      });
    }
    return { productOptions: options, productNameById: name };
  }, [productsQ.data, destStockQ.data]);

  const productPlaceholder = productsQ.loading
    ? 'Loading products…'
    : productsQ.error
      ? 'Could not load products'
      : productOptions.length === 0
        ? 'No products'
        : 'Search product or client';

  async function handleSubmit() {
    setError(null);
    if (scope === 'warehouse' && warehouseHolder && !warehouseHolder.ok) {
      setError(warehouseHolder.reason);
      return;
    }
    if (!effectiveDestinationId) {
      setError('Pick where this stock is going');
      return;
    }

    const validRows: { productId: string; qty: number }[] = [];
    for (const r of rows) {
      const empty = !r.productId && !r.quantity;
      if (empty) continue;
      if (!r.productId) {
        setError('Each row needs a product');
        return;
      }
      const q = Number(r.quantity);
      if (!Number.isInteger(q) || q <= 0) {
        setError('Each row needs a positive whole-number quantity');
        return;
      }
      validRows.push({ productId: r.productId, qty: q });
    }
    if (validRows.length === 0) {
      setError('Add at least one row');
      return;
    }

    setSubmitting(true);
    try {
      const destLabel =
        scope === 'warehouse'
          ? placeName
          : (activeUsers.find((u) => u.id === effectiveDestinationId)?.display_name ??
            'destination');
      const ids: string[] = [];
      for (const row of validRows) {
        const label = `Bulk intake · +${row.qty} ${productNameById.get(row.productId) ?? 'product'} · ${destLabel}`;
        ids.push(
          await enqueueAdj(
            {
              agentId: effectiveDestinationId,
              productCatalogId: row.productId,
              quantityDelta: row.qty,
              reason: 'bulk_intake',
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

  const destinationOptions = activeUsers.map((u) => ({
    value: u.id,
    label: u.display_name,
    sub: u.role,
  }));
  const filledCount = countFilled(rows);
  const isWarehouseScope = scope === 'warehouse';

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {isWarehouseScope ? (
        <View style={styles.lockedDestBox}>
          <Text style={styles.lockedDestLabel}>Receiving into</Text>
          {holderError ? (
            <Text style={styles.errorText}>{holderError}</Text>
          ) : (
            <>
              <Text style={styles.lockedDestValue}>{placeName}</Text>
              <Text style={styles.hint}>
                Stock arriving at the warehouse. Goes onto your books as soon as you save.
              </Text>
            </>
          )}
        </View>
      ) : (
        <>
          <Select
            label="Destination"
            required
            value={destinationId}
            options={destinationOptions}
            onChange={setDestinationId}
            placeholder={
              warehouseUsers.length === 0
                ? 'Add a warehouse user in Catalog first'
                : 'Pick destination'
            }
          />
          <Text style={styles.hint}>
            Stock arrived at warehouse, or directly with an agent in the field.
          </Text>
        </>
      )}

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
            label="Quantity"
            required
            value={row.quantity}
            onChangeText={(v) => updateRow(row.id, { quantity: v })}
            keyboardType="numeric"
            autoCapitalize="none"
          />
        </View>
      ))}

      <Button
        title="+ Add another item"
        onPress={addRow}
        variant="secondary"
        style={styles.addRow}
      />

      <Field
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="Optional — e.g. Invoice #1234, May restock"
      />

      {error || usersQ.error || productsQ.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? usersQ.error ?? productsQ.error}</Text>
        </View>
      ) : null}

      <Button
        title={`Record ${filledCount} ${filledCount === 1 ? 'item' : 'items'}`}
        onPress={handleSubmit}
        loading={submitting}
        disabled={!!holderError}
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

function countFilled(rows: ReceiveRow[]): number {
  return rows.filter((r) => r.productId && Number(r.quantity) > 0).length;
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
  hint: { fontSize: 12, color: '#666', marginTop: -8, marginBottom: 4, fontStyle: 'italic' },
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
