import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { listClients } from '@/services/clients';
import { createProduct } from '@/services/products';
import { errorMessage } from '@/lib/errors';

export default function NewProduct() {
  const { data: clients, loading: loadingClients, error: clientsError } = useAsync(
    () => listClients(),
    [],
  );

  const [clientId, setClientId] = useState<string | null>(null);
  const [productName, setProductName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!clientId) {
      setError('Pick a client');
      return;
    }
    if (!productName.trim()) {
      setError('Product name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createProduct(clientId, {
        productName: productName.trim(),
        description: description.trim() || null,
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (loadingClients) {
    return <View style={styles.center}><ActivityIndicator /></View>;
  }
  if (clientsError) {
    return <View style={styles.center}><Text style={styles.error}>{clientsError}</Text></View>;
  }
  if ((clients ?? []).length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>You need an active client first.</Text>
        <Button title="Cancel" onPress={() => router.back()} variant="secondary" />
      </View>
    );
  }

  return (
    <Screen>
      <Select
        label="Client"
        required
        value={clientId}
        options={(clients ?? []).map((c) => ({ value: c.id, label: c.name }))}
        onChange={setClientId}
      />
      <Field
        label="Product name"
        value={productName}
        onChangeText={setProductName}
        required
        autoCapitalize="words"
      />
      <Field
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="Optional"
        multiline
      />

      {error ? (
        <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <Button title="Create product" onPress={handleSubmit} loading={submitting} />
      <Button title="Cancel" onPress={() => router.back()} variant="secondary" style={styles.cancel} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  error: { color: '#c0392b', textAlign: 'center' },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  empty: { fontSize: 16, color: '#333', marginBottom: 12, textAlign: 'center' },
  cancel: { marginTop: 12 },
});
