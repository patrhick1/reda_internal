import { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { ReasonPanel } from '@/components/ReasonPanel';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import {
  clearClientCeiling,
  deactivateClient,
  getClient,
  reactivateClient,
  setClientBankDetails,
  updateClient,
} from '@/services/clients';
import { MONIEPOINT_BANKS } from '@/lib/moniepoint-banks';
import { errorMessage, rpcHint } from '@/lib/errors';
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
  // Bank details for the Moniepoint bulk-payout CSV. Persisted via the dedicated
  // set_client_bank_details RPC (separate from updateClient).
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Which destructive action is currently asking for its reason, if any. */
  const [prompting, setPrompting] = useState<'cap' | 'bank' | 'deactivate' | null>(null);
  /** Products the server refused over, from the last blocked attempt. */
  const [blockedProducts, setBlockedProducts] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const bankOptions = useMemo(
    () =>
      MONIEPOINT_BANKS.map((b) => ({ value: b.name, label: b.name, sub: b.aliases.join(' · ') })),
    [],
  );

  useEffect(() => {
    if (client) {
      setName(client.name);
      setPhone(client.contact_phone ?? '');
      setEmail(client.contact_email ?? '');
      setNotes(client.notes ?? '');
      setMaxCharge(ceilingToString(client.max_charge_per_delivery));
      setAutoCancelSoftFails(client.auto_cancel_soft_fails ?? false);
      setBankAccountName(client.bank_account_name ?? '');
      setBankAccountNumber(client.bank_account_number ?? '');
      setBankName(client.bank_name ?? '');
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
  const generalDirty =
    name !== client.name ||
    (phone || null) !== client.contact_phone ||
    (email || null) !== client.contact_email ||
    (notes || null) !== client.notes ||
    maxChargeDirty ||
    autoCancelDirty;
  const bankDirty =
    (bankAccountName.trim() || null) !== (client.bank_account_name ?? null) ||
    (bankAccountNumber.trim() || null) !== (client.bank_account_number ?? null) ||
    (bankName.trim() || null) !== (client.bank_name ?? null);
  const dirty = generalDirty || bankDirty;

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
    // Bank NUBAN is 10 digits; fintech wallets (OPay, PalmPay, Moniepoint) use an
    // 11-digit phone-based account. Allow both (server validates too).
    const acctNo = bankAccountNumber.trim();
    if (bankDirty && acctNo !== '' && !/^\d{10,11}$/.test(acctNo)) {
      setActionError('Bank account number must be 10 or 11 digits');
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      if (generalDirty) {
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
      }
      if (bankDirty) {
        await setClientBankDetails(
          client!.id,
          {
            bankAccountName: bankAccountName.trim() || null,
            bankAccountNumber: acctNo || null,
            bankName: bankName.trim() || null,
          },
          reason.trim() || null,
        );
      }
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

  async function performClearBank(why: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      // Nulls all three fields (the RPC treats blanks as null). The vendor drops
      // off the Moniepoint / Kuda payout files — used when a client collects
      // remittance through their own system.
      await setClientBankDetails(
        client!.id,
        { bankAccountName: null, bankAccountNumber: null, bankName: null },
        why,
      );
      setBankAccountName('');
      setBankAccountNumber('');
      setBankName('');
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function performDeactivate(why: string, force: boolean) {
    setSubmitting(true);
    setActionError(null);
    try {
      await deactivateClient(client!.id, why, force);
      router.back();
    } catch (e) {
      // No preflight here — scanning every product of every client on screen
      // load would be real cost for a rare action, and the refusal already
      // names each offender. Show them, then let the admin acknowledge.
      const hint = rpcHint(e);
      if (hint?.code === 'client_deactivation_blocked') {
        setBlockedProducts(
          (hint.products as { product_name: string }[] | undefined)?.map((p) => p.product_name) ??
            [],
        );
        setAcknowledged(false);
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
        <Pressable
          onPress={() => setPrompting('cap')}
          disabled={submitting}
          style={styles.clearLink}
        >
          <Text style={styles.clearLinkText}>Remove cap (charge full rate-card amount)</Text>
        </Pressable>
      ) : null}
      {prompting === 'cap' ? (
        <ReasonPanel
          title="Remove charge cap"
          blurb="Reda will charge this client the full rate-card amount from now on."
          confirmLabel="Remove cap"
          submitting={submitting}
          onCancel={() => setPrompting(null)}
          onConfirm={(why) => {
            setPrompting(null);
            void performClearCeiling(why);
          }}
        />
      ) : null}

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <Text style={styles.toggleLabel}>Cancel soft-failed orders at EOD</Text>
          <Text style={styles.toggleHelper}>
            When an order isn&apos;t completed and the day ends, mark it as failed instead of
            carrying it forward. Applies to customer-unreachable statuses (didn&apos;t answer, line
            busy, phone off, couldn&apos;t find them) and customer deferrals (postponed / tomorrow)
            — postponed orders are cancelled at EOD rather than re-entering the pool. Failed
            closures under this policy are not added to “To notify,” because Reda does not relay
            them back to the client. In-transit orders (picked up / waybilled) are unaffected.
          </Text>
        </View>
        <Switch
          value={autoCancelSoftFails}
          onValueChange={setAutoCancelSoftFails}
          disabled={submitting}
        />
      </View>

      <Text style={styles.sectionLabel}>Bank details (for Moniepoint / Kuda payout)</Text>
      <Text style={styles.hint}>
        Used to build the end-of-day bulk-transfer files. All three are needed for this vendor to
        appear in the payout file. Leave blank for clients who collect remittance through their own
        system — they’re left off the files.
      </Text>
      <Field
        label="Account name"
        value={bankAccountName}
        onChangeText={setBankAccountName}
        autoCapitalize="words"
        placeholder="As it appears on the bank account"
      />
      <Field
        label="Account number"
        value={bankAccountNumber}
        onChangeText={setBankAccountNumber}
        keyboardType="numeric"
        autoCapitalize="none"
        placeholder="10-digit account number"
      />
      <Select
        label="Bank"
        value={bankName || null}
        options={bankOptions}
        onChange={setBankName}
        placeholder="Choose bank…"
        searchable
        searchPlaceholder="Search bank name"
      />

      {client.bank_account_name || client.bank_account_number || client.bank_name ? (
        <Pressable
          onPress={() => setPrompting('bank')}
          disabled={submitting}
          style={styles.clearLink}
        >
          <Text style={styles.clearLinkText}>Clear bank details (collects on their own)</Text>
        </Pressable>
      ) : null}
      {prompting === 'bank' ? (
        <ReasonPanel
          title="Clear bank details"
          blurb="Removes this vendor’s account name, number and bank. They’ll be left off the Moniepoint / Kuda payout files — for clients who collect remittance through their own system."
          confirmLabel="Clear"
          submitting={submitting}
          onCancel={() => setPrompting(null)}
          onConfirm={(why) => {
            setPrompting(null);
            void performClearBank(why);
          }}
        />
      ) : null}

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
        prompting !== 'deactivate' ? (
          <Button
            title="Deactivate"
            onPress={() => setPrompting('deactivate')}
            variant="danger"
            style={styles.bottom}
            disabled={submitting}
          />
        ) : (
          <ReasonPanel
            title={`Deactivate ${client.name}?`}
            blurb="Their products will be deactivated too."
            confirmLabel={blockedProducts?.length ? 'Deactivate anyway' : 'Deactivate'}
            submitting={submitting}
            confirmDisabled={!!blockedProducts?.length && !acknowledged}
            onCancel={() => {
              setPrompting(null);
              setBlockedProducts(null);
              setAcknowledged(false);
            }}
            onConfirm={(why) => performDeactivate(why, !!blockedProducts?.length)}
          >
            {blockedProducts?.length ? (
              <View>
                <View style={styles.blockBox}>
                  <Text style={styles.blockTitle}>
                    {blockedProducts.length === 1
                      ? '1 product is still in use'
                      : `${blockedProducts.length} products are still in use`}
                  </Text>
                  <Text style={styles.blockSub}>{blockedProducts.join(', ')}</Text>
                  <Text style={styles.blockSub}>
                    Agents are holding stock, or orders are still open. Clear those first, or
                    deactivate the products individually to see the detail.
                  </Text>
                </View>
                <Pressable
                  onPress={() => setAcknowledged((v) => !v)}
                  style={[styles.ackRow, acknowledged && styles.ackRowOn]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: acknowledged }}
                >
                  <View style={[styles.ackDot, acknowledged && styles.ackDotOn]} />
                  <Text style={styles.ackLabel}>I&apos;ve read the above — deactivate anyway</Text>
                </Pressable>
              </View>
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
  blockBox: {
    borderWidth: 1,
    borderColor: '#f0c9c2',
    borderRadius: 8,
    backgroundColor: '#fff',
    padding: 10,
    marginBottom: 10,
    gap: 6,
  },
  blockTitle: { fontSize: 13, fontWeight: '700', color: '#a02d1b' },
  blockSub: { fontSize: 12, color: '#666', lineHeight: 17 },
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
  ackDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#bbb' },
  ackDotOn: { borderColor: '#a02d1b', backgroundColor: '#a02d1b' },
  ackLabel: { fontSize: 13, color: '#222', flexShrink: 1 },
  hint: { color: '#6b7280', fontSize: 12, marginTop: -8, marginBottom: 8, lineHeight: 16 },
  sectionLabel: {
    fontWeight: '700',
    fontSize: 13,
    color: '#111827',
    marginTop: 20,
    marginBottom: 8,
  },
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
