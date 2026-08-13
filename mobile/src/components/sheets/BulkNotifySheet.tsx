import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Sheet } from '@/components/ui';
import { awaitsClientNotification, colors, fonts } from '@/lib/theme';
import { bulkMarkClientNotified, type BulkNotifyCounts } from '@/services/clientNotifications';
import { errorMessage } from '@/lib/errors';
import type { DeliveryRow } from '@/services/deliveries';

/**
 * Tag a selection of deliveries as "client notified on WhatsApp".
 *
 * The ops flow this replaces: filter the list to "To notify", then open each
 * delivery, tap Notified, back out, open the next. Tagging is the last step of
 * a conversation that already happened in WhatsApp — one message usually covers
 * several orders — so the one-at-a-time walk was pure transcription.
 *
 * Eligibility is previewed client-side from data the list row already carries,
 * and leans on `awaitsClientNotification` — the same predicate behind the "To
 * notify" filter and the rep-performance SLA denominator. That keeps three
 * surfaces answering "does the vendor need telling?" identically, including the
 * exempt statuses and the auto-cancel-soft-fails client policy. Ineligible rows
 * are skipped and counted rather than sent and refused.
 */
export function BulkNotifySheet({
  open,
  selected,
  onClose,
  onNotified,
}: {
  open: boolean;
  /** Full DeliveryRow objects for the current selection, so the eligibility
   *  preview costs no extra roundtrip. */
  selected: DeliveryRow[];
  onClose: () => void;
  /** Fired once every row has settled. Parent shows a toast and refreshes. */
  onNotified: (counts: BulkNotifyCounts) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { eligibleIds, alreadyCount, exemptCount, noHistoryCount } = useMemo(() => {
    const ids: string[] = [];
    let already = 0;
    let exempt = 0;
    let noHistory = 0;
    for (const d of selected) {
      if (!d.latest_history_id) {
        noHistory += 1;
      } else if (d.latest_notified) {
        already += 1;
      } else if (!awaitsClientNotification(d)) {
        // Status the vendor doesn't need told (pending/delivered/rolled over/…)
        // or a client whose soft-fails close silently.
        exempt += 1;
      } else {
        ids.push(d.latest_history_id);
      }
    }
    return {
      eligibleIds: ids,
      alreadyCount: already,
      exemptCount: exempt,
      noHistoryCount: noHistory,
    };
  }, [selected]);

  async function submit() {
    if (eligibleIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const counts = await bulkMarkClientNotified(eligibleIds);
      onNotified(counts);
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
          setError(null);
          onClose();
        }
      }}
      title="Mark client notified"
      subtitle={`${selected.length} selected`}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="info" icon="check">
          Tags the latest status on each delivery as communicated to the client. It does not send
          anything — it records that you already did.
        </Banner>

        {alreadyCount > 0 ? (
          <Banner tone="info" icon="alert">
            {`${alreadyCount} ${alreadyCount === 1 ? 'is' : 'are'} already tagged and will be skipped.`}
          </Banner>
        ) : null}

        {exemptCount > 0 ? (
          <Banner tone="info" icon="alert">
            {`${exemptCount} ${exemptCount === 1 ? 'is' : 'are'} at a status the client doesn't need told — skipped.`}
          </Banner>
        ) : null}

        {noHistoryCount > 0 ? (
          <Banner tone="info" icon="alert">
            {`${noHistoryCount} ${noHistoryCount === 1 ? 'has' : 'have'} no status history yet — nothing to tag.`}
          </Banner>
        ) : null}

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pressable
            onPress={() => {
              setError(null);
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
            disabled={submitting || eligibleIds.length === 0}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                backgroundColor: colors.black,
                alignItems: 'center',
                opacity: submitting || eligibleIds.length === 0 ? 0.6 : 1,
              },
              pressed && !submitting && eligibleIds.length > 0 && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting
                ? 'Tagging…'
                : eligibleIds.length === 0
                  ? 'Nothing to tag'
                  : `Mark ${eligibleIds.length} notified`}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
