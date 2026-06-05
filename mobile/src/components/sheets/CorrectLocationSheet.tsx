import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { colors, fonts } from '@/lib/theme';
import { correctDeliveryLocation } from '@/services/deliveries';
import { listLocations, type Location } from '@/services/locations';
import { errorMessage } from '@/lib/errors';

/** Admin-only confirm sheet for correcting the location on an already-DELIVERED
 *  row. The server (`correct_delivery_location`) re-snapshots BOTH the Reda
 *  charge and the agent's earning from the new location's rate card — the copy
 *  here makes that money impact explicit so the admin understands this is not a
 *  cosmetic edit. Reason is required and prefixed with 'location_correction:'
 *  in audit_log. The parent screen refreshes the delivery on `onCorrected`. */
export function CorrectLocationSheet({
  open,
  deliveryId,
  currentLocationId,
  currentLocationName,
  onClose,
  onCorrected,
}: {
  open: boolean;
  /** Delivery to correct. Null disables the submit button. */
  deliveryId: string | null;
  /** The row's current location_id — excluded from the picker so the admin
   *  can't "correct" to the same value (the server rejects it anyway). */
  currentLocationId: string | null;
  /** Current location display name for the warning copy. Null falls back to
   *  "no location set" wording (legacy delivered rows can have a null one). */
  currentLocationName: string | null;
  onClose: () => void;
  /** Fired once the RPC returns 2xx. Parent reloads the delivery + history. */
  onCorrected: () => void;
}) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function submit() {
    if (!deliveryId) return;
    if (!locationId) {
      setError('Pick the correct location');
      return;
    }
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await correctDeliveryLocation(deliveryId, locationId, reason.trim());
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
      title="Correct location"
      subtitle={currentLocationName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          {`This delivery is already delivered. Changing its location recomputes both Reda's charge and the agent's earning from the new location's rate — it will change what this delivery contributes to reconciliation. Currently set to ${
            currentLocationName ?? 'no location'
          }.`}
        </Banner>

        <Select
          label="Correct location"
          value={locationId}
          options={options}
          onChange={setLocationId}
          placeholder={locationsQ.loading ? 'Loading locations…' : 'Pick the right location'}
        />

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. AI matched wrong area; delivered to Surulere not Yaba"
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
              {submitting ? 'Correcting…' : 'Correct location'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
