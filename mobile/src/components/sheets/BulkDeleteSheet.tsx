import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { bulkDeleteDeliveries, type DeliveryRow } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';
import { canDeleteDeliveryByStatus } from '@/lib/permissions';

/** Admin-only bulk destructive confirm. Server skips delivered/rolled_over
 *  and already-deleted rows; this sheet previews that skip count client-side
 *  so the admin knows what's about to happen before the server confirms. */
export function BulkDeleteSheet({
  open,
  selected,
  onClose,
  onDeleted,
}: {
  open: boolean;
  /** Full DeliveryRow objects for the current selection. Lets the sheet
   *  compute the eligibility preview without a second roundtrip. */
  selected: DeliveryRow[];
  onClose: () => void;
  /** Fired after the RPC returns 2xx with the per-row counts. Parent shows
   *  a toast and refreshes the list. */
  onDeleted: (counts: { deletedCount: number; skippedCount: number }) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ineligibleCount = useMemo(
    () => selected.filter((d) => !canDeleteDeliveryByStatus(d.current_status)).length,
    [selected],
  );
  const eligibleCount = selected.length - ineligibleCount;

  function reset() {
    setReason('');
    setError(null);
  }

  async function submit() {
    if (selected.length === 0) return;
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ids = selected.map((d) => d.id).filter((id): id is string => !!id);
      const counts = await bulkDeleteDeliveries(ids, reason.trim());
      reset();
      onDeleted(counts);
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
      title="Delete deliveries"
      subtitle={`${selected.length} selected`}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          This hides the deliveries from lists, the sibling matcher, and reports. Not undoable from
          the app.
        </Banner>

        {ineligibleCount > 0 ? (
          <Banner tone="info" icon="alert">
            {`${ineligibleCount} ${ineligibleCount === 1 ? 'row' : 'rows'} will be skipped (delivered or rolled over).`}
          </Banner>
        ) : null}

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. typo dupes — contractor parser"
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
            disabled={submitting || eligibleCount === 0}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                backgroundColor: colors.red,
                alignItems: 'center',
                opacity: submitting || eligibleCount === 0 ? 0.6 : 1,
              },
              pressed && !submitting && eligibleCount > 0 && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting
                ? 'Deleting…'
                : eligibleCount === 0
                  ? 'Nothing eligible'
                  : `Delete ${eligibleCount}`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
