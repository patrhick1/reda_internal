import { useCallback, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { Icon } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useBulkRows } from '@/hooks/useBulkRows';
import { listUsers, type AppUser } from '@/services/users';
import { listClients } from '@/services/clients';
import { listActiveProductsByClient } from '@/services/products';
import { PAIRED_REASONS, type PairedReason } from '@/services/stock';
import { useEnqueueStockTransfer } from '@/queue/mutations';
import { errorMessage } from '@/lib/errors';

// --- Bulk row shape -----------------------------------------------------------
// The agent is shared across all rows (picked once at the top, like the
// warehouse) — Uzo's flow is "one agent finishes collecting all their packages
// before the next agent comes". Per-row (client, product, qty) is what changes.
type BulkRow = {
  id: string;
  clientId: string | null;
  productId: string | null;
  quantity: string;
};

const newRow = (): BulkRow => ({
  id: Math.random().toString(36).slice(2),
  clientId: null,
  productId: null,
  quantity: '',
});

type Product = { id: string; product_name: string };

// Stable reference for useBulkRows so the hook's useCallback deps don't churn.
const makeNewBulkRow = newRow;

export default function NewTransfer() {
  const usersQ = useAsync(() => listUsers(), []);
  const clientsQ = useAsync(() => listClients(), []);

  // Common state
  const [reason, setReason] = useState<PairedReason | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueTransfer = useEnqueueStockTransfer();

  // Single-row state (used for reason === 'transfer')
  const [fromUserId, setFromUserId] = useState<string | null>(null);
  const [toUserId, setToUserId] = useState<string | null>(null);
  const [singleClientId, setSingleClientId] = useState<string | null>(null);
  const [singleProductId, setSingleProductId] = useState<string | null>(null);
  const [singleProducts, setSingleProducts] = useState<Product[]>([]);
  const [singleQty, setSingleQty] = useState('');

  // Bulk state (used for reason === 'warehouse_issue' | 'warehouse_return')
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  // One agent per submission. Drops the per-row picker friction Uzo flagged:
  // "select Nnenna once, then keep adding products she's collecting".
  const [bulkAgentId, setBulkAgentId] = useState<string | null>(null);
  const {
    rows,
    addRow,
    removeRow,
    updateRow: updateBulkRow,
    resetRows,
  } = useBulkRows<BulkRow>(makeNewBulkRow);
  // Cache products by clientId so multiple bulk rows on the same client share a fetch.
  const [productsByClient, setProductsByClient] = useState<Map<string, Product[]>>(new Map());

  const isBulk = reason === 'warehouse_issue' || reason === 'warehouse_return';

  // Reset when reason changes; prompt confirm if user has filled anything.
  function changeReason(next: PairedReason | null) {
    const hadSingleData = !!(fromUserId || toUserId || singleProductId || singleQty);
    const hadBulkData =
      rows.some((r) => r.productId || r.quantity) ||
      rows.length > 1 ||
      !!warehouseId ||
      !!bulkAgentId;
    const anyDirty = hadSingleData || hadBulkData;
    const apply = () => {
      setReason(next);
      setError(null);
      setFromUserId(null);
      setToUserId(null);
      setSingleClientId(null);
      setSingleProductId(null);
      setSingleProducts([]);
      setSingleQty('');
      setWarehouseId(null);
      setBulkAgentId(null);
      resetRows();
    };
    if (!anyDirty) {
      apply();
      return;
    }
    Alert.alert('Switch transfer type?', 'Your current entries will be cleared.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Switch', style: 'destructive', onPress: apply },
    ]);
  }

  // Load single-mode products when the single client changes.
  useEffect(() => {
    let cancelled = false;
    setSingleProductId(null);
    setSingleProducts([]);
    if (!singleClientId) return;
    listActiveProductsByClient(singleClientId)
      .then((p) => {
        if (!cancelled)
          setSingleProducts(p.map((x) => ({ id: x.id, product_name: x.product_name })));
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [singleClientId]);

  // Pre-fill warehouseId when bulk and exactly one active warehouse user exists.
  const activeUsers = useMemo(
    () =>
      (usersQ.data ?? []).filter(
        (u) => u.is_active && (u.role === 'agent' || u.role === 'warehouse'),
      ),
    [usersQ.data],
  );
  const warehouseUsers = useMemo(
    () => activeUsers.filter((u) => u.role === 'warehouse'),
    [activeUsers],
  );
  const agentUsers = useMemo(() => activeUsers.filter((u) => u.role === 'agent'), [activeUsers]);
  useEffect(() => {
    const only = warehouseUsers[0];
    if (isBulk && warehouseUsers.length === 1 && only && !warehouseId) {
      setWarehouseId(only.id);
    }
  }, [isBulk, warehouseUsers, warehouseId]);

  // Fetch + cache products for a client (used by bulk row pickers).
  const ensureProductsFor = useCallback(
    async (clientId: string) => {
      if (productsByClient.has(clientId)) return;
      const list = await listActiveProductsByClient(clientId);
      setProductsByClient((m) => {
        const next = new Map(m);
        next.set(
          clientId,
          list.map((x) => ({ id: x.id, product_name: x.product_name })),
        );
        return next;
      });
    },
    [productsByClient],
  );

  // Wrap updateBulkRow so changing the clientId also resets the productId
  // (you can't keep a product selection when the client changes underneath).
  function updateRow(rowId: string, patch: Partial<BulkRow>) {
    if (patch.clientId !== undefined) {
      const current = rows.find((r) => r.id === rowId);
      if (current && patch.clientId !== current.clientId) {
        updateBulkRow(rowId, { ...patch, productId: null });
        return;
      }
    }
    updateBulkRow(rowId, patch);
  }

  // --------------------------------------------------------------------------
  // Single-mode submit (existing behaviour, unchanged)
  // --------------------------------------------------------------------------
  async function handleSubmitSingle() {
    setError(null);
    if (!reason) {
      setError('Pick a transfer reason');
      return;
    }
    if (!fromUserId) {
      setError('Pick the source user');
      return;
    }
    if (!toUserId) {
      setError('Pick the destination user');
      return;
    }
    if (fromUserId === toUserId) {
      setError('Source and destination must differ');
      return;
    }
    if (!singleProductId) {
      setError('Pick a product');
      return;
    }
    const q = Number(singleQty);
    if (!Number.isInteger(q) || q <= 0) {
      setError('Quantity must be a positive whole number');
      return;
    }
    setSubmitting(true);
    try {
      const reasonLabel = PAIRED_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const productName =
        singleProducts.find((p) => p.id === singleProductId)?.product_name ?? 'product';
      await enqueueTransfer(
        {
          fromUserId,
          toUserId,
          productCatalogId: singleProductId,
          quantity: q,
          reason,
          notes: notes.trim() || null,
        },
        `${reasonLabel} · ${q} ${productName}`,
      );
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  // --------------------------------------------------------------------------
  // Bulk-mode submit — fan out one enqueueTransfer per row, all sharing the
  // same (warehouse, agent) endpoints.
  // --------------------------------------------------------------------------
  async function handleSubmitBulk() {
    setError(null);
    if (!reason || !isBulk) {
      setError('Pick a transfer reason');
      return;
    }
    if (!warehouseId) {
      setError('Pick the warehouse');
      return;
    }
    if (!bulkAgentId) {
      setError('Pick the agent');
      return;
    }

    const validRows: { productId: string; qty: number }[] = [];
    for (const r of rows) {
      // Skip rows that are completely empty (admin added then ignored).
      const completelyEmpty = !r.productId && !r.quantity;
      if (completelyEmpty) continue;
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
      setError('Add at least one product');
      return;
    }

    setSubmitting(true);
    try {
      const reasonLabel = PAIRED_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const agent = agentUsers.find((u) => u.id === bulkAgentId);
      const fromId = reason === 'warehouse_issue' ? warehouseId : bulkAgentId;
      const toId = reason === 'warehouse_issue' ? bulkAgentId : warehouseId;
      for (const row of validRows) {
        const product = productsByClient
          .get(rows.find((r) => r.productId === row.productId)?.clientId ?? '')
          ?.find((p) => p.id === row.productId);
        const label = `${reasonLabel} · ${row.qty} ${product?.product_name ?? 'product'} · ${agent?.display_name ?? 'agent'}`;
        await enqueueTransfer(
          {
            fromUserId: fromId,
            toUserId: toId,
            productCatalogId: row.productId,
            quantity: row.qty,
            reason,
            notes: notes.trim() || null,
          },
          label,
        );
      }
      router.back();
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

  const reasonOptions = PAIRED_REASONS.map((r) => ({ value: r.value, label: r.label, sub: r.sub }));
  const warehouseOptions = warehouseUsers.map((u) => ({ value: u.id, label: u.display_name }));
  const agentOptions = agentUsers.map((u) => ({ value: u.id, label: u.display_name }));
  const clientOptions = (clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name }));

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Select
        label="Reason"
        required
        value={reason}
        options={reasonOptions}
        onChange={(v) => changeReason(v as PairedReason)}
      />

      {reason === 'transfer' ? (
        <SingleForm
          activeUsers={activeUsers}
          fromUserId={fromUserId}
          setFromUserId={setFromUserId}
          toUserId={toUserId}
          setToUserId={setToUserId}
          clientOptions={clientOptions}
          singleClientId={singleClientId}
          setSingleClientId={setSingleClientId}
          singleProducts={singleProducts}
          singleProductId={singleProductId}
          setSingleProductId={setSingleProductId}
          singleQty={singleQty}
          setSingleQty={setSingleQty}
        />
      ) : isBulk ? (
        <>
          <Select
            label={reason === 'warehouse_issue' ? 'From warehouse' : 'To warehouse'}
            required
            value={warehouseId}
            options={warehouseOptions}
            onChange={setWarehouseId}
            placeholder={
              warehouseUsers.length === 0
                ? 'No warehouse user — add one in Catalog'
                : 'Pick warehouse'
            }
            disabled={warehouseUsers.length === 0}
          />
          <Select
            label={reason === 'warehouse_issue' ? 'To agent' : 'From agent'}
            required
            value={bulkAgentId}
            options={agentOptions}
            onChange={setBulkAgentId}
            placeholder="Pick agent"
          />

          {rows.map((row, i) => {
            const rowProducts = row.clientId ? (productsByClient.get(row.clientId) ?? []) : [];
            return (
              <View key={row.id} style={styles.rowCard}>
                <View style={styles.rowHeader}>
                  <Text style={styles.rowTitle}>Product {i + 1}</Text>
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
                    updateRow(row.id, { clientId: v });
                    if (v) void ensureProductsFor(v);
                  }}
                />
                <Select
                  label="Product"
                  required
                  value={row.productId}
                  options={rowProducts.map((p) => ({ value: p.id, label: p.product_name }))}
                  onChange={(v) => updateRow(row.id, { productId: v })}
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
                  onChangeText={(v) => updateRow(row.id, { quantity: v })}
                  keyboardType="numeric"
                  autoCapitalize="none"
                />
              </View>
            );
          })}

          <Button
            title="+ Add another product"
            onPress={addRow}
            variant="secondary"
            style={styles.addRow}
          />
        </>
      ) : null}

      {reason ? (
        <Field
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Optional context — applies to all rows"
        />
      ) : null}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {reason === 'transfer' ? (
        <Button title="Move stock" onPress={handleSubmitSingle} loading={submitting} />
      ) : isBulk ? (
        <Button
          title={bulkSubmitLabel(
            reason,
            countFilled(rows),
            agentUsers.find((u) => u.id === bulkAgentId)?.display_name,
          )}
          onPress={handleSubmitBulk}
          loading={submitting}
        />
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

function countFilled(rows: BulkRow[]): number {
  return rows.filter((r) => r.productId && Number(r.quantity) > 0).length;
}

// Action-oriented button label so the operator sees who they're giving to /
// collecting from. Falls back to a neutral phrasing until the agent is picked.
function bulkSubmitLabel(reason: PairedReason, n: number, agentName: string | undefined): string {
  const word = n === 1 ? 'product' : 'products';
  if (!agentName) {
    return reason === 'warehouse_issue' ? `Issue ${n} ${word}` : `Collect ${n} ${word}`;
  }
  return reason === 'warehouse_issue'
    ? `Issue ${n} ${word} to ${agentName}`
    : `Collect ${n} ${word} from ${agentName}`;
}

// --- Sub-component for the existing single-row UI -----------------------------
function SingleForm(props: {
  activeUsers: AppUser[];
  fromUserId: string | null;
  setFromUserId: (v: string | null) => void;
  toUserId: string | null;
  setToUserId: (v: string | null) => void;
  clientOptions: { value: string; label: string }[];
  singleClientId: string | null;
  setSingleClientId: (v: string | null) => void;
  singleProducts: Product[];
  singleProductId: string | null;
  setSingleProductId: (v: string | null) => void;
  singleQty: string;
  setSingleQty: (v: string) => void;
}) {
  const agentOptions = useMemo(
    () =>
      props.activeUsers
        .filter((u) => u.role === 'agent' && u.id !== props.fromUserId)
        .map((u) => ({ value: u.id, label: u.display_name })),
    [props.activeUsers, props.fromUserId],
  );
  const sourceOptions = useMemo(
    () =>
      props.activeUsers
        .filter((u) => u.role === 'agent')
        .map((u) => ({ value: u.id, label: u.display_name })),
    [props.activeUsers],
  );
  const productOptions = props.singleProducts.map((p) => ({ value: p.id, label: p.product_name }));

  return (
    <>
      <Select
        label="From"
        required
        value={props.fromUserId}
        options={sourceOptions}
        onChange={props.setFromUserId}
      />
      <Select
        label="To"
        required
        value={props.toUserId}
        options={agentOptions}
        onChange={props.setToUserId}
        disabled={!props.fromUserId}
      />
      <Select
        label="Client"
        required
        value={props.singleClientId}
        options={props.clientOptions}
        onChange={props.setSingleClientId}
      />
      <Select
        label="Product"
        required
        value={props.singleProductId}
        options={productOptions}
        onChange={props.setSingleProductId}
        disabled={!props.singleClientId || props.singleProducts.length === 0}
        placeholder={
          !props.singleClientId
            ? 'Pick a client first'
            : props.singleProducts.length === 0
              ? 'No products for this client'
              : 'Choose'
        }
      />
      <Field
        label="Quantity"
        required
        value={props.singleQty}
        onChangeText={props.setSingleQty}
        keyboardType="numeric"
        autoCapitalize="none"
      />
    </>
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
  cancel: { marginTop: 12 },
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
});
