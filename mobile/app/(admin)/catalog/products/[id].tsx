import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { deactivateProduct, getProduct, reactivateProduct, updateProduct } from '@/services/products';
import { errorMessage } from '@/lib/errors';

export default function EditProduct() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product, loading, error, reload } = useAsync(() => getProduct(id), [id]);

  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (product) {
      setProductName(product.product_name);
      setDescription(product.description ?? '');
    }
  }, [product]);

  if (loading) return <View style={styles.center}><ActivityIndicator /></View>;
  if (error || !product) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error ?? 'Product not found'}</Text>
        <Button title="Retry" onPress={reload} variant="secondary" />
      </View>
    );
  }

  const dirty =
    productName !== product.product_name ||
    (description || null) !== product.description;

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

  async function performDeactivate(why: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      await deactivateProduct(product!.id, why);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  function handleDeactivate() {
    if (Platform.OS === 'web') {
      const why = (typeof window !== 'undefined' ? window.prompt('Reason for deactivation:') : null) ?? '';
      if (why.trim()) performDeactivate(why.trim());
      else setActionError('Reason required');
      return;
    }
    Alert.prompt(
      'Deactivate product',
      'Reason (required).',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: (why?: string) => {
            if (why && why.trim()) performDeactivate(why.trim());
            else setActionError('Reason required');
          },
        },
      ],
      'plain-text',
    );
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

      <Field label="Product name" value={productName} onChangeText={setProductName} required autoCapitalize="words" />
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
        <View style={styles.errorBox}><Text style={styles.errorText}>{actionError}</Text></View>
      ) : null}

      <Button title="Save changes" onPress={handleSave} loading={submitting} disabled={!dirty} />

      {product.is_active ? (
        <Button title="Deactivate" onPress={handleDeactivate} variant="danger" style={styles.bottom} disabled={submitting} />
      ) : (
        <Button title="Reactivate" onPress={handleReactivate} variant="secondary" style={styles.bottom} disabled={submitting} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  inactiveBanner: { backgroundColor: '#fff4e0', padding: 12, borderRadius: 8, marginBottom: 16 },
  inactiveText: { color: '#a04000', fontWeight: '600' },
  clientRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 14,
    borderWidth: 1, borderColor: '#eee', borderRadius: 8,
    backgroundColor: '#f6f6f6',
    marginBottom: 16,
  },
  clientLabel: { fontSize: 13, color: '#666', fontWeight: '600' },
  clientValue: { fontSize: 14, color: '#111', fontWeight: '500' },
  bottom: { marginTop: 24 },
});
