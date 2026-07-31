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
import { isWarehousePlace } from '@/services/users';
import { useUsers } from '@/hooks/queries';
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
 *                every holder pickable as from/to.
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
 * Every reason is multi-row. create_stock_transfer is a per-line endpoint
 * (one product, one quantity, one call), so "several products in one move" is
 * a client-side loop over the rows — nothing about agent→agent made it
 * single-product except the form. The two sides differ only in WHO can stand
 * on each end, which `REASON_SIDES` describes.
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

/** Who may stand on each end of a paired transfer. Drives the pickers, their
 *  labels, and which side the warehouse scope locks to the caller's place. */
type SideKind = 'agent' | 'warehouse';
const REASON_SIDES: Record<PairedReason, { from: SideKind; to: SideKind }> = {
  transfer: { from: 'agent', to: 'agent' },
  warehouse_issue: { from: 'warehouse', to: 'agent' },
  warehouse_return: { from: 'agent', to: 'warehouse' },
};

export type StockTransferScreenProps = {
  scope: 'admin' | 'warehouse' | 'dispatcher';
};

export function StockTransferScreen({ scope }: StockTransferScreenProps) {
  const currentUser = useCurrentUser();
  const usersQ = useUsers();
  const isWarehouseScope = scope === 'warehouse';

  const [reason, setReason] = useState<PairedReason | null>(null);
  const [notes, setNotes] = useState('');
  const [fromHolderId, setFromHolderId] = useState<string | null>(null);
  const [toHolderId, setToHolderId] = useState<string | null>(null);
  const {
    rows,
    addRow,
    removeRow,
    updateRow: updateBulkRow,
    resetRows,
  } = useBulkRows<BulkRow>(makeNewBulkRow);

  const enqueueTransfer = useEnqueueStockTransfer();
  // Owns submit state + "stay on-screen until the queued jobs settle".
  const { submitting, setSubmitting, error, setError, finish, retrying } =
    useQueuedSubmit(transferFailureMessage);

  const sides = reason ? REASON_SIDES[reason] : null;

  // Reset when reason changes; prompt confirm if user has filled anything.
  function changeReason(next: PairedReason | null) {
    const anyDirty =
      !!fromHolderId ||
      !!toHolderId ||
      rows.length > 1 ||
      rows.some((r) => r.productId || r.quantity);
    const apply = () => {
      setReason(next);
      setError(null);
      setFromHolderId(null);
      setToHolderId(null);
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
  const lockedWarehouseId = warehouseHolder?.ok ? warehouseHolder.holderId : null;
  const placeName = warehouseHolder?.ok ? warehouseHolder.placeName : currentUser.displayName;
  // Warehouse scope pins its own side of the pair; every other side is picked.
  const lockedSide: 'from' | 'to' | null = !isWarehouseScope
    ? null
    : sides?.from === 'warehouse'
      ? 'from'
      : sides?.to === 'warehouse'
        ? 'to'
        : null;
  const effectiveFrom = lockedSide === 'from' ? lockedWarehouseId : fromHolderId;
  const effectiveTo = lockedSide === 'to' ? lockedWarehouseId : toHolderId;

  // Admin/dispatcher: with exactly one warehouse place, preselect it — the
  // picker would offer a single option anyway.
  useEffect(() => {
    if (isWarehouseScope || !sides) return;
    const only = warehouseUsers[0];
    if (warehouseUsers.length !== 1 || !only) return;
    if (sides.from === 'warehouse' && !fromHolderId) setFromHolderId(only.id);
    if (sides.to === 'warehouse' && !toHolderId) setToHolderId(only.id);
  }, [isWarehouseScope, sides, warehouseUsers, fromHolderId, toHolderId]);

  // The source holder whose stock seeds the product picker is always the FROM
  // side — agent (transfer / warehouse_return) or warehouse (warehouse_issue).
  const sourceHolderId = effectiveFrom;

  const sourceStockQ = useAsync<StockMatrixRow[]>(
    () => (sourceHolderId ? listHolderStock(sourceHolderId) : Promise.resolve([])),
    [sourceHolderId],
  );

  // Derive everything the pickers need from the source's on-hand stock in one
  // pass: the option list (shared by every row), plus lookups for on-hand
  // validation and label-building. Only products actually held (>0) become
  // options; client name + on-hand sit in the sub so both are searchable and
  // visible.
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
      resetRows();
    }
  }, [sourceHolderId, resetRows]);

  const productsLoading = !!sourceHolderId && sourceStockQ.loading;

  async function handleSubmit() {
    setError(null);
    if (!reason || !sides) return setError('Pick a transfer reason');
    if (warehouseHolder && !warehouseHolder.ok) return setError(warehouseHolder.reason);
    if (!effectiveFrom) return setError(`Pick the source ${sides.from}`);
    if (!effectiveTo) return setError(`Pick the destination ${sides.to}`);
    if (effectiveFrom === effectiveTo) return setError('Source and destination must differ');

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
      const counterparty = holderName(
        activeUsers,
        reason === 'warehouse_return' ? effectiveFrom : effectiveTo,
      );
      const ids: string[] = [];
      for (const row of validRows) {
        const label = `${reasonLabel} · ${row.qty} ${productNameById.get(row.productId) ?? 'product'} · ${counterparty}`;
        ids.push(
          await enqueueTransfer(
            {
              fromUserId: effectiveFrom,
              toUserId: effectiveTo,
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
  // for warehouse (transfer = agent→agent is admin/dispatcher-only on the server).
  const reasonOptions = PAIRED_REASONS.filter(
    (r) => !isWarehouseScope || r.value !== 'transfer',
  ).map((r) => ({ value: r.value, label: r.label, sub: r.sub }));

  // Options for one side. The destination never offers the source back, so
  // agent→agent can't pick the same agent twice.
  const sideOptions = (kind: SideKind, exclude: string | null): SelectOption<string>[] =>
    (kind === 'warehouse' ? warehouseUsers : agentUsers)
      .filter((u) => u.id !== exclude)
      .map((u) => ({ value: u.id, label: u.display_name }));

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

      {sides ? (
        <>
          <HolderSide
            label={`From ${sides.from}`}
            kind={sides.from}
            locked={lockedSide === 'from'}
            lockedName={placeName}
            lockedError={holderError}
            value={effectiveFrom}
            onChange={setFromHolderId}
            options={sideOptions(sides.from, null)}
          />
          <HolderSide
            label={`To ${sides.to}`}
            kind={sides.to}
            locked={lockedSide === 'to'}
            lockedName={placeName}
            lockedError={holderError}
            value={effectiveTo}
            onChange={setToHolderId}
            options={sideOptions(sides.to, effectiveFrom)}
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

      {reason ? (
        <Button
          title={submitLabel(
            reason,
            countFilled(rows),
            holderName(activeUsers, reason === 'warehouse_return' ? effectiveFrom : effectiveTo),
          )}
          onPress={handleSubmit}
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

function holderName(users: { id: string; display_name: string }[], id: string | null): string {
  if (!id) return '';
  return users.find((u) => u.id === id)?.display_name ?? '';
}

// Action-oriented button label so the operator sees who they're giving to /
// collecting from. Falls back to a neutral phrasing until the counterparty is
// picked (or when it's the locked warehouse side, which is already on screen).
function submitLabel(reason: PairedReason, n: number, counterparty: string): string {
  const word = n === 1 ? 'product' : 'products';
  const verb =
    reason === 'warehouse_issue' ? 'Issue' : reason === 'warehouse_return' ? 'Collect' : 'Move';
  if (!counterparty) return `${verb} ${n} ${word}`;
  const preposition = reason === 'warehouse_return' ? 'from' : 'to';
  return `${verb} ${n} ${word} ${preposition} ${counterparty}`;
}

/** One end of the pair: a picker, or a read-only box when the warehouse scope
 *  pins this side to the caller's own place. */
function HolderSide(props: {
  label: string;
  kind: SideKind;
  locked: boolean;
  lockedName: string;
  lockedError: string | null;
  value: string | null;
  onChange: (v: string | null) => void;
  options: SelectOption<string>[];
}) {
  if (props.locked) {
    return (
      <View style={styles.lockedDestBox}>
        <Text style={styles.lockedDestLabel}>{props.label}</Text>
        {props.lockedError ? (
          <Text style={styles.errorText}>{props.lockedError}</Text>
        ) : (
          <Text style={styles.lockedDestValue}>{props.lockedName}</Text>
        )}
      </View>
    );
  }
  const empty = props.options.length === 0;
  return (
    <Select
      label={props.label}
      required
      value={props.value}
      options={props.options}
      onChange={props.onChange}
      placeholder={
        !empty
          ? `Pick ${props.kind}`
          : props.kind === 'warehouse'
            ? 'No warehouse user — add one in Catalog'
            : 'No other agent available'
      }
      disabled={empty}
    />
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
