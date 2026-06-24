import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  getDelivery,
  listDeliveryHistoryChain,
  listStatusDefs,
  rolledFromLabel,
  type DeliveryChainHistoryRow,
} from '@/services/deliveries';
import { initiateCall, initiateTeamCall } from '@/services/calls';
import { ensureMicPermission } from '@/lib/calls/permissions';
import { canPlaceCall } from '@/lib/calls/availability';
import { AppBar, Avatar, Button, Card, Empty, Hint, Icon, StatusPill } from '@/components/ui';
import { colors, fonts, historyReasonLine, TERMINAL_STATUSES } from '@/lib/theme';
import {
  canClaimFollowup,
  canCorrectDeliveryLocation,
  canRevertDelivered,
  canCallCustomer,
  canDeleteDelivery,
  canDeleteDeliveryByStatus,
  canEditDelivery,
  canHandoffToSubAgent,
  canMarkClientNotified,
  canPostOnThread,
  canSeedThread,
  canSeeCharged,
  canSeeMargin,
  canUpdateStatus,
  isOps,
} from '@/lib/permissions';
import {
  listClientNotificationsForDelivery,
  markClientNotified,
  type ClientNotificationRow,
} from '@/services/clientNotifications';
import { BotRawMessageCard } from '@/components/delivery/BotRawMessageCard';
import { DeliveryInstructionsCard } from '@/components/delivery/DeliveryInstructionsCard';
import { FollowupClaimBanner } from '@/components/delivery/FollowupClaimBanner';
import { HINTS } from '@/hints/registry';
import { formatDateTime, formatNaira } from '@/lib/format';
import { ChainDivider } from '@/components/delivery/ChainDivider';
import { MarkDeliveredSheet } from '@/components/sheets/MarkDeliveredSheet';
import { CorrectLocationSheet } from '@/components/sheets/CorrectLocationSheet';
import { CorrectChargesSheet } from '@/components/sheets/CorrectChargesSheet';
import { RevertDeliveredSheet } from '@/components/sheets/RevertDeliveredSheet';
import { UpdateStatusSheet } from '@/components/sheets/UpdateStatusSheet';
import { HandoffToSubAgentSheet } from '@/components/sheets/HandoffToSubAgentSheet';
import { DeleteDeliverySheet } from '@/components/sheets/DeleteDeliverySheet';
import { MessageThread } from '@/components/delivery/MessageThread';
import { listSubAgents } from '@/services/users';
import { useQueue } from '@/queue/QueueProvider';

