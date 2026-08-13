import { useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { Icon } from '@/components/ui';
import { useBulkRows } from '@/hooks/useBulkRows';
import { useClients, useProducts } from '@/hooks/queries';
import { createProducts } from '@/services/products';
import { errorMessage } from '@/lib/errors';

/**
 * Add products to a vendor's catalog — multi-row.
 *
 * Onboarding a vendor means entering their whole range, and the audit shows it
 * happens in batches (10–13 in a sitting) that used to be one full
 * client → name → description → save cycle each.
 *
 * One client for the batch, N products. `create_product` is per-row and
 * admin-only; rows are independent, so a bad name in the middle never costs
 * the ones around it.
 *
 * Duplicate names are the failure mode worth designing for, because
 * UNIQUE (client_id, product_name) does NOT exclude retired products: a name
 * that was deactivated last month still blocks re-adding it, and the fix is to
 * reactivate rather than create. So collisions are caught before submitting —
 * against the client's existing catalog INCLUDING inactive rows, and against
 * the other rows on screen. The check is case-insensitive on purpose: the
 * constraint is not, so "Mint Spray" and "mint spray" would both be accepted
 * and leave the catalog with two entries for one product.
 */
type ProductRow = {
  id: string;
  name: string;
  description: string;
};

const makeRow = (): ProductRow => ({
  id: Math.random().toString(36).slice(2),
  name: '',
  description: '',
});

const norm = (s: string) => s.trim().toLowerCase();

export default function NewProducts() {
  const { data: clients, loading: loadingClients, error: clientsError } = useClients();
  // Inactive included: a retired product still owns its name as far as the
  // unique constraint is concerned, so it has to take part in the dup check.
  const productsQ = useProducts({ includeInactive: true });

  const [clientId, setClientId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { rows, addRow, removeRow, updateRow } = useBulkRows<ProductRow>(makeRow);

  // Existing names for the chosen client, normalised, with their live/retired
  // state — a retired collision gets a different message because it has a
  // different fix.
  const existingByName = useMemo(() => {
    const map = new Map<string, { name: string; isActive: boolean }>();
    if (!clientId) return map;
    for (const p of productsQ.data ?? []) {
      if (p.client_id !== clientId) continue;
      map.set(norm(p.product_name), { name: p.product_name, isActive: p.is_active });
    }
    return map;
  }, [productsQ.data, clientId]);

  // Per-row problems, keyed by row id. Rendered inline AND used to block submit,
  // so nothing is sent that the constraint would bounce.
  const rowErrors = useMemo(() => {
    const errs = new Map<string, string>();
    const seen = new Map<string, string>();
    for (const r of rows) {
      const n = norm(r.name);
      if (!n) continue;
      const existing = existingByName.get(n);
      if (existing) {
        errs.set(
          r.id,
          existing.isActive
            ? `${existing.name} is already in this catalog.`
            : `${existing.name} exists but is retired — reactivate it instead of re-adding.`,
        );
        continue;
      }
      const dupRow = seen.get(n);
      if (dupRow) {
        errs.set(r.id, 'Same name as another row above.');
        continue;
      }
      seen.set(n, r.id);
    }
    return errs;
  }, [rows, existingByName]);

  const filledRows = rows.filter((r) => r.name.trim().length > 0);
  const blocked = rowErrors.size > 0;

  async function handleSubmit() {
    setError(null);
    if (!clientId) {
      setError('Pick a client');
      return;
    }
    if (filledRows.length === 0) {
      setError('Add at least one product name');
      return;
    }
    if (blocked) {
      setError('Fix the highlighted rows first');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createProducts(
        clientId,
        filledRows.map((r) => ({
          productName: r.name.trim(),
          description: r.description.trim() || null,
        })),
      );
      // Rows are independent, so report what actually landed. A skip is a name
      // that already existed — worth saying, not worth treating as a failure.
      const parts = [`Added ${res.created}`];
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} already existed`);
      if (res.failed > 0) parts.push(`${res.failed} failed`);
      const msg = `${parts.join(', ')}.${res.firstError ? `\n${res.firstError}` : ''}`;
      if (res.failed > 0) {
        // Something genuinely went wrong — keep the form up so the typing isn't
        // lost and the admin can see which names are still outstanding.
        setError(msg);
        setSubmitting(false);
        return;
      }
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert('Done', msg);
      }
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (loadingClients) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (clientsError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{clientsError}</Text>
      </View>
    );
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
        searchable
        searchPlaceholder="Search vendor…"
        placeholder="Pick the vendor these belong to"
      />
      {clientId ? (
        <Text style={styles.hint}>
          {existingByName.size === 0
            ? 'No products for this vendor yet.'
            : `${existingByName.size} already in this vendor's catalog.`}
        </Text>
      ) : null}

      {rows.map((row, i) => {
        const rowError = rowErrors.get(row.id);
        return (
          <View key={row.id} style={[styles.rowCard, rowError ? styles.rowCardBad : null]}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowTitle}>Product {i + 1}</Text>
              {rows.length > 1 ? (
                <Pressable onPress={() => removeRow(row.id)} hitSlop={6}>
                  <Icon name="x" size={18} color="#a02d1b" />
                </Pressable>
              ) : null}
            </View>
            <Field
              label="Product name"
              required
              value={row.name}
              onChangeText={(v) => updateRow(row.id, { name: v })}
              autoCapitalize="words"
            />
            {rowError ? <Text style={styles.rowError}>{rowError}</Text> : null}
            <Field
              label="Description"
              value={row.description}
              onChangeText={(v) => updateRow(row.id, { description: v })}
              placeholder="Optional"
              multiline
            />
          </View>
        );
      })}

      <Button
        title="+ Add another product"
        onPress={addRow}
        variant="secondary"
        style={styles.addRow}
        disabled={!clientId}
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button
        title={`Create ${filledRows.length} ${filledRows.length === 1 ? 'product' : 'products'}`}
        onPress={handleSubmit}
        loading={submitting}
        disabled={!clientId || filledRows.length === 0 || blocked}
      />
      <Button
        title="Cancel"
        onPress={() => router.back()}
        variant="secondary"
        style={styles.cancel}
      />
    </Screen>
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
  error: { color: '#c0392b', textAlign: 'center' },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  empty: { fontSize: 16, color: '#333', marginBottom: 12, textAlign: 'center' },
  cancel: { marginTop: 12 },
  hint: { fontSize: 12, color: '#666', marginTop: -8, marginBottom: 4, fontStyle: 'italic' },
  rowCard: {
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#fafafa',
  },
  rowCardBad: { borderColor: '#e8b4ac', backgroundColor: '#fdf3f1' },
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
  rowError: { color: '#a02d1b', fontSize: 12, marginTop: -8, marginBottom: 8 },
  addRow: { marginTop: 12 },
});
