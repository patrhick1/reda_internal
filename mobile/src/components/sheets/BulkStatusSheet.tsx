import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Banner, Icon, Input, Sheet, StatusPill } from '@/components/ui';
import { colors, fonts, STATUS_META } from '@/lib/theme';
import {
  bulkChangeStatus,
  listStatusDefs,
  type DeliveryRow,
  type DeliveryStatusDef,
} from '@/services/deliveries';
import { useAsync } from '@/hooks/useAsync';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';

/** Admin/dispatcher bulk status change. The server iterates change_delivery_
 *  status per row and reports succeeded/skipped counts; this sheet stages
 *  the picker + reason and surfaces the count via the parent's toast.
 *
 *  Two statuses are excluded from the picker even though the DB allows them:
 *    - delivered: requires per-row quantity + paid + payment_method that
 *      the bulk wrapper can't supply, so every row would skip.
 *    - rolled_over: system-managed by the rollover machinery; bulk-setting
 *      it would bypass the parent/child mint.
 *  Everything else (cancelled, available, all soft-fails, etc.) is fair game
 *  — the server's per-row state machine enforces requires_admin and the
 *  transition table. */
export function BulkStatusSheet({
  open,
  selected,
  onClose,
  onChanged,
}: {
  open: boolean;
  selected: DeliveryRow[];
  onClose: () => void;
  onChanged: (counts: { changedCount: number; skippedCount: number }) => void;
}) {
  const defsQ = useAsync<DeliveryStatusDef[]>(() => listStatusDefs(), []);
  const [picked, setPicked] = useState<DeliveryStatusDef | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientUuid, setClientUuid] = useState<string>(() => newClientUuid());

  // Fresh idempotency token each time the sheet opens so a stale token from
  // a prior dismissed attempt doesn't make the server short-circuit.
  useEffect(() => {
    if (open) {
      setPicked(null);
      setReason('');
      setError(null);
      setClientUuid(newClientUuid());
    }
  }, [open]);

  const options = useMemo(() => {
    return (defsQ.data ?? []).filter(
      (d) => d.status !== 'delivered' && d.status !== 'rolled_over',
    );
  }, [defsQ.data]);

  const count = selected.length;
  const countLabel = `${count} ${count === 1 ? 'delivery' : 'deliveries'}`;

  async function submit() {
    if (!picked || count === 0) return;
    if (!reason.trim()) {
      setError('Reason is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ids = selected.map((d) => d.id).filter((id): id is string => !!id);
      const counts = await bulkChangeStatus(ids, picked.status, reason.trim(), clientUuid);
      onChanged(counts);
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
      title={picked ? 'Change to' : 'Bulk change status'}
      subtitle={countLabel}
    >
      {defsQ.loading && !defsQ.data ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : defsQ.error ? (
        <View style={{ padding: 20 }}>
          <Banner tone="error" icon="alert">
            {defsQ.error}
          </Banner>
        </View>
      ) : !picked ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 24, paddingTop: 4 }}>
          <Banner tone="info" icon="alert" style={{ marginBottom: 8 }}>
            Rows that can’t reach the picked status (already terminal, missing
            required arg) skip with a count. The list refreshes after.
          </Banner>
          {options.map((def) => {
            const meta = STATUS_META[def.status] ?? { label: def.label, desc: '' };
            return (
              <Pressable
                key={def.status}
                onPress={() => setPicked(def)}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 14,
                    paddingHorizontal: 12,
                    borderRadius: 12,
                  },
                  pressed && { backgroundColor: colors.surface },
                ]}
              >
                <StatusPill status={def.status} />
                <Text
                  style={{
                    flex: 1,
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.textSecondary,
                  }}
                >
                  {meta.desc}
                </Text>
                <Icon name="chevronRight" size={18} color={colors.textSecondary} />
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              {`${countLabel} →`}
            </Text>
            <StatusPill status={picked.status} />
          </View>

          <Input
            label="Reason (required)"
            value={reason}
            onChange={setReason}
            placeholder="Applies to every row that successfully changes"
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
                // Fresh idempotency token: a partially-applied prior submit
                // would otherwise short-circuit on the server's per-row
                // client_uuid check, silently no-op'ing rows the user
                // expects to land on the newly-picked status.
                setPicked(null);
                setError(null);
                setClientUuid(newClientUuid());
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
                Back
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
                  backgroundColor: colors.black,
                  alignItems: 'center',
                  opacity: submitting ? 0.6 : 1,
                },
                pressed && !submitting && { opacity: 0.92 },
              ]}
            >
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
                {submitting ? 'Updating…' : `Update ${count}`}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </Sheet>
  );
}