export function DeliveryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useCurrentUser();
  const insets = useSafeAreaInsets();

  const deliveryQ = useAsync(() => getDelivery(user.role, id), [user.role, id]);
  const historyQ = useAsync(() => listDeliveryHistoryChain(id), [id]);
  const defsQ = useAsync(() => listStatusDefs(), []);
  const notifQ = useAsync(() => listClientNotificationsForDelivery(id), [id]);
  const canMarkNotified = canMarkClientNotified(user.role);

  const [markOpen, setMarkOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [correctLocOpen, setCorrectLocOpen] = useState(false);
  const [correctChargeOpen, setCorrectChargeOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
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
  useSupabaseChannel(
    `delivery-client-notifications:${id}`,
    (ch) =>
      ch.on(
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
      ),
    [id],
  );

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

  // Soft statuses where the "I'll handle this" claim makes sense — driven by
  // delivery_status_defs.needs_followup so the SQL gate and the UI gate read
  // the same source. Empty until defs load; canClaimFollowup returns false on
  // an empty set so the banner doesn't flash.
  const followupStatuses = useMemo(() => {
    return new Set<string>((defsQ.data ?? []).filter((d) => d.needs_followup).map((d) => d.status));
  }, [defsQ.data]);

  // In-app call to a specific teammate, linked to this delivery for audit.
  // MUST sit above the loading/error early returns — Rules of Hooks require
  // every hook to be called in the same order every render. Reading
  // `deliveryQ.data?.id` instead of capturing the post-guard `d.id` so the
  // dep array works whether or not the data has loaded yet.
  const deliveryId = deliveryQ.data?.id;
  // Shared call plumbing: mic-permission gate → run the initiator → navigate to
  // the live call screen. `begin` is whichever call this is (1:1 agent, or the
  // ops-team ring), so the busy/permission/error handling lives in one place.
  const startCall = useCallback(
    async (begin: () => Promise<{ id: string }>) => {
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
        const call = await begin();
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
    [callBusy, router],
  );

  // Ops (admin/dispatcher/rep) → call the delivery's assigned agent directly.
  const callAgent = useCallback(
    (calleeId: string) =>
      startCall(() => initiateCall({ calleeId, relatedDeliveryId: deliveryId })),
    [startCall, deliveryId],
  );

  // Agent → ring the whole ops team (first responder wins, server-side).
  const callOps = useCallback(
    () => startCall(() => initiateTeamCall({ relatedDeliveryId: deliveryId })),
    [startCall, deliveryId],
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
  // Waybill/pickup: a money-only order with no product, customer, or address.
  const isWaybill = d.order_type === 'waybill';
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
  const carriedLabel = rolledFromLabel(d);
  // History timeline spans this delivery + its rollover ancestry. When there
  // are ancestor rows we render per-delivery dividers ("Before rollover · …");
  // a plain (never-rolled) delivery has only its own rows and renders as before.
  const chainRows = historyQ.data ?? [];
  const chainHasAncestors = chainRows.some((r) => !r.is_current);

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
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {canEditDelivery(user.role, status) ? (
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
            ) : null}
            {canDeleteDelivery(user.role) && canDeleteDeliveryByStatus(status) ? (
              <TouchableOpacity
                onPress={() => setDeleteOpen(true)}
                hitSlop={8}
                style={{ padding: 4 }}
                accessibilityLabel="Delete delivery"
                accessibilityRole="button"
              >
                <Icon name="trash" size={22} color={colors.red} />
              </TouchableOpacity>
            ) : null}
          </View>
        }
      />

      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: (canEdit ? 130 : 32) + insets.bottom,
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
              {/* Phone numbers shown only to roles that call the customer — reps
                  coordinate with vendors, so the customer's number is hidden for
                  them (same gate as the Call buttons below). */}
              {canCallCustomer(user.role) && d.customer_phone ? (
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
              {canCallCustomer(user.role) && d.customer_phone_alt ? (
                <Text
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                >
                  Alt: {d.customer_phone_alt}
                </Text>
              ) : null}
            </View>
            <StatusPill status={status} />
          </View>
          <View style={{ marginTop: 14, flexDirection: 'row', gap: 8 }}>
            {/* Customer-call actions — hidden for reps, who coordinate with
                vendors, not customers (canCallCustomer). Map stays for everyone. */}
            {canCallCustomer(user.role) ? (
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
            ) : null}
            {canCallCustomer(user.role) && d.customer_phone_alt ? (
              <Button
                variant="secondary"
                size="sm"
                icon="phone"
                onPress={() =>
                  d.customer_phone_alt &&
                  Linking.openURL(`tel:${d.customer_phone_alt.replace(/\s+/g, '')}`)
                }
              >
                Call alt
              </Button>
            ) : null}
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
        {canClaimFollowup(user.role, status, followupStatuses) ? (
          <Hint id={HINTS.FOLLOWUP_CLAIM} title="Tip — Calling the customer?">
            Tap <Text style={{ fontFamily: fonts.bold }}>I&apos;ll handle this</Text> on the banner
            below so other dispatchers know you&apos;re on it. The claim drops automatically the
            moment the status changes.
          </Hint>
        ) : null}

        {/* Follow-up claim — soft statuses only, admin + dispatcher only. */}
        {canClaimFollowup(user.role, status, followupStatuses) && d.id ? (
          <FollowupClaimBanner deliveryId={d.id} currentUserId={user.userId} />
        ) : null}

        {/* One-time hint: teaches the Edit-delivery pencil icon. Suppressed
            when the follow-up hint is in play (per-screen cap). */}
        {canEditDelivery(user.role, status) &&
        !canClaimFollowup(user.role, status, followupStatuses) ? (
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
              color: isWaybill ? colors.textSecondary : colors.black,
              lineHeight: 22,
              marginTop: 6,
            }}
          >
            {isWaybill ? 'No customer address — pickup / waybill order' : d.raw_address}
          </Text>
          {isWaybill ? null : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                <Icon name="mapPin" size={13} color={colors.textSecondary} />
                <Text
                  style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}
                >
                  {d.location_name ?? 'Unmatched location'}
                </Text>
              </View>
              {/* Post-delivery location correction. Delivered rows are locked out
              of the Edit screen, but a wrong location means charged_snapshot
              and agent_payment_snapshot were frozen at the wrong rate and feed
              reconciliation. Admin-only; the dedicated correct_delivery_location
              RPC re-snapshots both and audit-logs the change. */}
              {canCorrectDeliveryLocation(user.role, status) ? (
                <TouchableOpacity
                  onPress={() => setCorrectLocOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Correct delivery location"
                  style={{
                    marginTop: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    paddingVertical: 10,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    borderWidth: 1.5,
                    borderColor: colors.black,
                    backgroundColor: colors.white,
                  }}
                >
                  <Icon name="mapPin" size={15} color={colors.black} />
                  <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                    Correct location
                  </Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
          {/* Admin escape hatch for a wrongly-marked Delivered. Nulls the
              delivered-only columns (qty, paid, payment_method, cash POS
              fee) and flips status back to pending; stock auto-recovers.
              Same admin+delivered gate as Correct location, but distinct
              concern, so they sit as sibling buttons rather than merging. */}
          {canRevertDelivered(user.role, status) ? (
            <TouchableOpacity
              onPress={() => setRevertOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Revert delivered status"
              style={{
                marginTop: 8,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 999,
                borderWidth: 1.5,
                borderColor: colors.red,
                backgroundColor: colors.white,
              }}
            >
              <Icon name="alert" size={15} color={colors.red} />
              <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.red }}>
                Revert delivered
              </Text>
            </TouchableOpacity>
          ) : null}
        </Card>

        {/* Delivery instructions — near the address. Renders nothing when none. */}
        <DeliveryInstructionsCard instructions={d.delivery_instructions} />

        {/* Original WhatsApp message (collapsed by default; renders nothing
            when bot_raw_message is null — i.e. manually-created rows). */}
        <BotRawMessageCard message={d.bot_raw_message} />

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
              <Text style={kicker}>
                {isWaybill ? 'Type' : (d.items?.length ?? 0) > 1 ? 'Products' : 'Product'}
              </Text>
              {isWaybill ? (
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: 16,
                    color: colors.black,
                    marginTop: 4,
                  }}
                >
                  Waybill / pickup
                </Text>
              ) : d.items && d.items.length > 0 ? (
                // [Feature A] itemized — one block per product line
                <View style={{ marginTop: 4, gap: 6 }}>
                  {d.items.map((it) => {
                    const partial =
                      it.quantity_delivered != null &&
                      it.quantity_delivered !== it.quantity_ordered;
                    return (
                      <View key={it.id}>
                        <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
                          {it.product_name ?? 'Product'}
                        </Text>
                        <Text
                          style={{
                            fontFamily: fonts.medium,
                            fontSize: 12,
                            color: colors.textSecondary,
                          }}
                        >
                          Qty {it.quantity_ordered}
                          {it.quantity_delivered != null ? (
                            <>
                              {' · delivered '}
                              <Text
                                style={{
                                  fontFamily: fonts.bold,
                                  color: partial ? colors.warningDark : colors.textSecondary,
                                }}
                              >
                                {it.quantity_delivered}
                              </Text>
                            </>
                          ) : null}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : (
                // legacy fallback (row predates the items backfill)
                <>
                  <Text
                    style={{
                      fontFamily: fonts.bold,
                      fontSize: 16,
                      color: colors.black,
                      marginTop: 4,
                    }}
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
                    {d.quantity_delivered != null ? ` · delivered ${d.quantity_delivered}` : null}
                  </Text>
                </>
              )}
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
                      : d.payment_method === 'vendor_direct'
                        ? 'Paid to vendor'
                        : 'Paid'}
                </Text>
                <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.successDark }}>
                  {formatNaira(d.paid)}
                </Text>
              </View>
              {d.paid != null &&
              d.customer_price != null &&
              Number(d.paid) !== Number(d.customer_price) ? (
                <Text
                  style={{
                    fontFamily: fonts.semibold,
                    fontSize: 12,
                    color: colors.warningDark,
                    marginTop: 4,
                  }}
                >
                  {Number(d.paid) < Number(d.customer_price)
                    ? `${formatNaira(Number(d.customer_price) - Number(d.paid))} short of expected ${formatNaira(d.customer_price)}`
                    : `${formatNaira(Number(d.paid) - Number(d.customer_price))} over expected ${formatNaira(d.customer_price)}`}
                </Text>
              ) : null}
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
          {showMargin && d.margin != null && Number(d.margin) < 0 ? (
            <View
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 10,
                backgroundColor: colors.redSoft,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <Icon name="alert" size={18} color={colors.red} />
              <Text
                style={{
                  flex: 1,
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.red,
                  lineHeight: 16,
                }}
              >
                Negative margin — Reda pays the agent more than it collects.
              </Text>
              <TouchableOpacity onPress={() => setCorrectChargeOpen(true)} hitSlop={8}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.red }}>
                  Correct
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
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
                  {/* Calling the assigned agent lives in the role-aware
                      "Call agent" button below the card. */}
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
            {carriedLabel ? <MoneyRow label="Carried over" value={carriedLabel} /> : null}
          </View>
          {/* One-tap call about THIS delivery, role-aware:
              • Agent → rings the whole ops team (admin/dispatcher/rep); first
                        responder wins. Linked to the delivery for audit.
              • Ops   → calls the delivery's assigned agent directly. When the
                        delivery is unassigned there's no agent to ring, so we
                        show a muted hint instead of a button.
              Other roles (warehouse) get no call control here.
              Hidden on web (no Agora bridge — see canPlaceCall). */}
          {!canPlaceCall() ? null : user.role === 'agent' ? (
            <CallActionRow label="Call admin / dispatch" onPress={callOps} busy={callBusy} />
          ) : isOps(user.role) ? (
            d.assigned_agent_id && d.assigned_agent_id !== user.userId ? (
              <CallActionRow
                label="Call agent"
                onPress={() => callAgent(d.assigned_agent_id as string)}
                busy={callBusy}
              />
            ) : (
              <View
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Icon name="phone" size={16} color={colors.textTertiary} />
                <Text
                  style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}
                >
                  No agent assigned to call
                </Text>
              </View>
            )
          ) : null}
        </Card>

        {/* Messages — renders when there are messages OR when an ops viewer
            can seed an empty thread. */}
        {d.id ? (
          <MessageThread
            deliveryId={d.id}
            deliveryStatus={status}
            viewerRole={user.role}
            canPost={canPostOnThread(user.role, d.assigned_agent_id === user.userId)}
            canSeed={canSeedThread(user.role)}
          />
        ) : null}

        {/* History */}
        <Card>
          <Text style={[kicker, { marginBottom: 12 }]}>History</Text>
          {historyQ.loading && !historyQ.data ? (
            <ActivityIndicator color={colors.black} />
          ) : historyQ.error ? (
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.red }}>
              Couldn’t load history. Pull down to refresh.
            </Text>
          ) : chainRows.length === 0 ? (
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              No history yet.
            </Text>
          ) : (
            <View>
              {chainRows.map((h, i, arr) => {
                const prev = arr[i - 1];
                const newGroup = !prev || prev.delivery_id !== h.delivery_id;
                const isAncestor = !h.is_current;
                return (
                  <Fragment key={h.id}>
                    {chainHasAncestors && newGroup ? (
                      <ChainDivider isCurrent={h.is_current} date={h.scheduled_date} />
                    ) : null}
                    {/* Ancestor (prior-day) rows are muted and read-only — the
                        "Mark client notified" action only applies to this
                        delivery's own rows. */}
                    <View style={isAncestor ? { opacity: 0.6 } : undefined}>
                      <HistoryRow
                        row={h}
                        first={i === 0}
                        last={i === arr.length - 1}
                        labelByStatus={labelByStatus}
                        notification={isAncestor ? null : (notifQ.data?.get(h.id) ?? null)}
                        canMark={isAncestor ? false : canMarkNotified}
                        onMark={onMarkNotified}
                      />
                    </View>
                  </Fragment>
                );
              })}
            </View>
          )}
        </Card>
      </ScrollView>

      {canEdit ? (
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
          <Button variant="secondary" full={isTerminal} onPress={() => setUpdateOpen(true)}>
            Update status
          </Button>
          {!isTerminal ? (
            <Button variant="emphasis" full icon="check" onPress={() => setMarkOpen(true)}>
              Mark delivered
            </Button>
          ) : null}
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
      <CorrectLocationSheet
        open={correctLocOpen}
        deliveryId={d.id ?? null}
        currentLocationId={d.location_id ?? null}
        currentLocationName={d.location_name ?? null}
        onClose={() => setCorrectLocOpen(false)}
        onCorrected={() => {
          setCorrectLocOpen(false);
          deliveryQ.reload();
          historyQ.reload();
        }}
      />
      <RevertDeliveredSheet
        open={revertOpen}
        deliveryId={d.id ?? null}
        customerName={d.customer_name ?? null}
        onClose={() => setRevertOpen(false)}
        onReverted={() => {
          setRevertOpen(false);
          deliveryQ.reload();
          historyQ.reload();
        }}
      />
      <CorrectChargesSheet
        open={correctChargeOpen}
        deliveryId={d.id ?? null}
        currentCharged={charged != null ? Number(charged) : null}
        currentAgentPayment={
          d.agent_payment_snapshot != null ? Number(d.agent_payment_snapshot) : null
        }
        customerName={d.customer_name ?? null}
        onClose={() => setCorrectChargeOpen(false)}
        onCorrected={() => {
          setCorrectChargeOpen(false);
          deliveryQ.reload();
          historyQ.reload();
        }}
      />
      <HandoffToSubAgentSheet
        open={handoffOpen}
        delivery={d}
        leadId={user.userId}
        onClose={() => setHandoffOpen(false)}
        onCommitted={onHandoffCommitted}
      />
      <DeleteDeliverySheet
        open={deleteOpen}
        delivery={d}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          setDeleteOpen(false);
          const base =
            user.role === 'dispatcher'
              ? '/(dispatcher)/deliveries'
              : user.role === 'rep'
                ? '/(rep)/deliveries'
                : '/(admin)/deliveries';
          router.replace(base as `/${string}`);
        }}
      />
    </View>
  );
}

// Role-aware one-tap call row at the bottom of the delivery card (ops → agent,
// agent → ops). Shows a spinner while a call is being placed.
function CallActionRow({
  label,
  onPress,
  busy,
}: {
  label: string;
  onPress: () => void;
  busy: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        opacity: busy ? 0.5 : 1,
      }}
      accessibilityLabel={label}
      accessibilityRole="button"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="phone" size={16} color={colors.success} />
        <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textPrimary }}>
          {label}
        </Text>
      </View>
      {busy ? <ActivityIndicator color={colors.success} size="small" /> : null}
    </TouchableOpacity>
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
  row: DeliveryChainHistoryRow;
  first: boolean;
  last: boolean;
  labelByStatus: Map<string, string>;
  notification: ClientNotificationRow | null;
  canMark: boolean;
  onMark: (historyId: string) => void;
}) {
  const reasonLine = historyReasonLine(row.to_status, row.reason);
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
        {reasonLine ? (
          <Text
            selectable
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {reasonLine}
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
            One-tap copy of the customer-facing line + note saves the retype. */}
        {reasonLine || row.notes ? (
          <CopyNotePill text={[reasonLine, row.notes].filter(Boolean).join('\n')} />
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
