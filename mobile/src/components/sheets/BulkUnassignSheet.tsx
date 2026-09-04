import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { colors, fonts, TERMINAL_STATUSES } from '@/lib/theme';
import {
  bulkUnassignDeliveries,
  type BulkUnassignResult,
  type DeliveryRow,
} from '@/services/deliveries';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';

/** The reasons the audit log actually sees for manual unassigns, offered as
 *  one-tap chips. A required free-text box on its own was being satisfied
 *  with "." — chips keep the requirement and make it cheap to be honest. */
const QUICK_REASONS = [
  'Wrong agent',
  'Assigned by mistake',
  'Duplicate order',
  'Agent out of stock',
];

/** Manager bulk unassign from the deliveries list's select mode. Sends the
 *  selected rows back to the Unassigned queue. The server loops the single
 *  unassign_delivery per row (same gates, same audit) and each rider gets ONE
 *  summary push for the batch. Rows that cannot be unassigned — closed, or
 *  already in the queue — are shown up front and excluded from the count. */
export function BulkUnassignSheet({
  open,
  selected,
  onClose,
  onUnassigned,
}: {
  open: boolean;
  selected: DeliveryRow[];
  onClose: () => void;
  onUnassigned: (result: BulkUnassignResult) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientUuid, setClientUuid] = useState<string>(() => newClientUuid());

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setClientUuid(newClientUuid());
    }
  }, [open]);

  // Who loses what, computed from the rows in hand — no round trip. Closed and
  // already-unassigned rows are skipped here so the button's count is exact.
  const { groups, eligibleIds, alreadyQueued, closed } = useMemo(() => {
    const byAgent = new Map<string, { name: string; count: number }>();
    const ids: string[] = [];
    let queued = 0;
    let done = 0;
    for (const d of selected) {
      if (!d.id) continue;
      if (TERMINAL_STATUSES.has(d.current_status ?? '')) {
        done += 1;
        continue;
      }
      if (!d.assigned_agent_id) {
        queued += 1;
        continue;
      }
      ids.push(d.id);
      const g = byAgent.get(d.assigned_agent_id) ?? {
        name: d.assigned_agent_name ?? 'Unknown agent',
        count: 0,
      };
      g.count += 1;
      byAgent.set(d.assigned_agent_id, g);
    }
    const list = [...byAgent.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
    return { groups: list, eligibleIds: ids, alreadyQueued: queued, closed: done };
  }, [selected]);

  const n = eligibleIds.length;
  const skippedNote = [
    alreadyQueued > 0 ? `${alreadyQueued} already in the queue` : null,
    closed > 0 ? `${closed} closed` : null,
  ]
    .filter(Boolean)
    .join(', ');

  async function submit() {
    if (n === 0) return;
    if (!reason.trim()) {
      setError('Pick or type a reason');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await bulkUnassignDeliveries(eligibleIds, reason.trim(), clientUuid);
      onUnassigned(result);
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
        if (!submitting) onClose();
      }}
      title="Send back to the queue"
      subtitle={`${selected.length} selected`}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        {n === 0 ? (
          <Banner tone="info" icon="alert">
            {skippedNote
              ? `Nothing to unassign: ${skippedNote}.`
              : 'Nothing to unassign in this selection.'}
          </Banner>
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 11,
                  color: colors.textSecondary,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                }}
              >
                Coming off
              </Text>
              {groups.map((g) => (
                <View
                  key={g.name}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>
                    {g.name}
                  </Text>
                  <Text
                    style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.textSecondary }}
                  >
                    {g.count} {g.count === 1 ? 'order' : 'orders'}
                  </Text>
                </View>
              ))}
              {skippedNote ? (
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 4,
                  }}
                >
                  Skipping {skippedNote}.
                </Text>
              ) : null}
            </View>

            <Banner tone="info" icon="alert">
              They go back to the Unassigned queue with their status and pricing untouched. Each
              rider gets one notification for the whole batch.
            </Banner>

            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {QUICK_REASONS.map((r) => {
                  const active = reason === r;
                  return (
                    <Pressable
                      key={r}
                      onPress={() => {
                        setReason(active ? '' : r);
                        setError(null);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={({ pressed }) => [
                        {
                          paddingVertical: 8,
                          paddingHorizontal: 14,
                          borderRadius: 999,
                          borderWidth: 1.5,
                          borderColor: active ? colors.black : colors.borderStrong,
                          backgroundColor: active ? colors.black : colors.white,
                        },
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: fonts.semibold,
                          fontSize: 13,
                          color: active ? colors.white : colors.black,
                        }}
                      >
                        {r}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Input
                label="Reason (required)"
                value={reason}
                onChange={(v) => {
                  setReason(v);
                  setError(null);
                }}
                placeholder="Tap a chip or type your own"
                autoCapitalize="sentences"
              />
            </View>

            {error ? (
              <Banner tone="error" icon="alert">
                {error}
              </Banner>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Button variant="secondary" onPress={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onPress={submit}
                disabled={submitting || n === 0}
                style={{ flex: 1 }}
                accessibilityLabel={`Unassign ${n} deliveries`}
              >
                {submitting ? 'Unassigning…' : `Unassign ${n}`}
              </Button>
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}
