import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { newClientUuid } from '@/lib/uuid';
import { correctSameCustomerNormalFee, type SameCustomerShadowPay } from '@/services/same-customer';

export function SameCustomerNormalFeeSheet({
  pay,
  onClose,
  onSaved,
}: {
  pay: SameCustomerShadowPay;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(pay.normal_fee == null ? '' : String(pay.normal_fee));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const amount = Number(value);
  const valid =
    /^\d+(\.\d{1,2})?$/.test(value.trim()) && Number.isFinite(amount) && amount <= 99999999.99;
  const changed = valid && amount !== pay.normal_fee;
  async function save() {
    if (!changed || !reason.trim() || busy) return;
    const input = {
      deliveryId: pay.delivery_id,
      revision: pay.revision,
      normalFee: amount,
      reason: reason.trim(),
    };
    const payload = JSON.stringify(input);
    if (request.current?.payload !== payload) request.current = { payload, id: newClientUuid() };
    setBusy(true);
    setError(null);
    try {
      await correctSameCustomerNormalFee({ ...input, requestId: request.current.id });
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      open
      title="Correct normal rider fee"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="info">
          {pay.mode === 'shadow'
            ? 'Set the correct normal fee for this delivery. The preview will recalculate; current payable amounts stay unchanged.'
            : 'Set the correct normal fee for this delivery. Related open earnings will recalculate using the applicable pay rule.'}
        </Banner>
        <Text>
          Current normal fee: {pay.normal_fee == null ? 'Not set' : formatNaira(pay.normal_fee)}
        </Text>
        {pay.manual_amount != null ? (
          <Banner tone="info">
            A manual exception is recorded. Correcting the normal fee may require renewed group
            review.
          </Banner>
        ) : null}
        <Input
          label="Correct normal fee (₦)"
          value={value}
          onChange={(v) => {
            if (!busy) setValue(v);
          }}
          keyboardType="decimal-pad"
          maxLength={11}
          helper="Use the full normal fee, with up to two decimal places."
        />
        {value && !valid ? (
          <Banner tone="error">
            Enter an amount from 0 to 99,999,999.99, with at most two decimal places.
          </Banner>
        ) : null}
        <Input
          label="Reason and rate evidence"
          value={reason}
          onChange={(v) => {
            if (!busy) setReason(v);
          }}
          multiline
          maxLength={2000}
        />
        {error ? <Banner tone="error">{error}</Banner> : null}
        <Button disabled={busy || !changed || !reason.trim()} onPress={() => void save()}>
          {busy ? 'Saving…' : 'Save corrected normal fee'}
        </Button>
        <Button variant="secondary" disabled={busy} onPress={onClose}>
          Cancel and refresh
        </Button>
      </View>
    </Sheet>
  );
}
