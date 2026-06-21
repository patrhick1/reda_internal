import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { colors, fonts } from '@/lib/theme';
import { listLocations, type Location } from '@/services/locations';
import { useEnqueueAgentChangeLocation } from '@/queue/mutations';
import { errorMessage } from '@/lib/errors';

/** Agent-facing: record the ACTUAL delivery zone when the customer was delivered
 *  somewhere other than the ordered area. The server (`agent_change_delivery_location`)
 *  re-snapshots the rate and either auto-applies (pay not raised) or holds for a
 *  manager (pay raised). Queued through the offline mutation queue, so it is
 *  offline-resilient; the decision (applied vs awaiting approval) happens
 *  server-side when the job drains, so the copy here sets that expectation. */
export function ChangeDeliveryZoneSheet({
  open,
  deliveryId,
  customerName,
  currentLocationId,
  currentLocationName,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  deliveryId: string | null;
  customerName: string | null;
  currentLocationId: string | null;
  currentLocationName: string | null;
  onClose: () => void;
  /** Fired once the zone-change job is enqueued. */
  onSubmitted: () => void;
}) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueZoneChange = useEnqueueAgentChangeLocation();

  const locationsQ = useAsync<Location[]>(() => listLocations(), []);
  const options = useMemo(
    () =>
      (locationsQ.data ?? [])
        .filter((l) => l.id !== currentLocationId)
        .map((l) => ({ value: l.id, label: l.name })),
    [locationsQ.data, currentLocationId],
  );

  function reset() {
    setLocationId(null);
    setReason('');
    setError(null);
  }

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  async function submit() {
    if (!deliveryId) return;
    if (!locationId) {
      setError('Pick the zone you actually delivered to');
      return;
    }
    if (!reason.trim()) {
      setError('Add a short reason');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await enqueueZoneChange(
        { deliveryId, toLocationId: locationId, reason: reason.trim() },
        `Zone change · ${customerName ?? ''}`,
      );
      reset();
      onSubmitted();
      onClose();
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
      title="Delivered at a different area"
      subtitle={currentLocationName ? `Ordered zone: ${currentLocationName}` : undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="info" icon="alert">
          Pick the zone you actually delivered to. If it raises your delivery pay, a manager
          approves it first; otherwise it applies right away.
        </Banner>

        <Select
          label="Actual delivery zone"
          value={locationId}
          options={options}
          onChange={setLocationId}
          placeholder={locationsQ.loading ? 'Loading zones…' : 'Pick the zone'}
        />

        <Input
          label="Reason"
          value={reason}
          onChange={setReason}
          placeholder="e.g. customer asked me to bring it to their office in VI"
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
              {submitting ? 'Submitting…' : 'Submit zone change'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
