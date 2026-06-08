import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { clearDeliveryLocation } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';

/** Admin + dispatcher confirm sheet for clearing `location_id` on a non-
 *  terminal delivery. Closes the gap left by update_delivery_fields'
 *  coalesce contract — passing NULL there means "don't change", so the
 *  only way to put a row back to "no zone yet" is this purpose-built RPC.
 *  Reason required, prefixed with 'clear_location:' in audit_log. The
 *  assigned agent (if any) keeps the row but sees no zone label until
 *  admin re-locates. The parent screen reloads on `onCleared`. */
export function ClearLocationSheet({
  open,
  deliveryId,
  customerName,
  onClose,
  onCleared,
}: {
  open: boolean;
  /** Delivery to clear. Null disables the submit button. */
  deliveryId: string | null;
  /** Customer name for the warning copy. Falls back to "this delivery". */
  customerName: string | null;
  onClose: () => void;
  /** Fired once the RPC returns 2xx. Parent reloads the delivery + history
   *  queries; stays on Edit so admin can immediately pick a new location. */
  onCleared: () => void;
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
      await clearDeliveryLocation(deliveryId, reason.trim());
      reset();
      onCleared();
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
      title="Clear location"
      subtitle={customerName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          {`This unsets the zone for ${target}. The row goes back to "no zone yet" and can't be marked delivered until a new location is set. Snapshots stay frozen and will refresh when you pick the new zone.`}
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
            Agent assignment · raw address · price · fee snapshots
          </Text>
        </View>

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. customer's address was misread; awaiting clarification"
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
              {submitting ? 'Clearing…' : 'Clear location'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
