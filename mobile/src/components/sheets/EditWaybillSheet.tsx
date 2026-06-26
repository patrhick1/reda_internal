import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { listClients, type Client } from '@/services/clients';
import { updateWaybill } from '@/services/deliveries';
import { formatNaira } from '@/lib/format';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

const TYPE_OPTIONS = [
  { value: 'Pickup', label: 'Pickup' },
  { value: 'Waybill', label: 'Waybill' },
  { value: 'Failed delivery', label: 'Failed delivery' },
];

function num(s: string): number {
  const n = Number(s.replace(/[,₦\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Admin/dispatcher edit sheet for a waybill / pickup / failed-delivery. These
 *  are money-only rows created as `delivered`, so the normal editors won't touch
 *  them — this is the dedicated correction path (update_waybill RPC). Lets Uzo
 *  fix a wrong client, amount, type, or the client-facing breakdown note. The
 *  parent reloads its queries on `onSaved`. */
export function EditWaybillSheet({
  open,
  deliveryId,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Waybill to edit. Null disables submit. */
  deliveryId: string | null;
  /** Current values to prefill. Null while the row is loading. */
  initial: { clientId: string | null; charged: number; paidOut: number; label: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const clientsQ = useAsync<Client[]>(() => listClients(), []);

  const [clientId, setClientId] = useState<string | null>(null);
  const [label, setLabel] = useState('Waybill');
  const [charge, setCharge] = useState('');
  const [paidOut, setPaidOut] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form to the row's current values whenever the sheet opens.
  useEffect(() => {
    if (open && initial) {
      setClientId(initial.clientId);
      setLabel(initial.label || 'Waybill');
      setCharge(String(initial.charged ?? ''));
      setPaidOut(String(initial.paidOut ?? ''));
      setNote(`${initial.label || 'Waybill'} ${formatNaira(initial.charged ?? 0)}`);
      setError(null);
    }
  }, [open, initial]);

  const clientOptions = useMemo(
    () => (clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clientsQ.data],
  );

  const chargeNum = num(charge);
  const paidNum = num(paidOut);
  const margin = chargeNum - paidNum;
  const valid = !!deliveryId && !!clientId && charge.trim() !== '' && paidOut.trim() !== '';

  async function submit() {
    if (!deliveryId || !clientId) {
      setError('Pick the client');
      return;
    }
    if (charge.trim() === '' || paidOut.trim() === '') {
      setError('Enter what you charge the client and what Reda paid out');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateWaybill({
        deliveryId,
        clientId,
        charged: chargeNum,
        paidOut: paidNum,
        label,
        note: note.trim() || null,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Edit pickup / waybill"
    >
      <View style={{ padding: 20, gap: 14, paddingBottom: 32 }}>
        <Banner tone="info" icon="helpCircle">
          Fix the client, amount, or type on this money-only order. The client charge feeds their
          reconciliation. Editing is blocked if that client&apos;s day has already been settled.
        </Banner>

        <Select
          label="Client"
          value={clientId}
          options={clientOptions}
          onChange={setClientId}
          placeholder={clientsQ.loading ? 'Loading clients…' : 'Pick the client'}
          searchable
        />

        <Select label="Type" value={label} options={TYPE_OPTIONS} onChange={setLabel} />

        <Input
          label="Charge to client"
          value={charge}
          onChange={setCharge}
          keyboardType="numeric"
          placeholder="e.g. 3000"
        />
        <Input
          label="Reda paid out (Uber / driver / agent)"
          value={paidOut}
          onChange={setPaidOut}
          keyboardType="numeric"
          placeholder="e.g. 6000"
        />
        <Input
          label="Charge breakdown (shown on the client report)"
          value={note}
          onChange={setNote}
          placeholder="e.g. Failed delivery ₦3,000"
          multiline
          numberOfLines={2}
        />

        <View
          style={{
            backgroundColor: colors.surfaceAlt,
            borderRadius: 12,
            padding: 12,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
            Reda margin
          </Text>
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 15,
              color: margin < 0 ? colors.red : colors.success,
            }}
          >
            {formatNaira(margin)}
          </Text>
        </View>

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <Button onPress={submit} disabled={!valid || submitting} full>
          {submitting ? 'Saving…' : 'Save changes'}
        </Button>
      </View>
    </Sheet>
  );
}
