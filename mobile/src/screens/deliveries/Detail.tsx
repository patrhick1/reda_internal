import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { supabase } from '@/lib/supabase';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  getDelivery,
  listDeliveryHistory,
  listStatusDefs,
  type DeliveryStatusHistoryRow,
} from '@/services/deliveries';
import { initiateCall } from '@/services/calls';
import { ensureMicPermission } from '@/lib/calls/permissions';
import { canPlaceCall } from '@/lib/calls/availability';
import { AppBar, Avatar, Button, Card, Empty, Hint, Icon, StatusPill } from '@/components/ui';
import { colors, fonts, TERMINAL_STATUSES } from '@/lib/theme';
import {
  canClaimFollowup,
  canEditDelivery,
  canHandoffToSubAgent,
  canMarkClientNotified,
  canPostOnThread,
  canSeedThread,
  canSeeCharged,
  canSeeMargin,
  canUpdateStatus,
} from '@/lib/permissions';
import {
  listClientNotificationsForDelivery,
  markClientNotified,
  type ClientNotificationRow,
} from '@/services/clientNotifications';
import { FollowupClaimBanner } from '@/components/delivery/FollowupClaimBanner';
import { HINTS } from '@/hints/registry';
import { formatDateTime, formatNaira } from '@/lib/format';
import { MarkDeliveredSheet } from '@/components/sheets/MarkDeliveredSheet';
import { UpdateStatusSheet } from '@/components/sheets/UpdateStatusSheet';
import { HandoffToSubAgentSheet } from '@/components/sheets/HandoffToSubAgentSheet';
import { MessageThread } from '@/components/delivery/MessageThread';
import { listSubAgents } from '@/services/users';
import { useQueue } from '@/queue/QueueProvider';

