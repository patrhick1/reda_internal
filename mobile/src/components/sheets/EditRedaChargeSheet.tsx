import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { correctDeliveryRedaCharge, type DeliveryRedaCharge } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';

export function EditRedaChargeSheet({
  open,
  deliveryId,
  charge,
  customerName,
  onClose,
  onSaved,
}: {
  open: boolean;
  deliveryId: string | null;
  charge: DeliveryRedaCharge | null;
  customerName: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(charge?.charged_snapshot != null ? String(charge.charged_snapshot) : '');
      setReason('');
      setError(null);
    }
  }, [open, charge]);

  const amount = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(amount) && amount >= 0;
  const unchanged = valid && amount === charge?.charged_snapshot;

  async function submit() {
    if (!deliveryId || !valid || !reason.trim()) {
      setError(!reason.trim() ? 'Reason is required' : 'Enter a valid non-negative charge');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await correctDeliveryRedaCharge(deliveryId, amount, reason.trim());
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
      onClose={() => !submitting && onClose()}
      title="Edit Reda charge"
      subtitle={customerName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          This changes client reconciliation for this delivery only. It does not change the rate
          card or the agent&apos;s earnings.
        </Banner>
        {charge?.client_day_settled ? (
          <Banner tone="error" icon="lock">
            This client day is already settled. Void the settlement before changing the charge.
          </Banner>
        ) : null}
        <Input label="Reda charge (₦)" value={value} onChange={setValue} keyboardType="numeric" />
        {charge?.recommended_charge != null ? (
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
            Current rate-based charge: {formatNaira(charge.recommended_charge)}
          </Text>
        ) : null}
        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="Why this delivery needs a different Reda charge"
          multiline
          numberOfLines={3}
        />
        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={onClose}
            disabled={submitting}
            style={({ pressed }) => ({
              paddingVertical: 14,
              paddingHorizontal: 20,
              borderRadius: 999,
              borderWidth: 1.5,
              borderColor: colors.black,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ fontFamily: fonts.bold, color: colors.black }}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={submitting || unchanged || charge?.client_day_settled}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 14,
              borderRadius: 999,
              alignItems: 'center',
              backgroundColor: colors.black,
              opacity:
                submitting || unchanged || charge?.client_day_settled ? 0.5 : pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ fontFamily: fonts.bold, color: colors.white }}>
              {submitting ? 'Saving…' : unchanged ? 'No changes' : 'Save charge'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
