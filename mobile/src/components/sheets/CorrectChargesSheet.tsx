import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { correctDeliveryCharge } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';

/** Admin-only sheet to manually override a delivery's snapshotted Reda charge
 *  and agent payout. Reached from the Negative-margin review flow: a row whose
 *  charge cap clamped below the agent fee lands with margin < 0, and this is
 *  where Uzo fixes the numbers. The live margin preview turns red while the
 *  charge is still below the agent payout. Reason required; the server
 *  (correct_delivery_charge) re-checks admin + non-negative + changed, prefixes
 *  the audit reason 'charge_correction:', and the parent reloads on onCorrected. */
export function CorrectChargesSheet({
  open,
  deliveryId,
  currentCharged,
  currentAgentPayment,
  customerName,
  onClose,
  onCorrected,
}: {
  open: boolean;
  deliveryId: string | null;
  currentCharged: number | null;
  currentAgentPayment: number | null;
  customerName: string | null;
  onClose: () => void;
  onCorrected: () => void;
}) {
  const [charged, setCharged] = useState('');
  const [agentPayment, setAgentPayment] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the inputs from the row's current snapshots each time the sheet opens.
  useEffect(() => {
    if (open) {
      setCharged(currentCharged != null ? String(currentCharged) : '');
      setAgentPayment(currentAgentPayment != null ? String(currentAgentPayment) : '');
      setReason('');
      setError(null);
    }
  }, [open, currentCharged, currentAgentPayment]);

  const chargedNum = Number(charged);
  const agentNum = Number(agentPayment);
  const bothValid =
    charged.trim() !== '' &&
    agentPayment.trim() !== '' &&
    Number.isFinite(chargedNum) &&
    Number.isFinite(agentNum) &&
    chargedNum >= 0 &&
    agentNum >= 0;
  const margin = bothValid ? chargedNum - agentNum : null;

  function reset() {
    setCharged('');
    setAgentPayment('');
    setReason('');
    setError(null);
  }

  async function submit() {
    if (!deliveryId) return;
    if (!bothValid) {
      setError('Enter a valid charge and agent payment (non-negative numbers)');
      return;
    }
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await correctDeliveryCharge(deliveryId, chargedNum, agentNum, reason.trim());
      reset();
      onCorrected();
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
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="Correct charges"
      subtitle={customerName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          These amounts feed reconciliation directly. Overriding them changes what this delivery
          contributes to Reda&apos;s and the agent&apos;s totals — use it to fix a charge that was
          capped below the agent payout.
        </Banner>

        <Input
          label="Reda charge (₦)"
          value={charged}
          onChange={setCharged}
          keyboardType="numeric"
          placeholder="e.g. 7000"
        />
        <Input
          label="Agent earns (₦)"
          value={agentPayment}
          onChange={setAgentPayment}
          keyboardType="numeric"
          placeholder="e.g. 6000"
        />

        {margin != null ? (
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              Resulting margin
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
        ) : null}

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. cap clamped charge below agent fee; set to rate-card 7000"
          autoCapitalize="sentences"
          multiline
          numberOfLines={3}
        />

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pressable
            onPress={() => {
              reset();
              onClose();
            }}
            disabled={submitting}
            style={({ pressed }) => [
              {
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                borderWidth: 1.5,
                borderColor: colors.black,
                backgroundColor: colors.white,
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
              Cancel
            </Text>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={submitting || !deliveryId}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                backgroundColor: colors.black,
                alignItems: 'center',
                opacity: submitting || !deliveryId ? 0.6 : 1,
              },
              pressed && !submitting && deliveryId && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting ? 'Saving…' : 'Save charges'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
