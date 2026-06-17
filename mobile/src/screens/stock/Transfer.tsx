import { useEffect, useMemo, useRef, useState } from 'react';
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
import { Select, type SelectOption } from '@/components/Select';
import { Icon } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useBulkRows } from '@/hooks/useBulkRows';
import { useCurrentUser } from '@/hooks/useAuth';
import { listUsers, isWarehousePlace, type AppUser } from '@/services/users';
import {
  PAIRED_REASONS,
  listHolderStock,
  type PairedReason,
  type StockMatrixRow,
} from '@/services/stock';
import { useEnqueueStockTransfer } from '@/queue/mutations';
import { useQueuedSubmit } from '@/queue/useQueuedSubmit';
import { errorMessage } from '@/lib/errors';
import { resolveWarehouseHolder } from '@/lib/stock-helpers';

// How a partial/failed paired transfer reads in the inline error.
function transferFailureMessage(failed: number, total: number, firstReason: string): string {
  return total === 1
    ? firstReason
    : `${total - failed} of ${total} done; ${failed} failed: ${firstReason}`;
}

/**
 * Paired stock transfer screen.
 *
 * `scope` toggles which reasons + endpoints are available:
 *  - admin:      all three reasons (transfer / warehouse_issue / warehouse_return),
 *                every user pickable as from/to. Mirrors the original
 *                /(admin)/stock/transfer.tsx exactly.
 *  - dispatcher: same as admin — dispatcher coordinates rider stock and is
 *                trusted with both warehouse-issued and agent→agent moves,
 *                without being a participant in either. Server gate mirrors
 *                this (create_stock_transfer admits v_role='dispatcher').
 *  - warehouse:  only warehouse_issue + warehouse_return; the `transfer`
 *                reason is hidden (server-side guard would 42501 anyway).
 *                Warehouse side of the paired transfer is locked to the
 *                caller, matching the create_stock_transfer warehouse
 *                branches (`p_from_user_id = auth.uid()` for issue,
 *                `p_to_user_id = auth.uid()` for return).
 *
 * Product selection is driven by the SOURCE holder's on-hand stock (not by
 * client). Once the source is known, the picker lists exactly what that holder
 * carries — searchable by product or client name, with the on-hand quantity
 * shown — so the operator never has to know which client owns a product.
 */
type BulkRow = {
  id: string;
  productId: string | null;
  quantity: string;
};

const newRow = (): BulkRow => ({
  id: Math.random().toString(36).slice(2),
  productId: null,
  quantity: '',
});

// Stable reference for useBulkRows so the hook's useCallback deps don't churn.
const makeNewBulkRow = newRow;

export type StockTransferScreenProps = {
  scope: 'admin' | 'warehouse' | 'dispatcher';
};

