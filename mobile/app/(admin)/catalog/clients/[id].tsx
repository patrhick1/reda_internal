import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import {
  clearClientCeiling,
  deactivateClient,
  getClient,
  reactivateClient,
  updateClient,
} from '@/services/clients';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';

function ceilingToString(v: number | null | undefined): string {
  return v == null ? '' : String(v);
}

export default function EditClient() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: client, loading, error, reload } = useAsync(() => getClient(id), [id]);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [maxCharge, setMaxCharge] = useState('');
  const [autoCancelSoftFails, setAutoCancelSoftFails] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (client) {
      setName(client.name);
      setPhone(client.contact_phone ?? '');
      setEmail(client.contact_email ?? '');
      setNotes(client.notes ?? '');
      setMaxCharge(ceilingToString(client.max_charge_per_delivery));
      setAutoCancelSoftFails(client.auto_cancel_soft_fails ?? false);
    }
  }, [client]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (error || !client) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error ?? 'Client not found'}</Text>
        <Button title="Retry" onPress={reload} variant="secondary" />
      </View>
    );
  }

  const initialMaxCharge = ceilingToString(client.max_charge_per_delivery);
  const maxChargeDirty = maxCharge.trim() !== initialMaxCharge;
  const autoCancelDirty = autoCancelSoftFails !== (client.auto_cancel_soft_fails ?? false);
  const dirty =
    name !== client.name ||
    (phone || null) !== client.contact_phone ||
    (email || null) !== client.contact_email ||
    (notes || null) !== client.notes ||
    maxChargeDirty ||
    autoCancelDirty;

  async function handleSave() {
    if (!name.trim()) {
      setActionError('Name is required');
      return;
    }
    let maxChargeToSend: number | null = null; // null = leave alone (coalesce in SQL)
    if (maxChargeDirty) {
      const raw = maxCharge.trim();
      if (raw === '') {
        setActionError(
          'To remove the cap, use "Remove cap" — leaving the field blank does not clear it.',
        );
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setActionError('Max Reda charge must be a non-negative number');
        return;
      }
      maxChargeToSend = parsed;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await updateClient(
        client!.id,
        {
          name: name.trim(),
          contactPhone: phone.trim() || null,
          contactEmail: email.trim() || null,
          notes: notes.trim() || null,
          maxChargePerDelivery: maxChargeToSend,
          autoCancelSoftFails: autoCancelDirty ? autoCancelSoftFails : null,
        },
        reason.trim() || null,
      );
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function performClearCeiling(why: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      await clearClientCeiling(client!.id, why);
      setMaxCharge('');
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  function handleRemoveCap() {
    if (Platform.OS === 'web') {
      const why =
        (typeof window !== 'undefined' ? window.prompt('Reason for removing the cap:') : null) ??
        '';
      if (why.trim()) performClearCeiling(why.trim());
      return;
    }
    Alert.prompt(
      'Remove charge cap',
      `Reda will charge this client the full rate-card amount from now on.\n\nReason (required).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove cap',
          style: 'destructive',
          onPress: (why?: string) => {
            if (why && why.trim()) performClearCeiling(why.trim());
            else setActionError('Reason required');
          },
        },
      ],
      'plain-text',
    );
  }

  async function performDeactivate(why: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      await deactivateClient(client!.id, why);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  function handleDeactivate() {
    if (Platform.OS === 'web') {
      const why =
        (typeof window !== 'undefined' ? window.prompt('Reason for deactivation:') : null) ?? '';
      if (why.trim()) performDeactivate(why.trim());
      return;
    }
    Alert.prompt(
      'Deactivate client',
      'Reason (required). Their products will be deactivated too.',
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
      await reactivateClient(client!.id);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      {!client.is_active ? (
        <View style={styles.inactiveBanner}>
          <Text style={styles.inactiveText}>This client is inactive.</Text>
        </View>
      ) : null}

      <Field label="Name" value={name} onChangeText={setName} required autoCapitalize="words" />
      <Field
        label="Contact phone"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoCapitalize="none"
      />
      <Field
        label="Contact email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline />

      <Field
        label="Max Reda charge per delivery (₦)"
        value={maxCharge}
        onChangeText={setMaxCharge}
        keyboardType="numeric"
        autoCapitalize="none"
        placeholder="e.g. 9000"
      />
      <Text style={styles.hint}>
        {client.max_charge_per_delivery != null
          ? `Currently capped at ${formatNaira(client.max_charge_per_delivery)} per delivery. Rate-card charges above this are clamped to the cap.`
          : 'No cap — Reda charges the full rate-card amount for the delivery location.'}
      </Text>

      {client.is_active && client.max_charge_per_delivery != null ? (
        <Pressable onPress={handleRemoveCap} disabled={submitting} style={styles.clearLink}>
          <Text style={styles.clearLinkText}>Remove cap (charge full rate-card amount)</Text>
        </Pressable>
      ) : null}

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <Text style={styles.toggleLabel}>Cancel soft-failed orders at EOD</Text>
          <Text style={styles.toggleHelper}>
            When the customer doesn&apos;t engage and the day ends, mark the delivery as failed
            instead of rolling it to tomorrow. Applies only to customer-unreachable statuses
            (didn&apos;t answer, line busy, phone off, couldn&apos;t find them). Customer deferrals
            (tomorrow / postponed) and in-transit orders (picked up / waybilled) still roll.
          </Text>
        </View>
        <Switch
          value={autoCancelSoftFails}
          onValueChange={setAutoCancelSoftFails}
          disabled={submitting}
        />
      </View>

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

      {client.is_active ? (
        <Button
          title="View stock"
          onPress={() => router.push(`/(admin)/stock/client/${client.id}`)}
          variant="secondary"
          style={styles.viewStock}
          disabled={submitting}
        />
      ) : null}

      {client.is_active ? (
        <Button
          title="Deactivate"
          onPress={handleDeactivate}
          variant="danger"
          style={styles.bottom}
          disabled={submitting}
        />
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
  bottom: { marginTop: 24 },
  hint: { color: '#6b7280', fontSize: 12, marginTop: -8, marginBottom: 8, lineHeight: 16 },
  clearLink: { alignSelf: 'flex-start', paddingVertical: 2, marginBottom: 16 },
  clearLinkText: {
    color: '#a02d1b',
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  viewStock: { marginTop: 12 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
    marginBottom: 4,
  },
  toggleText: { flex: 1 },
  toggleLabel: { fontWeight: '600', fontSize: 14, color: '#111827', marginBottom: 4 },
  toggleHelper: { color: '#6b7280', fontSize: 12, lineHeight: 16 },
});
