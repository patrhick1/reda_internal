import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import {
  listStatusDefs,
  listTransitionsFrom,
  type DeliveryRow,
} from '@/services/deliveries';
import { useEnqueueChangeStatus } from '@/queue/mutations';
import { errorMessage } from '@/lib/errors';

type PaymentMethod = 'cash' | 'transfer';

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'transfer', label: 'Transfer' },
];

export function StatusUpdatePanel({
  delivery,
  isAdmin,
  onCancel,
  onCommitted,
}: {
  delivery: DeliveryRow;
  isAdmin: boolean;
  onCancel: () => void;
  onCommitted: (newStatus: string) => void;
}) {
  const currentStatus = delivery.current_status ?? 'pending';
  const transitionsQ = useAsync(() => listTransitionsFrom(currentStatus, isAdmin), [currentStatus, isAdmin]);
  const defsQ = useAsync(() => listStatusDefs(), []);

  const [toStatus, setToStatus] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [quantityDelivered, setQuantityDelivered] = useState(String(delivery.quantity_ordered ?? ''));
  const [paid, setPaid] = useState(delivery.customer_price !== null ? String(delivery.customer_price) : '');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>('transfer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueStatus = useEnqueueChangeStatus();

  const labelByStatus = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of defsQ.data ?? []) m.set(d.status, d.label);
    return m;
  }, [defsQ.data]);

  const options = useMemo(
    () =>
      (transitionsQ.data ?? []).map((t) => ({
        value: t.to_status,
        label: labelByStatus.get(t.to_status) ?? t.to_status,
      })),
    [transitionsQ.data, labelByStatus],
  );

  const selectedTransition = (transitionsQ.data ?? []).find((t) => t.to_status === toStatus) ?? null;
  const reasonRequired = !!selectedTransition?.requires_reason;
  const deliveredFieldsRequired = toStatus === 'delivered';

  async function submit() {
    setError(null);
    if (!toStatus) {
      setError('Pick the new status');
      return;
    }
    if (reasonRequired && !reason.trim()) {
      setError('A reason is required for this transition');
      return;
    }

    let qty: number | null = null;
    let paidNum: number | null = null;
    let method: PaymentMethod | null = null;
    if (deliveredFieldsRequired) {
      qty = Number(quantityDelivered);
      paidNum = Number(paid);
      if (!Number.isInteger(qty) || qty <= 0) {
        setError('Quantity delivered must be a positive whole number');
        return;
      }
      if (delivery.quantity_ordered !== null && qty > delivery.quantity_ordered) {
        setError(`Quantity delivered cannot exceed ordered (${delivery.quantity_ordered})`);
        return;
      }
      if (!Number.isFinite(paidNum) || paidNum < 0) {
        setError('Paid must be ≥ 0');
        return;
      }
      if (!paymentMethod) {
        setError('Pick a payment method');
        return;
      }
      method = paymentMethod;
    }

    setSubmitting(true);
    try {
      await enqueueStatus({
        deliveryId: delivery.id ?? '',
        toStatus,
        reason: reason.trim() || null,
        notes: notes.trim() || null,
        quantityDelivered: qty,
        paid: paidNum,
        paymentMethod: method,
      }, `Status → ${toStatus} · ${delivery.customer_name ?? ''}`);
      onCommitted(toStatus);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (transitionsQ.loading || defsQ.loading) {
    return <View style={styles.center}><ActivityIndicator /></View>;
  }
  if (transitionsQ.error || defsQ.error) {
    return (
      <View style={styles.panel}>
        <Text style={styles.errorText}>{transitionsQ.error ?? defsQ.error}</Text>
        <TouchableOpacity onPress={onCancel}><Text style={styles.cancelLink}>Cancel</Text></TouchableOpacity>
      </View>
    );
  }
  if (options.length === 0) {
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>No transitions available</Text>
        <Text style={styles.panelSub}>
          From {labelByStatus.get(currentStatus) ?? currentStatus}, there’s nothing you’re allowed to change to.
          {isAdmin ? '' : ' (Backward transitions require admin.)'}
        </Text>
        <Button title="Close" onPress={onCancel} variant="secondary" />
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Update status</Text>
      <Text style={styles.panelSub}>
        Current: <Text style={styles.bold}>{labelByStatus.get(currentStatus) ?? currentStatus}</Text>
      </Text>

      <Select
        label="New status"
        required
        value={toStatus}
        options={options}
        onChange={setToStatus}
      />

      {deliveredFieldsRequired ? (
        <>
          <Field
            label="Quantity delivered"
            required
            value={quantityDelivered}
            onChangeText={setQuantityDelivered}
            keyboardType="numeric"
            autoCapitalize="none"
          />
          <Field
            label="Paid (₦)"
            required
            value={paid}
            onChangeText={setPaid}
            keyboardType="numeric"
            autoCapitalize="none"
          />
          <Select
            label="Payment method"
            required
            value={paymentMethod}
            options={PAYMENT_OPTIONS}
            onChange={setPaymentMethod}
          />
        </>
      ) : null}

      <Field
        label={reasonRequired ? 'Reason' : 'Reason (optional)'}
        required={reasonRequired}
        value={reason}
        onChangeText={setReason}
        placeholder={reasonRequired ? 'Required for this transition' : ''}
      />

      <Field label="Notes" value={notes} onChangeText={setNotes} multiline />

      {error ? (
        <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
      ) : null}

      <Button title="Apply" onPress={submit} loading={submitting} />
      <Button title="Cancel" onPress={onCancel} variant="secondary" style={styles.bottom} disabled={submitting} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { padding: 16, alignItems: 'center' },
  panel: {
    marginTop: 16,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d9e2ec',
    backgroundColor: '#f6f9fc',
  },
  panelTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 4 },
  panelSub: { fontSize: 13, color: '#444', marginBottom: 12 },
  bold: { fontWeight: '700', color: '#111' },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  cancelLink: { color: '#1a4b8c', textAlign: 'center', marginTop: 8 },
  bottom: { marginTop: 12 },
});
