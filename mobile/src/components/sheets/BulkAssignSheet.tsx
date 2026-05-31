import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Avatar, Banner, Icon, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { bulkAssignDeliveries } from '@/services/deliveries';
import { type AppUser } from '@/services/users';
import { errorMessage } from '@/lib/errors';

/** Bulk-reassign picker used from the deliveries list's select mode.
 *  Calls bulk_assign_deliveries directly (not via the mutation queue) —
 *  matches the HandoffToSubAgent precedent and avoids a new job kind for
 *  what's typically a 3-5 minute morning batch. Network failures surface
 *  immediately; the caller stays in select mode until success. */
export function BulkAssignSheet({
  open,
  deliveryIds,
  agents,
  onClose,
  onAssigned,
}: {
  open: boolean;
  /** Selected delivery ids. The sheet does nothing until at least one is supplied. */
  deliveryIds: string[];
  /** Active, top-level agents (parent_agent_id IS NULL). The List already filters
   *  this set; passing it down avoids a second roundtrip and means the sheet has
   *  no opinion about role/active filtering. */
  agents: AppUser[];
  onClose: () => void;
  /** Fired with the count actually updated server-side once the RPC returns
   *  2xx. The parent uses this to refresh the list and show a confirmation
   *  toast. */
  onAssigned: (updatedCount: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return agents;
    return agents.filter((a) => (a.display_name ?? '').toLowerCase().includes(needle));
  }, [agents, needle]);

  async function pick(agent: AppUser) {
    if (deliveryIds.length === 0) return;
    setError(null);
    setSubmittingId(agent.id);
    try {
      const updated = await bulkAssignDeliveries(deliveryIds, agent.id);
      onAssigned(updated);
      setQuery('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmittingId(null);
    }
  }

  const submitting = submittingId !== null;
  const countLabel = `${deliveryIds.length} ${deliveryIds.length === 1 ? 'delivery' : 'deliveries'}`;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) {
          setQuery('');
          setError(null);
          onClose();
        }
      }}
      title="Assign to…"
      subtitle={countLabel}
    >
      <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
        <Input
          icon="search"
          value={query}
          onChange={setQuery}
          placeholder="Search agent name"
          autoCapitalize="none"
          autoCorrect={false}
          rightAdornment={
            query ? (
              <Pressable
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={8}
              >
                <Icon name="x" size={16} color={colors.textSecondary} />
              </Pressable>
            ) : null
          }
        />
      </View>

      {error ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        </View>
      ) : null}

      <View style={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        {filtered.length === 0 ? (
          <View style={{ padding: 20 }}>
            <Banner tone="info" icon="alert">
              {needle ? `No agents matching "${query}".` : 'No active agents to assign to.'}
            </Banner>
          </View>
        ) : (
          filtered.map((u) => {
            const isThisOne = submittingId === u.id;
            return (
              <Pressable
                key={u.id}
                onPress={() => pick(u)}
                disabled={submitting}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                    opacity: submitting && !isThisOne ? 0.5 : 1,
                  },
                  pressed && !submitting && { backgroundColor: colors.surface },
                ]}
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
          })
        )}
      </View>
    </Sheet>
  );
}