export function DeliveryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useCurrentUser();
  const insets = useSafeAreaInsets();

  const deliveryQ = useAsync(() => getDelivery(user.role, id), [user.role, id]);
  const historyQ = useAsync(() => listDeliveryHistory(id), [id]);
  const defsQ = useAsync(() => listStatusDefs(), []);
  const notifQ = useAsync(() => listClientNotificationsForDelivery(id), [id]);
  const canMarkNotified = canMarkClientNotified(user.role);

  const [markOpen, setMarkOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  // Optimistic status + (when queued) the job ID to watch. The veil clears
  // when EITHER the server-confirmed status matches (direct-RPC paths) OR
  // the tracked queue job ends — succeeded (removed) or dead-lettered.
  // Without this the veil could stay set forever on a permanently-failing
  // mutation, leaving the screen showing a fake status with no way out
  // except force-closing the app.
  const [optimistic, setOptimistic] = useState<{ status: string; jobId: string | null } | null>(
    null,
  );
  const optimisticStatus = optimistic?.status ?? null;
  const { snapshot: queueSnapshot } = useQueue();

  // Team-lead handoff: load this agent's sub-agents once on mount so we know
  // whether to render the "Hand off to team" button. Cached for screen lifetime.
  const subAgentsQ = useAsync(
    () => (user.role === 'agent' ? listSubAgents(user.userId) : Promise.resolve([])),
    [user.role, user.userId],
  );
  const hasSubAgents = (subAgentsQ.data ?? []).length > 0;

  useFocusEffect(
    useCallback(() => {
      deliveryQ.reload();
      historyQ.reload();
      notifQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Realtime: when a teammate marks a status-history row as "client
  // notified", every other rep watching the screen sees the green tick
  // appear without refocusing. Filtered server-side to this delivery_id
  // so the channel only fires on changes that matter. Pairs with the
  // supabase_realtime publication entry added in
  // scripts/client-notified-tag.sql.
  useEffect(() => {
    const channel = supabase
      .channel(`delivery-client-notifications:${id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'delivery_client_notifications',
          filter: `delivery_id=eq.${id}`,
        },
        () => {
          notifQ.reload();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onMarkNotified = useCallback(async (historyId: string) => {
    try {
      await markClientNotified(historyId);
    } catch (err) {
      Alert.alert('Could not mark notified', err instanceof Error ? err.message : String(err));
    } finally {
      notifQ.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop the optimistic veil when either the server has caught up OR the
  // tracked queue job has ended. Two paths converge here:
  //   1. Direct-RPC mutations (FlagDeliverySheet) await synchronously, so
  //      the next reload returns the new status — match clears the veil.
  //   2. Queued mutations may take time or fail. Job removed = succeeded;
  //      job present with status='dead_letter' = permanently failed. Either
  //      way the veil should drop so the user sees real state.
  useEffect(() => {
    if (!optimistic) return;
    const serverStatus = deliveryQ.data?.current_status;
    if (serverStatus && serverStatus === optimistic.status) {
      setOptimistic(null);
      return;
    }
    if (optimistic.jobId) {
      const job = queueSnapshot.jobs.find((j) => j.id === optimistic.jobId);
      if (!job || job.status === 'dead_letter') {
        setOptimistic(null);
        deliveryQ.reload();
        historyQ.reload();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveryQ.data?.current_status, queueSnapshot.jobs, optimistic]);

  const labelByStatus = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of defsQ.data ?? []) m.set(d.status, d.label);
    return m;
  }, [defsQ.data]);

  // In-app call to a specific teammate, linked to this delivery for audit.
  // MUST sit above the loading/error early returns — Rules of Hooks require
  // every hook to be called in the same order every render. Reading
  // `deliveryQ.data?.id` instead of capturing the post-guard `d.id` so the
  // dep array works whether or not the data has loaded yet.
  const deliveryId = deliveryQ.data?.id;
  const callTeammate = useCallback(
    async (calleeId: string) => {
      if (callBusy) return;
      setCallBusy(true);
      try {
        const micOk = await ensureMicPermission();
        if (!micOk) {
          Alert.alert(
            'Microphone needed',
            'Reda needs microphone access to make calls. Tap "Open settings" → Permissions → Microphone → Allow.',
            [
              { text: 'Not now', style: 'cancel' },
              {
                text: 'Open settings',
                onPress: () => {
                  Linking.openSettings().catch(() => {
                    /* noop */
                  });
                },
              },
            ],
          );
          return;
        }
        const call = await initiateCall({ calleeId, relatedDeliveryId: deliveryId });
        router.push(`/call/${call.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ringing call')) {
          Alert.alert('Already on a call', 'You or that person already has a call ringing.');
        } else {
          Alert.alert('Could not start call', msg);
        }
      } finally {
        setCallBusy(false);
      }
    },
    [callBusy, deliveryId, router],
  );

  if (deliveryQ.loading && !deliveryQ.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Delivery" onBack={() => router.back()} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </View>
    );
  }
  if (deliveryQ.error || !deliveryQ.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Delivery" onBack={() => router.back()} />
        <Empty icon="alert" title="Not found" sub={deliveryQ.error ?? 'Delivery not available.'} />
      </View>
    );
  }

  const d = deliveryQ.data;
  const status = optimisticStatus ?? d.current_status ?? 'pending';
  const isTerminal = TERMINAL_STATUSES.has(status);
  const isDelivered = status === 'delivered';
  // customer_price is per-delivery, not per-unit. Do NOT multiply by quantity.
  const expectedTotal = Number(d.customer_price ?? 0);
  const showCharged = canSeeCharged(user.role);
  const showMargin = canSeeMargin(user.role);
  const showAgentPayment =
    user.role === 'admin' || (user.role === 'agent' && d.assigned_agent_id === user.userId);

  const charged = 'charged_snapshot' in d ? (d.charged_snapshot ?? null) : null;
  const canEdit = canUpdateStatus(user.role, d.assigned_agent_id === user.userId);

  const onCommitted = (newStatus: string, jobId: string) => {
    setOptimistic({ status: newStatus, jobId });
    setMarkOpen(false);
    setUpdateOpen(false);
    deliveryQ.reload();
    historyQ.reload();
  };

  const onHandoffCommitted = () => {
    // Handoff doesn't change status — just the assignee. Refresh the row so
    // the new assignee shows up. The delivery will disappear from this lead's
    // "My deliveries" list on the next fetch (RLS keeps it visible to her
    // because she's still in the audit history, but it no longer counts as hers).
    setHandoffOpen(false);
    deliveryQ.reload();
  };

  const canHandoff = canHandoffToSubAgent(user, d.assigned_agent_id, hasSubAgents) && !isTerminal;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title={d.customer_name ?? 'Delivery'}
        subtitle={
          d.created_at
            ? `Created ${formatDateTime(d.created_at)} · via ${d.created_via ?? 'manual'}`
            : undefined
        }
        // Always land on the deliveries list, regardless of entry point —
        // router.back() would pop to Home when the user arrived via the
        // Home "Recent activity" or "Open issues" cards.
        onBack={() => {
          const base =
            user.role === 'dispatcher'
              ? '/(dispatcher)/deliveries'
              : user.role === 'rep'
                ? '/(rep)/deliveries'
                : '/(admin)/deliveries';
          router.replace(base as `/${string}`);
        }}
        right={
          canEditDelivery(user.role, status) ? (
            <TouchableOpacity
              onPress={() => {
                const base =
                  user.role === 'dispatcher'
                    ? '/(dispatcher)/deliveries'
                    : user.role === 'rep'
                      ? '/(rep)/deliveries'
                      : '/(admin)/deliveries';
                router.push(`${base}/${d.id}/edit` as `/${string}`);
              }}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityLabel="Edit delivery"
              accessibilityRole="button"
            >
              <Icon name="edit" size={22} color={colors.black} />
            </TouchableOpacity>
          ) : undefined
        }
      />

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: (canEdit && !isTerminal ? 130 : 32) + insets.bottom,
          gap: 12,
        }}
      >
        {/* Hero */}
        <Card>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={kicker}>Customer</Text>
              <Text
                style={{
                  fontFamily: fonts.extrabold,
                  fontSize: 22,
                  color: colors.black,
                  letterSpacing: -0.4,
                  marginTop: 2,
                }}
              >
                {d.customer_name}
              </Text>
              {d.customer_phone ? (
                <Text
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 6,
                  }}
                >
                  {d.customer_phone}
                </Text>
              ) : null}
            </View>
            <StatusPill status={status} />
          </View>
          <View style={{ marginTop: 14, flexDirection: 'row', gap: 8 }}>
            <Button
              variant="primary"
              size="sm"
              icon="phone"
              onPress={() =>
                d.customer_phone && Linking.openURL(`tel:${d.customer_phone.replace(/\s+/g, '')}`)
              }
              disabled={!d.customer_phone}
            >
              Call
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon="mapPin"
              onPress={() => openMaps(d.raw_address)}
              disabled={!d.raw_address}
            >
              Map
            </Button>
          </View>
        </Card>

        {/* One-time hint: teaches the "I'll handle this" claim button.
            Per-screen cap: this hint suppresses the EDIT_DELIVERY_ICON hint
            below so we never stack two on the same screen. */}
        {canClaimFollowup(user.role, status) ? (
          <Hint id={HINTS.FOLLOWUP_CLAIM} title="Tip — Calling the customer?">
            Tap <Text style={{ fontFamily: fonts.bold }}>I&apos;ll handle this</Text> on the banner
            below so other dispatchers know you&apos;re on it. The claim drops automatically the
            moment the status changes.
          </Hint>
        ) : null}

        {/* Follow-up claim — soft statuses only, admin + dispatcher only. */}
        {canClaimFollowup(user.role, status) && d.id ? (
          <FollowupClaimBanner deliveryId={d.id} currentUserId={user.userId} />
        ) : null}

        {/* One-time hint: teaches the Edit-delivery pencil icon. Suppressed
            when the follow-up hint is in play (per-screen cap). */}
        {canEditDelivery(user.role, status) && !canClaimFollowup(user.role, status) ? (
          <Hint id={HINTS.EDIT_DELIVERY_ICON} title="Tip — Spotted a typo?">
            Tap the pencil icon in the top-right to fix the customer name, phone, or address before
            delivery. Only works while the delivery is still open.
          </Hint>
        ) : null}

        {/* Address */}
        <Card>
          <Text style={kicker}>Address</Text>
          <Text
            style={{
              fontFamily: fonts.semibold,
              fontSize: 15,
              color: colors.black,
              lineHeight: 22,
              marginTop: 6,
            }}
          >
            {d.raw_address}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
            <Icon name="mapPin" size={13} color={colors.textSecondary} />
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              {d.location_name ?? 'Unmatched location'}
            </Text>
          </View>
        </Card>

        {/* Product + Money */}
        <Card>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={kicker}>Product</Text>
              <Text
                style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black, marginTop: 4 }}
              >
                {d.product_name}
              </Text>
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 13,
                  color: colors.textSecondary,
                  marginTop: 2,
                }}
              >
                Quantity: {d.quantity_ordered}
                {d.quantity_delivered != null ? ` · delivered ${d.quantity_delivered}` : ''}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={kicker}>To collect</Text>
              <Text
                style={{
                  fontFamily: fonts.extrabold,
                  fontSize: 22,
                  color: colors.black,
                  letterSpacing: -0.4,
                  marginTop: 2,
                }}
              >
                {formatNaira(expectedTotal)}
              </Text>
            </View>
          </View>
          {isDelivered ? (
            <View
              style={{
                marginTop: 12,
                padding: 10,
                backgroundColor: colors.successSoft,
                borderRadius: 10,
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.successDark }}
                >
                  Delivered ·{' '}
                  {d.payment_method === 'cash'
                    ? 'Cash'
                    : d.payment_method === 'transfer'
                      ? 'Transfer'
                      : 'Paid'}
                </Text>
                <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.successDark }}>
                  {formatNaira(d.paid)}
                </Text>
              </View>
            </View>
          ) : null}
          <View style={{ marginTop: 12, gap: 4 }}>
            {showCharged ? (
              <MoneyRow
                label="Reda charge"
                value={formatNaira(charged != null ? Number(charged) : null)}
              />
            ) : null}
            {showAgentPayment ? (
              <MoneyRow
                label="Agent earns"
                value={formatNaira(
                  d.agent_payment_snapshot != null ? Number(d.agent_payment_snapshot) : null,
                )}
              />
            ) : null}
            {showMargin && d.margin != null ? (
              <MoneyRow label="Margin" value={formatNaira(Number(d.margin))} accent />
            ) : null}
          </View>
        </Card>

        {/* Vendor + Assignment */}
        <Card>
          <Text style={kicker}>Vendor</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.black, marginTop: 4 }}>
            {d.client_name ?? '—'}
          </Text>
          <View style={{ marginTop: 12, gap: 4 }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
                Assigned agent
              </Text>
              {d.assigned_agent_name ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Avatar user={{ display_name: d.assigned_agent_name }} size={22} />
                  <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                    {d.assigned_agent_name}
                  </Text>
                  {/* Quick-call the assigned agent. Hidden when the agent IS
                      the one viewing (calling yourself is pointless and the
                      DB-side RPC would reject anyway) and on web (no Agora
                      bridge — see canPlaceCall). */}
                  {d.assigned_agent_id && d.assigned_agent_id !== user.userId && canPlaceCall() ? (
                    <TouchableOpacity
                      onPress={() => callTeammate(d.assigned_agent_id as string)}
                      disabled={callBusy}
                      hitSlop={8}
                      style={{
                        marginLeft: 4,
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        backgroundColor: colors.success,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: callBusy ? 0.5 : 1,
                      }}
                      accessibilityLabel={`Call ${d.assigned_agent_name}`}
                      accessibilityRole="button"
                    >
                      {callBusy ? (
                        <ActivityIndicator color={colors.white} size="small" />
                      ) : (
                        <Icon name="phone" size={14} color={colors.white} />
                      )}
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: 11,
                    color: colors.red,
                    letterSpacing: 0.6,
                    textTransform: 'uppercase',
                  }}
                >
                  Unassigned
                </Text>
              )}
            </View>
            <MoneyRow label="Scheduled date" value={d.scheduled_date ?? '—'} />
            <MoneyRow label="Created" value={formatDateTime(d.created_at)} />
          </View>
          {/* Quick entry to call a teammate about THIS delivery. Opens the
              Team directory with related_delivery_id so the call gets linked
              for audit. Agents typically use this to ring admin/dispatch;
              admins/dispatchers can also use it to call someone other than
              the assigned agent. Hidden on web (no Agora bridge). */}
          {canPlaceCall() ? (
            <TouchableOpacity
              onPress={() => router.push(`/(call)/team?related_delivery_id=${d.id}`)}
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
              accessibilityLabel="Call a teammate about this delivery"
              accessibilityRole="button"
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="phone" size={16} color={colors.success} />
                <Text
                  style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textPrimary }}
                >
                  {user.role === 'agent' ? 'Call admin / dispatch' : 'Call a teammate'}
                </Text>
              </View>
              <Icon name="chevronRight" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </Card>

        {/* Messages — renders when there are messages OR when an ops viewer
            can seed an empty thread. */}
        {d.id ? (
          <MessageThread
            deliveryId={d.id}
            deliveryStatus={status}
            canPost={canPostOnThread(user.role, d.assigned_agent_id === user.userId)}
            canSeed={canSeedThread(user.role)}
          />
        ) : null}

        {/* History */}
        <Card>
          <Text style={[kicker, { marginBottom: 12 }]}>History</Text>
          {historyQ.loading && !historyQ.data ? (
            <ActivityIndicator color={colors.black} />
          ) : (historyQ.data ?? []).length === 0 ? (
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              No history yet.
            </Text>
          ) : (
            <View>
              {[...historyQ.data!].reverse().map((h, i, arr) => (
                <HistoryRow
                  key={h.id}
                  row={h}
                  first={i === 0}
                  last={i === arr.length - 1}
                  labelByStatus={labelByStatus}
                  notification={notifQ.data?.get(h.id) ?? null}
                  canMark={canMarkNotified}
                  onMark={onMarkNotified}
                />
              ))}
            </View>
          )}
        </Card>
      </ScrollView>

      {canEdit && !isTerminal ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 16 + insets.bottom,
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            flexDirection: 'row',
            gap: 8,
          }}
        >
          {canHandoff ? (
            <Button variant="secondary" icon="user" onPress={() => setHandoffOpen(true)}>
              Hand off
            </Button>
          ) : null}
          <Button variant="secondary" onPress={() => setUpdateOpen(true)}>
            Update status
          </Button>
          <Button variant="emphasis" full icon="check" onPress={() => setMarkOpen(true)}>
            Mark delivered
          </Button>
        </View>
      ) : null}

      <MarkDeliveredSheet
        open={markOpen}
        delivery={d}
        onClose={() => setMarkOpen(false)}
        onConfirmed={onCommitted}
      />
      <UpdateStatusSheet
        open={updateOpen}
        delivery={d}
        isAdmin={user.role === 'admin'}
        onClose={() => setUpdateOpen(false)}
        onCommitted={onCommitted}
      />
      <HandoffToSubAgentSheet
        open={handoffOpen}
        delivery={d}
        leadId={user.userId}
        onClose={() => setHandoffOpen(false)}
        onCommitted={onHandoffCommitted}
      />
    </View>
  );
}

function MoneyRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 13,
          color: accent ? colors.success : colors.black,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

/** One-tap copy for the reason+notes pair on a history row. Reps WhatsApp
 *  the client after every status change; copying saves them retyping the
 *  agent's note. Inline "Copied ✓" state lives for 1.5s, then reverts. */
function CopyNotePill({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onPress = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard failed silently — rare; selectable text is still available */
    }
  }, [text]);
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 6,
        alignSelf: 'flex-start',
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: copied ? colors.success : colors.borderStrong,
      }}
    >
      {copied ? <Icon name="check" size={12} color={colors.success} /> : null}
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 11,
          color: copied ? colors.success : colors.textSecondary,
        }}
      >
        {copied ? 'Copied' : 'Copy note'}
      </Text>
    </TouchableOpacity>
  );
}

function HistoryRow({
  row,
  first,
  last,
  labelByStatus,
  notification,
  canMark,
  onMark,
}: {
  row: DeliveryStatusHistoryRow;
  first: boolean;
  last: boolean;
  labelByStatus: Map<string, string>;
  notification: ClientNotificationRow | null;
  canMark: boolean;
  onMark: (historyId: string) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ alignItems: 'center', paddingTop: 4 }}>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: first ? colors.black : colors.borderStrong,
          }}
        />
        {!last ? (
          <View style={{ width: 2, flex: 1, backgroundColor: colors.border, marginTop: 2 }} />
        ) : null}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <StatusPill status={row.to_status} variant="subtle" size="sm" />
          <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textSecondary }}>
            {formatDateTime(row.effective_at)}
          </Text>
        </View>
        {row.changed_by_name ? (
          <Text
            style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.black, marginTop: 4 }}
          >
            {row.changed_by_name}
          </Text>
        ) : null}
        {row.reason ? (
          <Text
            selectable
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {row.reason}
          </Text>
        ) : null}
        {row.notes ? (
          <Text
            selectable
            style={{
              fontFamily: fonts.regular,
              fontSize: 13,
              color: colors.textSecondary,
              marginTop: 2,
              fontStyle: 'italic',
            }}
          >
            {row.notes}
          </Text>
        ) : null}
        {/* Reps usually retype this into WhatsApp when updating the client.
            One-tap copy of reason + notes saves the retype. */}
        {row.reason || row.notes ? (
          <CopyNotePill text={[row.reason, row.notes].filter(Boolean).join('\n')} />
        ) : null}
        {/* show transition labels for terminal context */}
        {row.from_status ? (
          <Text
            style={{
              fontFamily: fonts.regular,
              fontSize: 11,
              color: colors.textTertiary,
              marginTop: 2,
            }}
          >
            from {labelByStatus.get(row.from_status) ?? row.from_status}
          </Text>
        ) : null}
        {/* Client-notified tag. Reps see the button until someone taps it;
            once tagged everyone sees who and when. */}
        {notification ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <Icon name="check" size={14} color={colors.success} />
            <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.success }}>
              Client notified · {notification.holderName} ·{' '}
              {formatDateTime(notification.notifiedAt)}
            </Text>
          </View>
        ) : canMark ? (
          <TouchableOpacity
            onPress={() => onMark(row.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              marginTop: 6,
              alignSelf: 'flex-start',
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: colors.borderStrong,
            }}
          >
            <Icon name="check" size={14} color={colors.textSecondary} />
            <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
              Mark client notified
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};

function openMaps(addr: string | null | undefined) {
  if (!addr) return;
  const q = encodeURIComponent(addr);
  const url =
    Platform.OS === 'android'
      ? `geo:0,0?q=${q}`
      : Platform.OS === 'ios'
        ? `maps:?q=${q}`
        : `https://maps.google.com/?q=${q}`;
  Linking.openURL(url).catch(() => undefined);
}
