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
import { initiateTeamCall } from '@/services/calls';
import { ensureMicPermission } from '@/lib/calls/permissions';
import { canPlaceCall } from '@/lib/calls/availability';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  getDelivery,
  listDeliveryHistory,
  listStatusDefs,
  type DeliveryStatusHistoryRow,
} from '@/services/deliveries';
import { AppBar, Button, Card, Empty, Icon, StatusPill } from '@/components/ui';
import { colors, fonts, TERMINAL_STATUSES } from '@/lib/theme';
import { formatDateTime, formatNaira } from '@/lib/format';
import { MarkDeliveredSheet } from '@/components/sheets/MarkDeliveredSheet';
import { UpdateStatusSheet } from '@/components/sheets/UpdateStatusSheet';
import { FlagDeliverySheet } from '@/components/sheets/FlagDeliverySheet';
import { MessageThread } from '@/components/delivery/MessageThread';
import { useQueue } from '@/queue/QueueProvider';

export default function AgentDeliveryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useCurrentUser();

  const deliveryQ = useAsync(() => getDelivery(user.role, id), [user.role, id]);
  const historyQ = useAsync(() => listDeliveryHistory(id), [id]);
  const defsQ = useAsync(() => listStatusDefs(), []);

  const [markOpen, setMarkOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [flagOpen, setFlagOpen] = useState(false);
  // Optimistic status + (when queued) the job ID to watch. The veil clears
  // when EITHER the server-confirmed status matches (direct-RPC paths) OR
  // the tracked queue job ends — succeeded (removed) or dead-lettered.
  // Prevents the "marked delivered but server rejected → buttons gone
  // forever" scenario.
  const [optimistic, setOptimistic] = useState<{ status: string; jobId: string | null } | null>(
    null,
  );
  const optimisticStatus = optimistic?.status ?? null;
  const { snapshot: queueSnapshot } = useQueue();

  useFocusEffect(
    useCallback(() => {
      deliveryQ.reload();
      historyQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

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
  const firstName = (d.customer_name ?? 'customer').split(/\s+/)[0]!;
  // customer_price is per-delivery, not per-unit. Do NOT multiply by quantity.
  const expectedTotal = Number(d.customer_price ?? 0);

  const onCommitted = (newStatus: string, jobId: string) => {
    setOptimistic({ status: newStatus, jobId });
    setMarkOpen(false);
    setUpdateOpen(false);
    deliveryQ.reload();
    historyQ.reload();
  };

  // FlagDeliverySheet hits an RPC synchronously (not queued), so the next
  // reload returns the new status — no job to watch. Pass jobId=null so the
  // veil clears on server-status match alone.
  const onFlagged = (newStatus: string | null) => {
    if (newStatus) setOptimistic({ status: newStatus, jobId: null });
    setFlagOpen(false);
    deliveryQ.reload();
    historyQ.reload();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title={d.customer_name ?? 'Delivery'}
        subtitle={
          d.created_at
            ? `Created ${formatDateTime(d.created_at)} · via ${d.created_via ?? 'manual'}`
            : undefined
        }
        onBack={() => router.back()}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {!isTerminal ? (
              <TouchableOpacity
                onPress={() => setFlagOpen(true)}
                hitSlop={8}
                style={{ padding: 4 }}
                accessibilityLabel="Flag this delivery"
                accessibilityRole="button"
              >
                <Icon name="alert" size={22} color={colors.black} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              onPress={() =>
                router.push({ pathname: '/(profile)/help', params: { topic: 'mark-delivered' } })
              }
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityLabel="Help"
              accessibilityRole="button"
            >
              <Icon name="helpCircle" size={22} color={colors.black} />
            </TouchableOpacity>
          </View>
        }
      />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: 130 + insets.bottom,
          gap: 12,
        }}
      >
        {/* Hero: customer + status + call */}
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
            </View>
            <StatusPill status={status} />
          </View>
          <View style={{ marginTop: 14 }}>
            <Button
              variant="primary"
              full
              icon="phone"
              onPress={() =>
                d.customer_phone && Linking.openURL(`tel:${d.customer_phone.replace(/\s+/g, '')}`)
              }
            >
              {`Call ${firstName}`}
            </Button>
          </View>
          {d.customer_phone ? (
            <Text
              style={{
                fontFamily: fonts.mono,
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 10,
              }}
            >
              {d.customer_phone}
            </Text>
          ) : null}
        </Card>

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
          <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
            <Button
              variant="secondary"
              size="sm"
              icon="mapPin"
              onPress={() => openMaps(d.raw_address)}
            >
              Open in maps
            </Button>
          </View>
        </Card>

        {/* Product + money */}
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
                {d.quantity_delivered != null ? (
                  <>
                    {' · delivered '}
                    <Text
                      style={{
                        fontFamily: fonts.bold,
                        color:
                          d.quantity_ordered != null && d.quantity_delivered !== d.quantity_ordered
                            ? colors.warningDark
                            : colors.textSecondary,
                      }}
                    >
                      {d.quantity_delivered}
                    </Text>
                  </>
                ) : null}
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
              <Text
                style={{
                  fontFamily: fonts.semibold,
                  fontSize: 12,
                  color: colors.successDark,
                  marginTop: 4,
                }}
              >
                You earned {formatNaira(Number(d.agent_payment_snapshot ?? 0))}
              </Text>
            </View>
          ) : null}
        </Card>

        {/* One-tap team page. Rings every active admin/dispatcher/rep
            phone; first accepter wins server-side. The row is linked to
            this delivery so post-accept the ops user has full context. */}
        <Card
          onPress={async () => {
            if (!canPlaceCall()) {
              Alert.alert(
                'Calls work on the mobile app',
                'Open Reda on your phone to alert the team.',
              );
              return;
            }
            const micOk = await ensureMicPermission();
            if (!micOk) {
              Alert.alert(
                'Microphone needed',
                'Reda needs the microphone to ring ops. Tap "Open settings" → Permissions → Microphone → Allow.',
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
            try {
              const call = await initiateTeamCall({ relatedDeliveryId: d.id });
              router.push(`/call/${call.id}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes('ringing call')) {
                Alert.alert(
                  'Already on a call',
                  'You already have a call ringing. Try again in a moment.',
                );
              } else {
                Alert.alert('Could not alert team', msg);
              }
            }
          }}
        >
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="phone" size={16} color={colors.success} />
              <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textPrimary }}>
                Alert team
              </Text>
            </View>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </View>
        </Card>

        {/* Messages — agent can reply to ops-seeded threads or follow up on
            their own flagged thread. Seeding still goes through
            FlagDeliverySheet so the chip + status change are captured. */}
        <MessageThread deliveryId={d.id!} deliveryStatus={status} canPost canSeed={false} />

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
                />
              ))}
            </View>
          )}
        </Card>
      </ScrollView>

      {/* "Update status" stays visible on terminal statuses so a mistaken
          Cancelled can be escalated — the sheet shows the admin-required note. */}
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
        <View style={{ flex: 1 }}>
          <Button variant="secondary" full onPress={() => setUpdateOpen(true)}>
            Update status
          </Button>
        </View>
        {!isTerminal ? (
          <View style={{ flex: 1 }}>
            <Button variant="emphasis" full onPress={() => setMarkOpen(true)}>
              Mark delivered
            </Button>
          </View>
        ) : null}
      </View>

      <MarkDeliveredSheet
        open={markOpen}
        delivery={d}
        onClose={() => setMarkOpen(false)}
        onConfirmed={onCommitted}
      />
      <UpdateStatusSheet
        open={updateOpen}
        delivery={d}
        isAdmin={false}
        autoSeedThreadOnIntervention
        onClose={() => setUpdateOpen(false)}
        onCommitted={onCommitted}
      />
      <FlagDeliverySheet
        open={flagOpen}
        delivery={d}
        onClose={() => setFlagOpen(false)}
        onCommitted={onFlagged}
      />
    </View>
  );
}

function HistoryRow({
  row,
  first,
  last,
  labelByStatus: _labelByStatus,
}: {
  row: DeliveryStatusHistoryRow;
  first: boolean;
  last: boolean;
  labelByStatus: Map<string, string>;
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
