import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { Icon } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useBulkRows } from '@/hooks/useBulkRows';
import { useCurrentUser } from '@/hooks/useAuth';
import { listUsers, isWarehousePlace } from '@/services/users';
import { listClients } from '@/services/clients';
import { listActiveProductsByClient } from '@/services/products';
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
 */
type ReceiveRow = {
  id: string;
  clientId: string | null;
  productId: string | null;
  quantity: string;
};

const makeRow = (): ReceiveRow => ({
  id: Math.random().toString(36).slice(2),
  clientId: null,
  productId: null,
  quantity: '',
});

type Product = { id: string; product_name: string };

export type StockReceiveScreenProps = {
  scope: 'admin' | 'warehouse';
};

export function StockReceiveScreen({ scope }: StockReceiveScreenProps) {
  const currentUser = useCurrentUser();
  const usersQ = useAsync(() => listUsers(), []);
  const clientsQ = useAsync(() => listClients(), []);

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

  // Cache products per client across rows so we don't re-fetch the same list.
  const [productsByClient, setProductsByClient] = useState<Map<string, Product[]>>(new Map());
  const ensureProductsFor = useCallback(
    async (clientId: string) => {
      if (productsByClient.has(clientId)) return;
      try {
        const list = await listActiveProductsByClient(clientId);
        setProductsByClient((m) => {
          const next = new Map(m);
          next.set(
            clientId,
            list.map((x) => ({ id: x.id, product_name: x.product_name })),
          );
          return next;
        });
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [productsByClient, setError],
  );

  function patchRow(id: string, patch: Partial<ReceiveRow>) {
    if (patch.clientId !== undefined) {
      const current = rows.find((r) => r.id === id);
      if (current && patch.clientId !== current.clientId) {
        updateRow(id, { ...patch, productId: null });
        return;
      }
    }
    updateRow(id, patch);
  }

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

    const validRows: { clientId: string; productId: string; qty: number }[] = [];
    for (const r of rows) {
      const empty = !r.clientId && !r.productId && !r.quantity;
      if (empty) continue;
      if (!r.clientId) {
        setError('Each row needs a client');
        return;
      }
      if (!r.productId) {
        setError('Each row needs a product');
        return;
      }
      const q = Number(r.quantity);
      if (!Number.isInteger(q) || q <= 0) {
        setError('Each row needs a positive whole-number quantity');
        return;
      }
      validRows.push({ clientId: r.clientId, productId: r.productId, qty: q });
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
        const product = productsByClient.get(row.clientId)?.find((p) => p.id === row.productId);
        const label = `Bulk intake · +${row.qty} ${product?.product_name ?? 'product'} · ${destLabel}`;
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

  if (usersQ.loading || clientsQ.loading) {
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
  const clientOptions = (clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name }));
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

      {rows.map((row, i) => {
        const rowProducts = row.clientId ? (productsByClient.get(row.clientId) ?? []) : [];
        return (
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
              label="Client"
              required
              value={row.clientId}
              options={clientOptions}
              onChange={(v) => {
                patchRow(row.id, { clientId: v });
                if (v) void ensureProductsFor(v);
              }}
            />
            <Select
              label="Product"
              required
              value={row.productId}
              options={rowProducts.map((p) => ({ value: p.id, label: p.product_name }))}
              onChange={(v) => patchRow(row.id, { productId: v })}
              disabled={!row.clientId || rowProducts.length === 0}
              placeholder={
                !row.clientId
                  ? 'Pick a client first'
                  : rowProducts.length === 0
                    ? 'No products for this client'
                    : 'Choose'
              }
            />
            <Field
              label="Quantity"
              required
              value={row.quantity}
              onChangeText={(v) => patchRow(row.id, { quantity: v })}
              keyboardType="numeric"
              autoCapitalize="none"
            />
          </View>
        );
      })}

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
        placeholder="Optional — e.g. Invoice #1234, Aernings May restock"
      />

      {error || usersQ.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? usersQ.error}</Text>
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
  return rows.filter((r) => r.clientId && r.productId && Number(r.quantity) > 0).length;
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
