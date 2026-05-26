import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Banner, Icon, Input, Sheet, StatusPill } from '@/components/ui';
import { colors, fonts, STATUS_META } from '@/lib/theme';
import {
  listStatusDefs, listTransitionsFrom,
  type DeliveryRow, type DeliveryStatusTransition,
} from '@/services/deliveries';
import { useAsync } from '@/hooks/useAsync';
import { useEnqueueChangeStatus } from '@/queue/mutations';
import { errorMessage } from '@/lib/errors';

/** Bottom-sheet status updater for non-`delivered` transitions.
 *  For 'delivered', use MarkDeliveredSheet (it takes qty + paid + method). */
export function UpdateStatusSheet({
  open, delivery, isAdmin, onClose, onCommitted,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  isAdmin: boolean;
  onClose: () => void;
  /** Called once the mutation has been enqueued. `jobId` is the queue job
   *  the parent should watch so the optimistic veil clears once the job
   *  succeeds (removed) or dead-letters (failed permanently). */
  onCommitted: (newStatus: string, jobId: string) => void;
}) {
  const currentStatus = delivery?.current_status ?? 'pending';
  const transitionsQ = useAsync(
    () => (open && delivery ? listTransitionsFrom(currentStatus, isAdmin) : Promise.resolve([])),
    [open, currentStatus, isAdmin],
  );
  const defsQ = useAsync(() => listStatusDefs(), []);

  const [picked, setPicked] = useState<DeliveryStatusTransition | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueStatus = useEnqueueChangeStatus();

  // Filter out 'delivered' — that has its own sheet.
  const options = useMemo(() => {
    return (transitionsQ.data ?? []).filter(t => t.to_status !== 'delivered');
  }, [transitionsQ.data]);

  function reset() {
    setPicked(null);
    setReason('');
    setError(null);
  }

  async function submit() {
    if (!delivery || !picked) return;
    if (picked.requires_reason && !reason.trim()) {
      setError('A reason is required for this transition');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const jobId = await enqueueStatus({
        deliveryId: delivery.id ?? '',
        toStatus: picked.to_status,
        reason: reason.trim() || null,
        notes: null,
        quantityDelivered: null,
        paid: null,
        paymentMethod: null,
      }, `Status → ${picked.to_status} · ${delivery.customer_name ?? ''}`);
      const newStatus = picked.to_status;
      reset();
      onCommitted(newStatus, jobId);
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
      onClose={() => { if (!submitting) { reset(); onClose(); } }}
      title="Update status"
      subtitle={delivery.customer_name ?? undefined}
    >
      {transitionsQ.loading || defsQ.loading ? (
        <View style={{ padding: 60, alignItems: 'center' }}><ActivityIndicator color={colors.black} /></View>
      ) : transitionsQ.error || defsQ.error ? (
        <View style={{ padding: 20 }}>
          <Banner tone="error" icon="alert">{transitionsQ.error ?? defsQ.error}</Banner>
        </View>
      ) : options.length === 0 ? (
        <View style={{ padding: 20 }}>
          <Banner tone="info" icon="alert">
            {`No status changes available from ${STATUS_META[currentStatus]?.label ?? currentStatus}.${isAdmin ? '' : ' Backward transitions require admin.'}`}
          </Banner>
        </View>
      ) : !picked ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 24, paddingTop: 4 }}>
          {options.map(t => {
            const meta = STATUS_META[t.to_status] ?? { label: t.to_status, desc: '' };
            return (
              <Pressable
                key={t.to_status}
                onPress={() => setPicked(t)}
                style={({ pressed }) => ([{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 14,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                }, pressed && { backgroundColor: colors.surface }])}
              >
                <StatusPill status={t.to_status} />
                <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
                  {meta.desc}{t.requires_reason ? ' · reason required' : ''}{t.requires_admin ? ' · admin only' : ''}
                </Text>
                <Icon name="chevronRight" size={18} color={colors.textSecondary} />
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>Change to</Text>
            <StatusPill status={picked.to_status} />
          </View>
          <Input
            label={picked.requires_reason ? 'Reason (required)' : 'Reason (optional)'}
            value={reason}
            onChange={setReason}
            placeholder={picked.requires_reason ? 'e.g. customer rescheduled' : ''}
            autoCapitalize="sentences"
          />
          {error ? <Banner tone="error" icon="alert">{error}</Banner> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Pressable onPress={() => setPicked(null)} disabled={submitting}
              style={({ pressed }) => ([{
                paddingVertical: 14, paddingHorizontal: 20, borderRadius: 999,
                borderWidth: 1.5, borderColor: colors.black,
                backgroundColor: colors.white,
              }, pressed && { opacity: 0.85 }])}
            >
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>Back</Text>
            </Pressable>
            <Pressable onPress={submit} disabled={submitting}
              style={({ pressed }) => ([{
                flex: 1,
                paddingVertical: 14, paddingHorizontal: 20, borderRadius: 999,
                backgroundColor: colors.black,
                alignItems: 'center',
                opacity: submitting ? 0.6 : 1,
              }, pressed && !submitting && { opacity: 0.92 }])}
            >
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
                {submitting ? 'Saving…' : 'Update'}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </Sheet>
  );
}
