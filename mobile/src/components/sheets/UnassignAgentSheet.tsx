import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Avatar, Banner, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { unassignDelivery } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';

/** Admin/dispatcher/rep confirm sheet for clearing a delivery's assigned
 *  agent. Reason is required and prefixed with 'unassign:' in audit_log on
 *  the server. The previous assignee is NOT push-notified — the assignment-
 *  push trigger gates on `new.assigned_agent_id is not null`. They'll just
 *  stop seeing the row on next refresh. The parent screen is responsible
 *  for refreshing its query on `onUnassigned`. */
export function UnassignAgentSheet({
  open,
  deliveryId,
  agentName,
  onClose,
  onUnassigned,
}: {
  open: boolean;
  /** Delivery to unassign. Null disables the submit button. */
  deliveryId: string | null;
  /** Display name of the currently assigned agent. Used in the warning copy
   *  so the admin sees exactly who they're pulling off. Null falls back to
   *  generic "the assigned agent" wording. */
  agentName: string | null;
  onClose: () => void;
  /** Fired once the RPC returns 2xx. Parent refreshes the delivery / list
   *  and surfaces a toast. */
  onUnassigned: () => void;
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
      await unassignDelivery(deliveryId, reason.trim());
      reset();
      onUnassigned();
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
      title="Unassign agent"
      subtitle={agentName ?? undefined}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="warn" icon="alert">
          {agentName
            ? `This removes ${agentName} from the delivery and moves it back to the Unassigned bucket. ${agentName.split(/\s+/)[0]} will stop seeing it on their next refresh.`
            : 'This clears the assigned agent and moves the delivery back to the Unassigned bucket.'}
        </Banner>

        {agentName ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              backgroundColor: colors.surface,
            }}
          >
            <Avatar user={{ display_name: agentName }} size={28} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                {agentName}
              </Text>
              <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}>
                will be unassigned
              </Text>
            </View>
          </View>
        ) : null}

        <Input
          label="Reason (required)"
          value={reason}
          onChange={setReason}
          placeholder="e.g. wrong rider, contractor changed mind"
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
              {submitting ? 'Unassigning…' : 'Unassign'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}
