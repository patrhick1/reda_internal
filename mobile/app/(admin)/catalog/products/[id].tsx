import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { ReasonPanel } from '@/components/ReasonPanel';
import { useAsync } from '@/hooks/useAsync';
import {
  deactivateProduct,
  getProductDeactivationBlockers,
  getProduct,
  reactivateProduct,
  updateProduct,
  type ProductBlockers,
} from '@/services/products';
import { errorMessage, rpcHint } from '@/lib/errors';
import { STATUS_META } from '@/lib/theme';

export default function EditProduct() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product, loading, error, reload } = useAsync(() => getProduct(id), [id]);

  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [blockers, setBlockers] = useState<ProductBlockers | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // Preflight, so the panel can show what's in the way before the admin types a
  // reason. Only runs once they've opened the panel — the catalog screen itself
  // shouldn't pay for it.
  const blockersQ = useAsync(
    () => (deactivating ? getProductDeactivationBlockers(id) : Promise.resolve(null)),
    [deactivating, id],
  );
  const shown = blockers ?? blockersQ.data;
  const hasBlockers = !!shown && (shown.agent_units > 0 || shown.open_deliveries > 0);

  useEffect(() => {
    if (product) {
      setProductName(product.product_name);
      setDescription(product.description ?? '');
    }
  }, [product]);

  if (loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  if (error || !product) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error ?? 'Product not found'}</Text>
        <Button title="Retry" onPress={reload} variant="secondary" />
      </View>
    );
  }

  const dirty =
    productName !== product.product_name || (description || null) !== product.description;

  async function handleSave() {
    if (!productName.trim()) {
      setActionError('Product name is required');
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await updateProduct(
        product!.id,
        { productName: productName.trim(), description: description.trim() || null },
        reason.trim() || null,
      );
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function performDeactivate(why: string, force: boolean) {
    setSubmitting(true);
    setActionError(null);
    try {
      await deactivateProduct(product!.id, why, force);
      router.back();
    } catch (e) {
      // If someone issued stock or a bot created an order between the panel
      // rendering and this confirm, the server refuses with the same payload
      // the preflight uses — so refresh the list in place rather than dropping
      // a sentence on the user.
      const hint = rpcHint(e);
      if (hint?.code === 'product_deactivation_blocked') {
        setBlockers(hint as unknown as ProductBlockers);
        setAcknowledged(false);
        setActionError('That changed while you were reading — see below.');
      } else {
        setActionError(errorMessage(e));
      }
      setSubmitting(false);
    }
  }

  async function handleReactivate() {
    setSubmitting(true);
    setActionError(null);
    try {
      await reactivateProduct(product!.id);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      {!product.is_active ? (
        <View style={styles.inactiveBanner}>
          <Text style={styles.inactiveText}>This product is inactive.</Text>
        </View>
      ) : null}

      <View style={styles.clientRow}>
        <Text style={styles.clientLabel}>Client</Text>
        <Text style={styles.clientValue}>{product.client_name}</Text>
      </View>

      <Field
        label="Product name"
        value={productName}
        onChangeText={setProductName}
        required
        autoCapitalize="words"
      />
      <Field label="Description" value={description} onChangeText={setDescription} multiline />

      {dirty ? (
        <Field
          label="Reason for change"
          value={reason}
          onChangeText={setReason}
          placeholder="Optional but recommended for audit log"
        />
      ) : null}

      {actionError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{actionError}</Text>
        </View>
      ) : null}

      <Button title="Save changes" onPress={handleSave} loading={submitting} disabled={!dirty} />

      {product.is_active ? (
        !deactivating ? (
          <Button
            title="Deactivate"
            onPress={() => setDeactivating(true)}
            variant="danger"
            style={styles.bottom}
            disabled={submitting}
          />
        ) : blockersQ.loading && !blockers ? (
          <View style={styles.panelCenter}>
            <ActivityIndicator />
          </View>
        ) : (
          <ReasonPanel
            title={`Deactivate ${product.product_name}?`}
            blurb={
              hasBlockers
                ? undefined
                : 'It stops appearing when new orders are created. Units already in the warehouse stay where they are.'
            }
            confirmLabel={hasBlockers ? 'Deactivate anyway' : 'Deactivate'}
            submitting={submitting}
            confirmDisabled={hasBlockers && !acknowledged}
            onCancel={() => {
              setDeactivating(false);
              setBlockers(null);
              setAcknowledged(false);
            }}
            onConfirm={(why) => performDeactivate(why, hasBlockers)}
          >
            {shown ? (
              <BlockerSummary
                blockers={shown}
                acknowledged={acknowledged}
                onAcknowledge={() => setAcknowledged((v) => !v)}
              />
            ) : null}
          </ReasonPanel>
        )
      ) : (
        <Button
          title="Reactivate"
          onPress={handleReactivate}
          variant="secondary"
          style={styles.bottom}
          disabled={submitting}
        />
      )}
    </Screen>
  );
}

/**
 * What's standing in the way, and what to do about it.
 *
 * The two blocking cases get an instruction, not just a count — the useful
 * thing to tell an admin holding a retired product is "collect it from Chidi
 * first", because once the product is inactive that stock is awkward to move.
 * Warehouse-held units are shown too but styled as a plain note: a vendor who
 * hasn't collected their goods is not a reason to keep a product sellable, and
 * making it look like a warning would train people to force past real ones.
 */
function BlockerSummary({
  blockers,
  acknowledged,
  onAcknowledge,
}: {
  blockers: ProductBlockers;
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  const blocking = blockers.agent_units > 0 || blockers.open_deliveries > 0;
  const statuses = blockers.open_statuses
    .map((s) => STATUS_META[s]?.label ?? s)
    .filter(Boolean)
    .join(', ');

  return (
    <View>
      {blockers.agent_units > 0 ? (
        <View style={styles.blockBox}>
          <Text style={styles.blockTitle}>Collect this stock from the agent first</Text>
          {blockers.agent_stock.map((a) => (
            <View key={a.holder_id} style={styles.stockLine}>
              <Text style={styles.stockName}>{a.holder_name}</Text>
              <Text style={styles.stockQty}>{a.quantity}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {blockers.open_deliveries > 0 ? (
        <View style={styles.blockBox}>
          <Text style={styles.blockTitle}>
            {blockers.open_deliveries === 1
              ? '1 open order still needs this product'
              : `${blockers.open_deliveries} open orders still need this product`}
          </Text>
          {statuses ? <Text style={styles.blockSub}>{statuses}</Text> : null}
        </View>
      ) : null}

      {blockers.warehouse_units > 0 ? (
        <View style={styles.noteBox}>
          <Text style={styles.noteText}>
            {blockers.warehouse_units} unit{blockers.warehouse_units === 1 ? '' : 's'} at the
            warehouse. That&apos;s fine — deactivating doesn&apos;t move them.
          </Text>
        </View>
      ) : null}

      {blocking ? (
        <Pressable
          onPress={onAcknowledge}
          style={[styles.ackRow, acknowledged && styles.ackRowOn]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
        >
          <View style={[styles.ackDot, acknowledged && styles.ackDotOn]} />
          <Text style={styles.ackLabel}>I&apos;ve read the above — deactivate anyway</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  inactiveBanner: { backgroundColor: '#fff4e0', padding: 12, borderRadius: 8, marginBottom: 16 },
  inactiveText: { color: '#a04000', fontWeight: '600' },
  clientRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#f6f6f6',
    marginBottom: 16,
  },
  clientLabel: { fontSize: 13, color: '#666', fontWeight: '600' },
  clientValue: { fontSize: 14, color: '#111', fontWeight: '500' },
  bottom: { marginTop: 24 },
  panelCenter: { paddingVertical: 32, alignItems: 'center' },
  blockBox: {
    borderWidth: 1,
    borderColor: '#f0c9c2',
    borderRadius: 8,
    backgroundColor: '#fff',
    padding: 10,
    marginBottom: 10,
  },
  blockTitle: { fontSize: 13, fontWeight: '700', color: '#a02d1b', marginBottom: 6 },
  blockSub: { fontSize: 12, color: '#666' },
  stockLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  stockName: { fontSize: 14, color: '#111' },
  stockQty: { fontSize: 14, color: '#111', fontWeight: '700' },
  noteBox: {
    borderRadius: 8,
    backgroundColor: '#f4f4f4',
    padding: 10,
    marginBottom: 10,
  },
  noteText: { fontSize: 12, color: '#555', lineHeight: 18 },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 4,
  },
  ackRowOn: { borderColor: '#a02d1b', backgroundColor: '#fdecea' },
  ackDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#bbb',
  },
  ackDotOn: { borderColor: '#a02d1b', backgroundColor: '#a02d1b' },
  ackLabel: { fontSize: 13, color: '#222', flexShrink: 1 },
});
