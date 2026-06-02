import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { deleteDelivery, type DeliveryRow } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';

/** Single-row destructive confirm. Calls delete_delivery directly (not
 *  queued) — matches the BulkAssignSheet precedent: admins are at a desk on
 *  wifi, surfacing the error inline beats burying it in the queue. */
export function DeleteDeliverySheet({
  open,
  delivery,
  onClose,
  onDeleted,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  onClose: () => void;
  /** Fired after the RPC returns 2xx. Parent typically navigates back to
   *  the list and shows a toast. */
  onDeleted: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setReason('');
    setError(null);
  }

  async function submit() {
    if (!delivery?.id) return;
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await deleteDelivery(delivery.id, reason.trim());
      reset();
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!delivery) return null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="Delete delivery"
      subtitle={delivery.customer_name ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          This hides the delivery from lists, the sibling matcher, and reports. It is not undoable
          from the app — only an admin can restore via SQL.
        </Banner>

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. typo dupe — contractor parser"
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
            disabled={submitting}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                backgroundColor: colors.red,
                alignItems: 'center',
                opacity: submitting ? 0.6 : 1,
              },
              pressed && !submitting && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting ? 'Deleting…' : 'Delete'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
