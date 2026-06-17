import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Banner, CalendarPicker, Icon, Input, Sheet, StatusPill } from '@/components/ui';
import {
  colors,
  fonts,
  FINAL_STATUSES,
  STATUS_HIDDEN_FROM_PICKER,
  STATUS_META,
  TERMINAL_STATUSES,
} from '@/lib/theme';
import {
  listStatusDefs,
  listTransitionsFrom,
  type DeliveryRow,
  type DeliveryStatusTransition,
} from '@/services/deliveries';
import { useAsync } from '@/hooks/useAsync';
import { useEnqueueChangeStatus, useEnqueueFlagDelivery } from '@/queue/mutations';
import { STATUS_AUTO_ISSUE } from '@/services/delivery-messages';
import { errorMessage } from '@/lib/errors';

/** Bottom-sheet status updater for non-`delivered` transitions.
 *  For 'delivered', use MarkDeliveredSheet (it takes qty + paid + method). */
export function UpdateStatusSheet({
  open,
  delivery,
  isAdmin,
  autoSeedThreadOnIntervention = false,
  onClose,
  onCommitted,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  isAdmin: boolean;
  /** When true, picking a status in `STATUS_AUTO_ISSUE` routes the submit
   *  through `flag_delivery_issue` instead of `change_delivery_status` so a
   *  thread gets seeded automatically. Only the agent's delivery detail
   *  screen opts in — ops users keep the plain status-change semantics. */
  autoSeedThreadOnIntervention?: boolean;
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
  const [postponeDate, setPostponeDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enqueueStatus = useEnqueueChangeStatus();
  const enqueueFlag = useEnqueueFlagDelivery();

  // Filter out 'delivered' (has its own sheet) and any status in
  // STATUS_HIDDEN_FROM_PICKER (system-managed or non-pickable workflows).
  const options = useMemo(() => {
    return (transitionsQ.data ?? []).filter(
      (t) => t.to_status !== 'delivered' && !STATUS_HIDDEN_FROM_PICKER.has(t.to_status),
    );
  }, [transitionsQ.data]);

  function reset() {
    setPicked(null);
    setReason('');
    setPostponeDate('');
    setError(null);
  }

  const isPostponed = picked?.to_status === 'postponed';
  const autoIssue =
    picked && autoSeedThreadOnIntervention ? (STATUS_AUTO_ISSUE[picked.to_status] ?? null) : null;
  const willSeedThread = autoIssue !== null;
  const isTerminalPick = picked ? TERMINAL_STATUSES.has(picked.to_status) : false;
  const isFinalPick = picked ? FINAL_STATUSES.has(picked.to_status) : false;
  const isFinalCurrent = FINAL_STATUSES.has(currentStatus);

  async function submit() {
    if (!delivery || !picked) return;
    if (picked.requires_reason && !reason.trim()) {
      setError('A reason is required for this transition');
      return;
    }

    // Postponed requires a future scheduled_date (server validates too).
    let newScheduledDate: string | null = null;
    if (isPostponed) {
      const trimmed = postponeDate.trim();
      if (!trimmed) {
        setError('Pick a date to postpone to');
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        setError('Date format must be YYYY-MM-DD');
        return;
      }
      const todayLagos = lagosTodayYmd();
      if (trimmed <= todayLagos) {
        setError('Postpone date must be after today');
        return;
      }
      newScheduledDate = trimmed;
    }

    setSubmitting(true);
    setError(null);
    try {
      const label = `Status → ${picked.to_status} · ${delivery.customer_name ?? ''}`;
      // Intervention-class statuses (only when the caller opts in — agent-side)
      // route through `flag_delivery_issue` so ops get a thread automatically.
      // Everything else goes through the plain status RPC unchanged.
      const jobId = autoIssue
        ? await enqueueFlag(
            {
              deliveryId: delivery.id ?? '',
              issueType: autoIssue,
              note: reason.trim() || null,
              newStatus: picked.to_status,
            },
            label,
          )
        : await enqueueStatus(
            {
              deliveryId: delivery.id ?? '',
              toStatus: picked.to_status,
              reason: reason.trim() || null,
              notes: null,
              quantityDelivered: null,
              paid: null,
              paymentMethod: null,
              newScheduledDate,
            },
            label,
          );
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
      onClose={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
      title="Update status"
      subtitle={delivery.customer_name ?? undefined}
    >
      {transitionsQ.loading || defsQ.loading ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : transitionsQ.error || defsQ.error ? (
        <View style={{ padding: 20 }}>
          <Banner tone="error" icon="alert">
            {transitionsQ.error ?? defsQ.error}
          </Banner>
        </View>
      ) : options.length === 0 ? (
        <View style={{ padding: 20 }}>
          <Banner tone="info" icon="alert">
            {isFinalCurrent
              ? currentStatus === 'delivered'
                ? 'Delivered is final and can’t be changed from the app. Contact admin if there’s an issue.'
                : 'This delivery already rolled over to the next day. Contact admin if you need to change it.'
              : `No status changes available from ${STATUS_META[currentStatus]?.label ?? currentStatus}.${isAdmin ? '' : ' Contact admin if you need to change this.'}`}
          </Banner>
        </View>
      ) : !picked ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 24, paddingTop: 4 }}>
          {options.map((t) => {
            const meta = STATUS_META[t.to_status] ?? { label: t.to_status, desc: '' };
            return (
              <Pressable
                key={t.to_status}
                onPress={() => setPicked(t)}
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
                <StatusPill status={t.to_status} />
                <Text
                  style={{
                    flex: 1,
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.textSecondary,
                  }}
                >
                  {meta.desc}
                  {t.requires_reason ? ' · reason required' : ''}
                  {t.requires_admin ? ' · admin only' : ''}
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
              Change to
            </Text>
            <StatusPill status={picked.to_status} />
          </View>
          {willSeedThread ? (
            <Banner tone="info" icon="alert">
              This will also message ops so they can help.
            </Banner>
          ) : null}
          {isTerminalPick ? (
            <Banner tone="warn" icon="alert">
              {STATUS_META[picked.to_status]?.warning ??
                (isFinalPick
                  ? 'Final — you won’t be able to change this from the app.'
                  : 'Closes the delivery. You’ll need to give a reason if you reopen it.')}
            </Banner>
          ) : null}
          {isPostponed ? (
            <View style={{ gap: 10 }}>
              <Text
                style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary }}
              >
                Postpone to (required)
              </Text>
              {/* Quick picks for the common cases — one tap, no scrolling. */}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {[1, 2, 3, 7].map((n) => {
                  const ymd = nextWorkdayYmd(addDaysYmd(lagosTodayYmd(), n));
                  const active = postponeDate === ymd;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => setPostponeDate(ymd)}
                      style={({ pressed }) => [
                        {
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: active ? colors.black : colors.border,
                          backgroundColor: active ? colors.black : colors.white,
                        },
                        pressed && !active && { backgroundColor: colors.surface },
                      ]}
                    >
                      <Text
                        style={{
                          fontFamily: fonts.semibold,
                          fontSize: 12,
                          color: active ? colors.white : colors.black,
                        }}
                      >
                        +{n}
                        {n === 1 ? ' day' : ' days'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {/* Tap-to-pick calendar for any other date. */}
              <CalendarPicker
                value={postponeDate || null}
                onSelect={setPostponeDate}
                minExclusiveYmd={lagosTodayYmd()}
              />
              <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}>
                {postponeDate
                  ? `Postponing to ${prettyYmd(postponeDate)}.`
                  : 'Pick a date above. Sundays are closed.'}
              </Text>
            </View>
          ) : null}
          <Input
            label={
              willSeedThread
                ? picked.requires_reason
                  ? 'Note to ops (required)'
                  : 'Note to ops (optional)'
                : picked.requires_reason
                  ? 'Reason (required)'
                  : 'Reason (optional)'
            }
            value={reason}
            onChange={setReason}
            placeholder={
              willSeedThread
                ? 'Anything ops should know to help'
                : picked.requires_reason
                  ? 'e.g. customer rescheduled'
                  : ''
            }
            autoCapitalize="sentences"
            multiline
            numberOfLines={4}
          />
          {error ? (
            <Banner tone="error" icon="alert">
              {error}
            </Banner>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Pressable
              onPress={() => setPicked(null)}
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
                {submitting ? 'Saving…' : 'Update'}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
    </Sheet>
  );
}

/** YYYY-MM-DD for "today" in Africa/Lagos. Lagos is UTC+01:00 year-round. */
function lagosTodayYmd(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toISOString().slice(0, 10);
}

/** YYYY-MM-DD `n` calendar days after the given YYYY-MM-DD. Caller picks the
 *  base; we just arithmetic on UTC midnight to dodge DST/TZ wobble. */
function addDaysYmd(baseYmd: string, days: number): string {
  const parts = baseYmd.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** If the given YYYY-MM-DD lands on a Sunday, bump it to Monday — mirrors the
 *  backend's _ensure_workday so the chips never set a closed day. */
function nextWorkdayYmd(ymd: string): string {
  const parts = ymd.split('-');
  const utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return utc.getUTCDay() === 0 ? addDaysYmd(ymd, 1) : ymd;
}

/** Friendly one-line rendering of a YYYY-MM-DD, e.g. "Tue, 30 Jun 2026". */
function prettyYmd(ymd: string): string {
  const parts = ymd.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(Date.UTC(y, m - 1, d));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${days[date.getUTCDay()]}, ${d} ${months[m - 1]} ${y}`;
}
