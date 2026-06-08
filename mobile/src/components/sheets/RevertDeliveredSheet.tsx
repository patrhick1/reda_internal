import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { revertDeliveryToPending } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';

/** Admin + dispatcher confirm sheet for reverting a wrongly-`delivered` row
 *  back to `pending`. Required reason is prefixed with 'revert_delivered:'
 *  in the audit_log on the server. The assigned agent gets a status-change
 *  push (via the existing tg_notify_delivery_status_change trigger) —
 *  desirable UX so they know their fat-fingered delivered was undone. The
 *  parent screen is responsible for refreshing its query on `onReverted`. */
export function RevertDeliveredSheet({
  open,
  deliveryId,
  customerName,
  onClose,
  onReverted,
}: {
  open: boolean;
  /** Delivery to revert. Null disables the submit button. */
  deliveryId: string | null;
  /** Customer name for the warning copy. Falls back to "this delivery". */
  customerName: string | null;
  onClose: () => void;
  /** Fired once the RPC returns 2xx. Parent reloads the delivery + history
   *  queries; stays on Detail so admin can immediately re-status or
   *  unassign without re-navigating. */
  onReverted: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setReason('');
    setError(null);
  }

  async function submit() {
    if (!deliveryId) return;
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await revertDeliveryToPending(deliveryId, reason.trim());
      reset();
      onReverted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  const target = customerName ?? 'this delivery';

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="Revert delivered"
      subtitle={customerName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          {`This puts ${target} back to Pending and clears the delivered values — quantity, paid amount, payment method, and the cash POS fee — so reports don't show stale numbers. Stock auto-recovers; the assigned agent is notified and can re-update the status.`}
        </Banner>

        {/* What stays untouched — keeps admin's mental model accurate. */}
        <View
          style={{
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: colors.surface,
            gap: 4,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 10,
              color: colors.textSecondary,
              letterSpacing: 0.8,
              textTransform: 'uppercase',
            }}
          >
            Not touched
          </Text>
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
            Agent assignment · location · fee snapshots · cancelled siblings
          </Text>
        </View>

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. agent tapped delivered by mistake; customer never received"
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
                backgroundColor: colors.red,
                alignItems: 'center',
                opacity: submitting || !deliveryId ? 0.6 : 1,
              },
              pressed && !submitting && deliveryId && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting ? 'Reverting…' : 'Revert to Pending'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
