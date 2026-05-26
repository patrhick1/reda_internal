import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Avatar, Banner, Icon, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { useAsync } from '@/hooks/useAsync';
import { listSubAgents, type AppUser } from '@/services/users';
import { reassignToSubAgent, type DeliveryRow } from '@/services/deliveries';
import { errorMessage } from '@/lib/errors';

/** Team-lead handoff: lead picks one of her sub-agents to take over the
 *  delivery. Calls the `reassign_to_sub_agent` RPC directly (not via the
 *  status-change queue) because reassignment isn't a status transition —
 *  the existing assignment-push trigger fires server-side and notifies the
 *  new assignee. */
export function HandoffToSubAgentSheet({
  open, delivery, leadId, onClose, onCommitted,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  leadId: string;
  onClose: () => void;
  /** Fired once the RPC returns 2xx so the parent can refresh + reflect the
   *  new assignee. The delivery will now show under the sub-agent. */
  onCommitted: () => void;
}) {
  const subAgentsQ = useAsync<AppUser[]>(
    () => (open && delivery ? listSubAgents(leadId) : Promise.resolve([])),
    [open, leadId],
  );

  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handoff(subAgent: AppUser) {
    if (!delivery?.id) return;
    setError(null);
    setSubmittingId(subAgent.id);
    try {
      // Fresh client_uuid per tap. Re-tapping the same sub-agent quickly is
      // a safe no-op on the server (idempotent retry), and a different
      // sub-agent gets a fresh uuid so it's not a duplicate.
      const clientUuid = `handoff:${delivery.id}:${subAgent.id}:${Date.now()}`;
      await reassignToSubAgent(delivery.id, subAgent.id, clientUuid);
      onCommitted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmittingId(null);
    }
  }

  if (!delivery) return null;

  const subAgents = subAgentsQ.data ?? [];
  const submitting = submittingId !== null;

  return (
    <Sheet
      open={open}
      onClose={() => { if (!submitting) onClose(); }}
      title="Hand off to your team"
      subtitle={delivery.customer_name ?? undefined}
    >
      {subAgentsQ.loading ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : subAgentsQ.error ? (
        <View style={{ padding: 20 }}>
          <Banner tone="error" icon="alert">{subAgentsQ.error}</Banner>
        </View>
      ) : subAgents.length === 0 ? (
        <View style={{ padding: 20 }}>
          <Banner tone="info" icon="alert">
            You have no active sub-agents to hand this off to.
          </Banner>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 12, paddingBottom: 24, paddingTop: 4 }}>
          {error ? (
            <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
              <Banner tone="error" icon="alert">{error}</Banner>
            </View>
          ) : null}
          {subAgents.map((u) => {
            const isThisOne = submittingId === u.id;
            return (
              <Pressable
                key={u.id}
                onPress={() => handoff(u)}
                disabled={submitting}
                style={({ pressed }) => ([{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  opacity: submitting && !isThisOne ? 0.5 : 1,
                }, pressed && !submitting && { backgroundColor: colors.surface }])}
              >
                <Avatar user={{ display_name: u.display_name }} size={32} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>
                    {u.display_name}
                  </Text>
                </View>
                {isThisOne ? (
                  <ActivityIndicator color={colors.black} />
                ) : (
                  <Icon name="chevronRight" size={18} color={colors.textSecondary} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}