export function StockTransferScreen({ scope }: StockTransferScreenProps) {
  const currentUser = useCurrentUser();
  const usersQ = useAsync(() => listUsers(), []);

  // Common state
  const [reason, setReason] = useState<PairedReason | null>(null);
  const [notes, setNotes] = useState('');
  const enqueueTransfer = useEnqueueStockTransfer();
  // Owns submit state + "stay on-screen until the queued jobs settle".
  const { submitting, setSubmitting, error, setError, finish, retrying } =
    useQueuedSubmit(transferFailureMessage);

  // Single-row state (used for reason === 'transfer'; admin/dispatcher scope only)
  const [fromUserId, setFromUserId] = useState<string | null>(null);
  const [toUserId, setToUserId] = useState<string | null>(null);
  const [singleProductId, setSingleProductId] = useState<string | null>(null);
  const [singleQty, setSingleQty] = useState('');

  // Bulk state (used for reason === 'warehouse_issue' | 'warehouse_return').
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [bulkAgentId, setBulkAgentId] = useState<string | null>(null);
  const {
    rows,
    addRow,
    removeRow,
    updateRow: updateBulkRow,
    resetRows,
  } = useBulkRows<BulkRow>(makeNewBulkRow);

  const isBulk = reason === 'warehouse_issue' || reason === 'warehouse_return';

  // Reset when reason changes; prompt confirm if user has filled anything.
  function changeReason(next: PairedReason | null) {
    const hadSingleData = !!(fromUserId || toUserId || singleProductId || singleQty);
    const hadBulkData =
      rows.some((r) => r.productId || r.quantity) ||
      rows.length > 1 ||
      (scope !== 'warehouse' && !!warehouseId) ||
      !!bulkAgentId;
    const anyDirty = hadSingleData || hadBulkData;
    const apply = () => {
      setReason(next);
      setError(null);
      setFromUserId(null);
      setToUserId(null);
      setSingleProductId(null);
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

  // Holders only: agents + warehouse PLACES. Warehouse STAFF are never holders.
  const activeUsers = useMemo(
    () =>
      (usersQ.data ?? []).filter((u) => u.is_active && (u.role === 'agent' || isWarehousePlace(u))),
    [usersQ.data],
  );
  const warehouseUsers = useMemo(
    () => activeUsers.filter((u) => u.role === 'warehouse'),
    [activeUsers],
  );
  const agentUsers = useMemo(() => activeUsers.filter((u) => u.role === 'agent'), [activeUsers]);

  // Warehouse scope: resolve the PLACE this caller acts on, failing loud rather
  // than defaulting to the caller's own id (which the server rejects).
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
  // The warehouse side of the paired transfer: derived place (warehouse scope)
  // or the picked warehouse (admin scope).
  const effectiveWarehouseId =
    scope === 'warehouse' ? (warehouseHolder?.ok ? warehouseHolder.holderId : null) : warehouseId;
  const placeName = warehouseHolder?.ok ? warehouseHolder.placeName : currentUser.displayName;
  useEffect(() => {
    if (scope === 'warehouse') return;
    const only = warehouseUsers[0];
    if (isBulk && warehouseUsers.length === 1 && only && !warehouseId) {
      setWarehouseId(only.id);
    }
  }, [scope, isBulk, warehouseUsers, warehouseId]);

  // The SOURCE holder whose stock seeds the product picker:
  //  - transfer (agent→agent): the From agent
  //  - warehouse_issue (warehouse→agent): the warehouse
  //  - warehouse_return (agent→warehouse): the From agent
  const sourceHolderId = useMemo(() => {
    if (reason === 'transfer') return fromUserId;
    if (reason === 'warehouse_issue') return effectiveWarehouseId;
    if (reason === 'warehouse_return') return bulkAgentId;
    return null;
  }, [reason, fromUserId, effectiveWarehouseId, bulkAgentId]);

  const sourceStockQ = useAsync<StockMatrixRow[]>(
    () => (sourceHolderId ? listHolderStock(sourceHolderId) : Promise.resolve([])),
    [sourceHolderId],
  );

  // Derive everything the pickers need from the source's on-hand stock in one
  // pass: the option list (shared by the single picker and every bulk row), plus
  // lookups for on-hand validation and label-building. Only products actually
  // held (>0) become options; client name + on-hand sit in the sub so both are
  // searchable and visible.
  const { productOptions, onHandById, productNameById } = useMemo(() => {
    const options: SelectOption<string>[] = [];
    const onHand = new Map<string, number>();
    const name = new Map<string, string>();
    for (const r of sourceStockQ.data ?? []) {
      onHand.set(r.product_catalog_id, r.quantity_on_hand);
      name.set(r.product_catalog_id, r.product_name);
      if (r.quantity_on_hand > 0) {
        options.push({
          value: r.product_catalog_id,
          label: r.product_name,
          sub: `${r.client_name} · ${r.quantity_on_hand} in stock`,
        });
      }
    }
    return { productOptions: options, onHandById: onHand, productNameById: name };
  }, [sourceStockQ.data]);

  // Changing the source invalidates any picked products (they belong to the old
  // holder's stock) — clear them. Ref-guarded so it only fires on a real change.
  const prevSourceRef = useRef(sourceHolderId);
  useEffect(() => {
    if (prevSourceRef.current !== sourceHolderId) {
      prevSourceRef.current = sourceHolderId;
      setSingleProductId(null);
      resetRows();
    }
  }, [sourceHolderId, resetRows]);

  const productsLoading = !!sourceHolderId && sourceStockQ.loading;

  // --------------------------------------------------------------------------
  // Single-mode submit (admin + dispatcher scope).
  // --------------------------------------------------------------------------
  async function handleSubmitSingle() {
    setError(null);
    if (!reason) return setError('Pick a transfer reason');
    if (!fromUserId) return setError('Pick the source user');
    if (!toUserId) return setError('Pick the destination user');
    if (fromUserId === toUserId) return setError('Source and destination must differ');
    if (!singleProductId) return setError('Pick a product');
    const q = Number(singleQty);
    if (!Number.isInteger(q) || q <= 0) return setError('Quantity must be a positive whole number');
    const onHand = onHandById.get(singleProductId) ?? 0;
    if (q > onHand) return setError(`Only ${onHand} in stock at the source`);

    setSubmitting(true);
    try {
      const reasonLabel = PAIRED_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const productName = productNameById.get(singleProductId) ?? 'product';
      const jobId = await enqueueTransfer(
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
      finish([jobId]);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function handleSubmitBulk() {
    setError(null);
    if (!reason || !isBulk) return setError('Pick a transfer reason');
    if (scope === 'warehouse' && warehouseHolder && !warehouseHolder.ok) {
      return setError(warehouseHolder.reason);
    }
    if (!effectiveWarehouseId) return setError('Pick the warehouse');
    if (!bulkAgentId) return setError('Pick the agent');

    const validRows: { productId: string; qty: number }[] = [];
    // Track the running total per product so the same product across multiple
    // rows is checked against on-hand cumulatively, not row-by-row.
    const neededByProduct = new Map<string, number>();
    for (const r of rows) {
      const completelyEmpty = !r.productId && !r.quantity;
      if (completelyEmpty) continue;
      if (!r.productId) return setError('Each row needs a product');
      const q = Number(r.quantity);
      if (!Number.isInteger(q) || q <= 0) {
        return setError('Each row needs a positive whole-number quantity');
      }
      const running = (neededByProduct.get(r.productId) ?? 0) + q;
      neededByProduct.set(r.productId, running);
      const onHand = onHandById.get(r.productId) ?? 0;
      if (running > onHand) {
        const name = productNameById.get(r.productId) ?? 'A product';
        return setError(
          running > q
            ? `${name}: rows need ${running} but only ${onHand} in stock`
            : `${name}: only ${onHand} in stock`,
        );
      }
      validRows.push({ productId: r.productId, qty: q });
    }
    if (validRows.length === 0) return setError('Add at least one product');

    setSubmitting(true);
    try {
      const reasonLabel = PAIRED_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const agent = agentUsers.find((u) => u.id === bulkAgentId);
      const fromId = reason === 'warehouse_issue' ? effectiveWarehouseId : bulkAgentId;
      const toId = reason === 'warehouse_issue' ? bulkAgentId : effectiveWarehouseId;
      const ids: string[] = [];
      for (const row of validRows) {
        const label = `${reasonLabel} · ${row.qty} ${productNameById.get(row.productId) ?? 'product'} · ${agent?.display_name ?? 'agent'}`;
        ids.push(
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
          ),
        );
      }
      finish(ids);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (usersQ.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  // Warehouse scope can't resolve the place this caller acts on — block the
  // form with a clear reason instead of silently sending a rejected transfer.
  const holderError = warehouseHolder && !warehouseHolder.ok ? warehouseHolder.reason : null;

  // Reason picker: full set for admin; warehouse_issue + warehouse_return only
  // for warehouse (transfer = agent→agent is admin-only on the server).
  const reasonOptions = PAIRED_REASONS.filter(
    (r) => scope !== 'warehouse' || r.value !== 'transfer',
  ).map((r) => ({ value: r.value, label: r.label, sub: r.sub }));
  const warehouseOptions = warehouseUsers.map((u) => ({ value: u.id, label: u.display_name }));
  const agentOptions = agentUsers.map((u) => ({ value: u.id, label: u.display_name }));
  const isWarehouseScope = scope === 'warehouse';

  // Placeholder for a product picker, given whether its source is set.
  const productPlaceholder = (sourceSet: boolean): string =>
    !sourceSet
      ? 'Pick the source first'
      : productsLoading
        ? 'Loading stock…'
        : sourceStockQ.error
          ? 'Could not load stock'
          : productOptions.length === 0
            ? 'No stock at source'
            : 'Search product or client';

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
          productOptions={productOptions}
          singleProductId={singleProductId}
          setSingleProductId={setSingleProductId}
          singleQty={singleQty}
          setSingleQty={setSingleQty}
          productPlaceholder={productPlaceholder}
        />
      ) : isBulk ? (
        <>
          {isWarehouseScope ? (
            <View style={styles.lockedDestBox}>
              <Text style={styles.lockedDestLabel}>
                {reason === 'warehouse_issue' ? 'From warehouse' : 'To warehouse'}
              </Text>
              {holderError ? (
                <Text style={styles.errorText}>{holderError}</Text>
              ) : (
                <Text style={styles.lockedDestValue}>{placeName}</Text>
              )}
            </View>
          ) : (
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
          )}
          <Select
            label={reason === 'warehouse_issue' ? 'To agent' : 'From agent'}
            required
            value={bulkAgentId}
            options={agentOptions}
            onChange={setBulkAgentId}
            placeholder="Pick agent"
          />

          {rows.map((row, i) => (
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
                label="Product"
                required
                searchable
                searchPlaceholder="Search product or client"
                value={row.productId}
                options={productOptions}
                onChange={(v) => updateBulkRow(row.id, { productId: v })}
                disabled={!sourceHolderId || productsLoading || productOptions.length === 0}
                placeholder={productPlaceholder(!!sourceHolderId)}
              />
              <Field
                label="Quantity"
                required
                value={row.quantity}
                onChangeText={(v) => updateBulkRow(row.id, { quantity: v })}
                keyboardType="numeric"
                autoCapitalize="none"
              />
            </View>
          ))}

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

      {error || usersQ.error || sourceStockQ.error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error ?? usersQ.error ?? sourceStockQ.error}</Text>
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
          disabled={!!holderError}
        />
      ) : null}
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

function SingleForm(props: {
  activeUsers: AppUser[];
  fromUserId: string | null;
  setFromUserId: (v: string | null) => void;
  toUserId: string | null;
  setToUserId: (v: string | null) => void;
  productOptions: SelectOption<string>[];
  singleProductId: string | null;
  setSingleProductId: (v: string | null) => void;
  singleQty: string;
  setSingleQty: (v: string) => void;
  productPlaceholder: (sourceSet: boolean) => string;
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
        label="Product"
        required
        searchable
        searchPlaceholder="Search product or client"
        value={props.singleProductId}
        options={props.productOptions}
        onChange={props.setSingleProductId}
        disabled={!props.fromUserId || props.productOptions.length === 0}
        placeholder={props.productPlaceholder(!!props.fromUserId)}
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
  retryNote: { fontSize: 12, color: '#666', textAlign: 'center', marginTop: 10 },
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
  lockedDestBox: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#fafafa',
    marginTop: 4,
    marginBottom: 4,
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
