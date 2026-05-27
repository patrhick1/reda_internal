import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { listUsers } from '@/services/users';
import { listClients } from '@/services/clients';
import { listActiveProductsByClient } from '@/services/products';
import { ADJUSTMENT_REASONS, type SingleReason } from '@/services/stock';
import { useEnqueueStockAdjustment } from '@/queue/mutations';
import { errorMessage } from '@/lib/errors';

export default function NewAdjustment() {
  const usersQ = useAsync(() => listUsers(), []);
  const clientsQ = useAsync(() => listClients(), []);

  const [agentId, setAgentId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [products, setProducts] = useState<{ id: string; product_name: string }[]>([]);
  const [reason, setReason] = useState<SingleReason | null>(null);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueAdj = useEnqueueStockAdjustment();

  // Load products when client changes
  useMemo(() => {
    setProductId(null);
    setProducts([]);
    if (!clientId) return;
    listActiveProductsByClient(clientId)
      .then((p) => setProducts(p.map((x) => ({ id: x.id, product_name: x.product_name }))))
      .catch((e) => setError(errorMessage(e)));
  }, [clientId]);

  const userOptions = useMemo(
    () =>
      (usersQ.data ?? [])
        .filter((u) => u.is_active && (u.role === 'agent' || u.role === 'warehouse'))
        .map((u) => ({ value: u.id, label: u.display_name, sub: u.role })),
    [usersQ.data],
  );
  const clientOptions = useMemo(
    () => (clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clientsQ.data],
  );
  const productOptions = useMemo(
    () => products.map((p) => ({ value: p.id, label: p.product_name })),
    [products],
  );
  const reasonOptions = ADJUSTMENT_REASONS.map((r) => ({
    value: r.value,
    label: r.label,
    sub:
      r.sign === 'negative'
        ? 'Negative quantity'
        : r.sign === 'positive'
          ? 'Positive quantity'
          : 'Either sign',
  }));

  const signedHint = (() => {
    const def = ADJUSTMENT_REASONS.find((r) => r.value === reason);
    if (!def) return null;
    if (def.sign === 'negative') return 'Enter a negative number (e.g. -3).';
    if (def.sign === 'positive') return 'Enter a positive number (e.g. 5).';
    return 'Positive or negative.';
  })();

  async function handleSubmit() {
    setError(null);
    if (!agentId) {
      setError('Pick the user whose stock is being adjusted');
      return;
    }
    if (!productId) {
      setError('Pick a product');
      return;
    }
    if (!reason) {
      setError('Pick a reason');
      return;
    }
    const q = Number(quantity);
    if (!Number.isInteger(q) || q === 0) {
      setError('Quantity must be a non-zero integer');
      return;
    }
    setSubmitting(true);
    try {
      const reasonLabel = ADJUSTMENT_REASONS.find((r) => r.value === reason)?.label ?? reason;
      const productName = products.find((p) => p.id === productId)?.product_name ?? 'product';
      await enqueueAdj(
        {
          agentId,
          productCatalogId: productId,
          quantityDelta: q,
          reason,
          notes: notes.trim() || null,
        },
        `${reasonLabel} · ${q > 0 ? '+' : ''}${q} ${productName}`,
      );
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

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Select
        label="User (agent / warehouse)"
        required
        value={agentId}
        options={userOptions}
        onChange={setAgentId}
      />
      <Select
        label="Client"
        required
        value={clientId}
        options={clientOptions}
        onChange={setClientId}
      />
      <Select
        label="Product"
        required
        value={productId}
        options={productOptions}
        onChange={setProductId}
        disabled={!clientId || products.length === 0}
        placeholder={
          !clientId
            ? 'Pick a client first'
            : products.length === 0
              ? 'No products for this client'
              : 'Choose'
        }
      />
      <Select label="Reason" required value={reason} options={reasonOptions} onChange={setReason} />
      <Field
        label="Quantity"
        required
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        placeholder={signedHint ?? '0'}
      />
      {signedHint ? <Text style={styles.hint}>{signedHint}</Text> : null}
      <Field
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="Optional context"
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="Create adjustment" onPress={handleSubmit} loading={submitting} />
      <Button
        title="Cancel"
        onPress={() => router.back()}
        variant="secondary"
        style={styles.cancel}
      />
    </ScrollView>
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
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  hint: { fontSize: 12, color: '#666', marginTop: -8, marginBottom: 12, fontStyle: 'italic' },
  cancel: { marginTop: 12 },
});
