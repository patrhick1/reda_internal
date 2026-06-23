import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  listDeliveries,
  listAgentPostponed,
  deliveryProductsLabel,
  type DeliveryRow,
} from '@/services/deliveries';
import { formatNaira, formatYmdShort } from '@/lib/format';
import {
  Button,
  Card,
  Empty,
  FilterChips,
  Icon,
  Input,
  RedaMark,
  SectionHeader,
  StatusPill,
} from '@/components/ui';
import { BulkMarkDeliveredSheet } from '@/components/sheets/BulkMarkDeliveredSheet';
import { canBulkDeliverRow, canBulkMarkDelivered } from '@/lib/permissions';
import { useAgentUnread } from '@/hooks/useAgentUnreadMessages';
import type { STATUS_GROUPS } from '@/lib/theme';
import { colors, fonts, statusBucket } from '@/lib/theme';

const BUCKET_ACCENT: Record<keyof typeof STATUS_GROUPS, string> = {
  active: colors.red,
  soft: colors.warning,
  done: colors.success,
  closed: colors.closed,
};

// Status segments for the agent's Today list. No date filter — the screen only
// ever shows today's own deliveries — and no "Unassigned" (every row here is
// already assigned to this agent). Mirrors the ops list's bucket definitions.
// 'postponed' is the exception: it's a FUTURE-dated slice (orders this agent
// pushed to a later day) fetched via a separate query, not part of today's set.
type Filter =
  | 'all'
  | 'unread'
  | 'pending'
  | 'active'
  | 'available'
  | 'soft'
  | 'postponed'
  | 'done'
  | 'closed';

function todayLagosLabel(): string {
  const lagos = new Date(new Date().getTime() + 60 * 60 * 1000);
  return lagos.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

export default function AgentToday() {
  const user = useCurrentUser();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Unread admin/dispatcher replies, keyed by delivery — drives the per-row
  // dot here and the bottom-tab badge in the layout. Shared single subscription.
  const { byDelivery: unreadByDelivery, total: unreadTotal } = useAgentUnread();
  const { data, loading, error, reload } = useAsync(() => listDeliveries(user.role), [user.role]);
  // Future-dated postponed orders this agent owns — a separate light query so
  // they survive leaving the today list (see listAgentPostponed). Only drives
  // the "Postponed" chip + its list slice; never folds into today's `data`.
  const {
    data: postponedData,
    loading: postponedLoading,
    error: postponedError,
    reload: reloadPostponed,
  } = useAsync(() => listAgentPostponed(user.userId), [user.userId]);
  useFocusEffect(
    useCallback(() => {
      reload();
      reloadPostponed();
    }, [reload, reloadPostponed]),
  );

  // Status segment + customer-name search. Both are client-side narrows over the
  // already-fetched today list — no extra round trip.
  const [filter, setFilter] = useState<Filter>('all');
  const [nameQuery, setNameQuery] = useState('');
  const nameNeedle = nameQuery.trim().toLowerCase();

  const canBulk = canBulkMarkDelivered(user.role);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  // Orders whose "mark delivered" job was just enqueued but hasn't drained yet.
  // We suppress re-selecting them so the agent can't double-enqueue a delivery
  // that's already in flight (the list still shows its pre-delivery status
  // until the queue drains + a reload lands).
  const [pendingDeliveredIds, setPendingDeliveredIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const enterSelect = useCallback((seedId: string | null) => {
    setSelectMode(true);
    setSelectedIds(seedId ? new Set([seedId]) : new Set());
  }, []);
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedRows = useMemo<DeliveryRow[]>(() => {
    if (!selectMode || selectedIds.size === 0 || !data) return [];
    return data.filter((d) => d.id && selectedIds.has(d.id));
  }, [data, selectMode, selectedIds]);

  const onBulkConfirmed = useCallback(
    (count: number) => {
      setBulkSheetOpen(false);
      // Capture the submitted ids BEFORE exitSelect clears the selection, so
      // we can suppress re-selecting them while their jobs are in flight.
      setPendingDeliveredIds((prev) => {
        const next = new Set(prev);
        for (const d of selectedRows) if (d.id) next.add(d.id);
        return next;
      });
      exitSelect();
      reload();
      Alert.alert('Done', `Marking ${count} ${count === 1 ? 'order' : 'orders'} delivered…`);
    },
    [exitSelect, reload, selectedRows],
  );

  // Stop suppressing an order once fresh data shows it's no longer eligible —
  // i.e. its delivered job landed (it's now terminal, so canBulkDeliverRow is
  // false anyway). Rows still eligible stay suppressed (job in flight). The set
  // is in-memory, so a dead-lettered job's suppression also lifts on restart.
  useEffect(() => {
    if (!data) return;
    setPendingDeliveredIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const id of prev) {
        const row = data.find((d) => d.id === id);
        if (row && canBulkDeliverRow(row)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  // Bulk "mark delivered" is a Today-only action. The Postponed slice is a
  // separate (future-dated) dataset that isn't in `selectedRows`, so leaving
  // select mode active there would show a count the confirm sheet can't act on.
  // Drop out of select mode if the user switches into Postponed.
  useEffect(() => {
    if (filter === 'postponed' && selectMode) exitSelect();
  }, [filter, selectMode, exitSelect]);

  // Hero stats stay GLOBAL (whole day), independent of the active filter/search.
  const stats = useMemo(() => summarize(data ?? []), [data]);
  const dateLabel = todayLagosLabel();

  // Apply the name search first so the segment counts reflect the slice on
  // screen, then bucket by status. "Available" overlaps "Active" by design (an
  // available row is still open work) — same as the ops list.
  const all = useMemo(() => {
    const rows = data ?? [];
    return nameNeedle
      ? rows.filter((d) => (d.customer_name ?? '').toLowerCase().includes(nameNeedle))
      : rows;
  }, [data, nameNeedle]);
  const buckets = useMemo(
    () => ({
      all,
      // The un-called pile: orders still 'pending' are awaiting the rider's
      // first action (a call). Surfaced as its own chip so riders can't skip
      // them — it's a subset of Active (which also holds available/postponed),
      // the same way Available is a subset of Active.
      pending: all.filter((d) => d.current_status === 'pending'),
      // A 'postponed' row in the today list is, by definition, due TODAY (the
      // list is date-scoped to today) — so present it as live work under Active,
      // not buried under Soft fail. It keeps its amber Postponed pill. Future-
      // dated postponed orders live in the separate Postponed chip, untouched.
      active: all.filter(
        (d) => statusBucket(d.current_status) === 'active' || d.current_status === 'postponed',
      ),
      available: all.filter(
        (d) => d.current_status === 'available' || d.current_status === 'available_evening',
      ),
      soft: all.filter(
        (d) => statusBucket(d.current_status) === 'soft' && d.current_status !== 'postponed',
      ),
      done: all.filter((d) => statusBucket(d.current_status) === 'done'),
      closed: all.filter((d) => statusBucket(d.current_status) === 'closed'),
    }),
    [all],
  );
  // Postponed is its own future-dated slice (separate query). Apply the same
  // name search so its chip count matches what's on screen.
  const postponedRows = useMemo(() => {
    const rows = postponedData ?? [];
    return nameNeedle
      ? rows.filter((d) => (d.customer_name ?? '').toLowerCase().includes(nameNeedle))
      : rows;
  }, [postponedData, nameNeedle]);

  // Today's deliveries with an unread team reply waiting on this agent. Built
  // from the on-screen rows ∩ the shared unread map (agentUnreadCounts is already
  // today- and RLS-scoped to this agent), so the chip count matches the rows.
  const unreadRows = useMemo(
    () => all.filter((d) => (d.id ? (unreadByDelivery.get(d.id) ?? 0) > 0 : false)),
    [all, unreadByDelivery],
  );

  const list =
    filter === 'postponed' ? postponedRows : filter === 'unread' ? unreadRows : buckets[filter];
  const filterOptions = [
    { id: 'all' as const, label: 'All', count: buckets.all.length },
    { id: 'unread' as const, label: 'Unread', count: unreadRows.length },
    { id: 'pending' as const, label: 'Pending', count: buckets.pending.length },
    { id: 'active' as const, label: 'Active', count: buckets.active.length },
    { id: 'available' as const, label: 'Available', count: buckets.available.length },
    { id: 'soft' as const, label: 'Soft fail', count: buckets.soft.length },
    { id: 'postponed' as const, label: 'Postponed', count: postponedRows.length },
    { id: 'done' as const, label: 'Done', count: buckets.done.length },
    { id: 'closed' as const, label: 'Closed', count: buckets.closed.length },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Hero header */}
      <View
        style={{
          backgroundColor: colors.white,
          paddingHorizontal: 16,
          paddingTop: insets.top + 16,
          paddingBottom: 24,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <RedaMark size={32} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
              {dateLabel}
            </Text>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 16,
                color: colors.black,
                letterSpacing: -0.2,
                marginTop: 1,
              }}
            >
              {greeting()}, {user.displayName}.
            </Text>
          </View>
          <View>
            <Icon name="bell" size={22} color={colors.black} />
            {unreadTotal > 0 ? (
              <View
                accessibilityLabel={`${unreadTotal} unread message${unreadTotal === 1 ? '' : 's'} from the team`}
                style={{
                  position: 'absolute',
                  top: -5,
                  right: -6,
                  minWidth: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: colors.red,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: 4,
                  borderWidth: 1.5,
                  borderColor: colors.white,
                }}
              >
                <Text style={{ color: colors.white, fontFamily: fonts.bold, fontSize: 10 }}>
                  {unreadTotal > 9 ? '9+' : unreadTotal}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {/* Bi-stat bar — "To collect" intentionally omitted so agents don't
            walk around knowing a running sum of cash they're carrying. */}
        <View
          style={{
            marginTop: 18,
            flexDirection: 'row',
            backgroundColor: colors.border,
            borderRadius: 14,
            overflow: 'hidden',
            gap: 1,
          }}
        >
          <StatCell
            label="Earned today"
            value={formatNaira(stats.earnedToday)}
            accent={colors.success}
          />
          <StatCell
            label="Deliveries"
            value={`${stats.delivered}/${stats.total}`}
            accent={colors.black}
          />
        </View>
      </View>

      {/* Unread replies card — durable in-app cue that the ops team has replied
          on one of today's orders (pushes are transient / ~1/3 of agents have no
          token). Tapping jumps to the Unread filter. Renders only when there's
          something unread so the screen stays tight. */}
      {unreadRows.length > 0 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <Card dense onPress={() => setFilter('unread')}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: colors.redSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="message" size={18} color={colors.red} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                  {unreadRows.length} {unreadRows.length === 1 ? 'delivery' : 'deliveries'} with
                  unread replies
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                >
                  {unreadTotal} unread {unreadTotal === 1 ? 'message' : 'messages'} from the team
                </Text>
              </View>
              <Icon name="chevronRight" size={20} color={colors.textSecondary} />
            </View>
          </Card>
        </View>
      ) : null}

      {/* Filter + search. No date filter (today only) and no Unassigned
          segment — mirrors the ops deliveries list otherwise. */}
      <View
        style={{
          backgroundColor: colors.white,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingTop: 8,
        }}
      >
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 }}>
          <Input
            icon="search"
            value={nameQuery}
            onChange={setNameQuery}
            placeholder="Search customer name"
            autoCapitalize="none"
            autoCorrect={false}
            rightAdornment={
              nameQuery ? (
                <Pressable
                  onPress={() => setNameQuery('')}
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
      </View>

      {/* List */}
      <FlatList
        data={list}
        keyExtractor={keyForDelivery}
        renderItem={({ item }) => {
          const itemId = item.id ?? null;
          const selectable =
            canBulk &&
            filter !== 'postponed' &&
            canBulkDeliverRow(item) &&
            !(itemId && pendingDeliveredIds.has(itemId));
          return (
            <DeliveryCard
              delivery={item}
              unreadCount={itemId ? (unreadByDelivery.get(itemId) ?? 0) : 0}
              selectMode={selectMode}
              selectable={selectable}
              selected={!!itemId && selectedIds.has(itemId)}
              onPress={() => {
                if (selectMode) {
                  if (selectable && itemId) toggleSelected(itemId);
                  return;
                }
                router.push({ pathname: '/(agent)/today/[id]', params: { id: item.id! } });
              }}
              onLongPress={
                canBulk && selectable && itemId
                  ? () => {
                      if (!selectMode) enterSelect(itemId);
                      else toggleSelected(itemId);
                    }
                  : undefined
              }
            />
          );
        }}
        ItemSeparatorComponent={SeparatorH12}
        ListHeaderComponent={
          filter === 'postponed' ? (
            <SectionHeader>
              {`Postponed · ${list.length} ${list.length === 1 ? 'order' : 'orders'}`}
            </SectionHeader>
          ) : null
        }
        ListEmptyComponent={
          filter === 'postponed' ? (
            postponedError ? (
              <Empty icon="alert" title="Could not load" sub={postponedError} />
            ) : postponedLoading ? (
              <View style={{ padding: 60 }}>
                <ActivityIndicator color={colors.black} />
              </View>
            ) : (postponedData?.length ?? 0) > 0 ? (
              // Has postponed orders, just none matching the current search.
              <Empty
                icon="search"
                title="Nothing matches"
                sub={`No postponed orders matching "${nameQuery.trim()}". Clear the search to see all postponed orders.`}
              />
            ) : (
              <Empty
                icon="calendar"
                title="No postponed orders"
                sub="Orders you postpone to a later date stay here until that day arrives — then they move back into Today."
              />
            )
          ) : error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60 }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (data?.length ?? 0) > 0 ? (
            // Has deliveries today, just none in the current filter/search.
            <Empty
              icon="search"
              title="Nothing matches"
              sub={
                nameNeedle
                  ? `No deliveries matching "${nameQuery.trim()}"${filter !== 'all' ? ' in this filter' : ''}. Clear the search or tap All.`
                  : 'No deliveries in this filter. Tap All to see everything.'
              }
            />
          ) : (
            <Empty
              icon="package"
              title="No deliveries today"
              sub="Anything Reda assigns to you shows up here. Pull down to refresh if you're expecting one."
            />
          )
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: selectMode ? 110 : 32,
          flexGrow: 1,
        }}
        initialNumToRender={10}
        windowSize={5}
        maxToRenderPerBatch={6}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            refreshing={
              filter === 'postponed' ? postponedLoading && !!postponedData : loading && !!data
            }
            onRefresh={() => {
              reload();
              reloadPostponed();
            }}
            tintColor={colors.black}
          />
        }
      />

      {selectMode ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            flexDirection: 'row',
            gap: 8,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: insets.bottom + 12,
            backgroundColor: colors.white,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Button variant="secondary" onPress={exitSelect}>
            Cancel
          </Button>
          <View style={{ flex: 1 }}>
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={() => setBulkSheetOpen(true)}
              disabled={selectedIds.size === 0}
            >
              {selectedIds.size === 0 ? 'Select orders' : `Mark ${selectedIds.size} delivered`}
            </Button>
          </View>
        </View>
      ) : null}

      <BulkMarkDeliveredSheet
        open={bulkSheetOpen}
        selected={selectedRows}
        onClose={() => setBulkSheetOpen(false)}
        onConfirmed={onBulkConfirmed}
      />
    </View>
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <View
      style={{ flex: 1, backgroundColor: colors.white, paddingVertical: 12, paddingHorizontal: 12 }}
    >
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 10,
          color: colors.textSecondary,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 18,
          color: accent,
          letterSpacing: -0.3,
          marginTop: 4,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

const DeliveryCard = memo(function DeliveryCard({
  delivery,
  unreadCount,
  onPress,
  onLongPress,
  selectMode,
  selectable,
  selected,
}: {
  delivery: DeliveryRow;
  /** Unread admin/dispatcher replies on this delivery's thread. >0 → row dot. */
  unreadCount: number;
  onPress: () => void;
  onLongPress?: () => void;
  /** True when the screen is in multi-select mode (bulk Mark delivered). */
  selectMode: boolean;
  /** True when this row is eligible for bulk delivered (open + has location).
   *  Ineligible rows render dimmed with no checkbox and can't be selected. */
  selectable: boolean;
  selected: boolean;
}) {
  const status = delivery.current_status ?? 'pending';
  const bucket = statusBucket(status);
  const isDone = status === 'delivered';
  const dimmed = isDone || (selectMode && !selectable);
  return (
    <Card
      onPress={onPress}
      onLongPress={onLongPress}
      dense
      style={dimmed ? { opacity: 0.55 } : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'stretch', gap: 12 }}>
        {selectMode ? (
          <View
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled: !selectable }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: !selectable ? colors.border : selected ? colors.black : colors.border,
              backgroundColor: selected ? colors.black : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              alignSelf: 'center',
            }}
          >
            {selected ? <Icon name="check" size={14} color={colors.white} /> : null}
          </View>
        ) : null}
        <View
          style={{
            width: 4,
            borderRadius: 4,
            minHeight: 40,
            backgroundColor: BUCKET_ACCENT[bucket],
          }}
        />
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontFamily: fonts.bold,
                fontSize: 15,
                color: colors.black,
                letterSpacing: -0.2,
              }}
              numberOfLines={1}
            >
              {delivery.customer_name}
            </Text>
            {unreadCount > 0 ? (
              <View
                accessibilityLabel={`${unreadCount} unread message${unreadCount === 1 ? '' : 's'} from the team`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 999,
                  backgroundColor: colors.red,
                }}
              >
                <Icon name="message" size={11} color={colors.white} />
                <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: colors.white }}>
                  {unreadCount > 9 ? '9+' : unreadCount}
                </Text>
              </View>
            ) : null}
            <StatusPill status={status} size="sm" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <Icon name="mapPin" size={12} color={colors.textSecondary} />
            <Text
              style={{
                flex: 1,
                fontFamily: fonts.medium,
                fontSize: 13,
                color: colors.textSecondary,
              }}
              numberOfLines={1}
            >
              {delivery.location_name ?? 'Unmatched'}
            </Text>
          </View>
          {status === 'postponed' && delivery.scheduled_date ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
              <Icon name="calendar" size={12} color={colors.warning} />
              <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.warningDark }}>
                Postponed to {formatYmdShort(delivery.scheduled_date)}
              </Text>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginTop: 8,
            }}
          >
            <Text
              style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.black }}
              numberOfLines={1}
            >
              <Text style={{ fontFamily: fonts.semibold }}>{deliveryProductsLabel(delivery)}</Text>
            </Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 14,
                color: isDone ? colors.success : colors.black,
                letterSpacing: -0.2,
              }}
            >
              {isDone && delivery.agent_payment_snapshot != null
                ? `+${formatNaira(delivery.agent_payment_snapshot)}`
                : formatNaira(delivery.customer_price)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
});

function keyForDelivery(d: DeliveryRow): string {
  return d.id ?? Math.random().toString();
}
function SeparatorH12() {
  return <View style={{ height: 12 }} />;
}

function summarize(rows: DeliveryRow[]): { earnedToday: number; delivered: number; total: number } {
  // agent_payment_snapshot is per-delivery, not per-unit. Do NOT multiply by quantity.
  let earnedToday = 0;
  let delivered = 0;
  for (const d of rows) {
    if (d.current_status === 'delivered') {
      delivered++;
      earnedToday += Number(d.agent_payment_snapshot ?? 0);
    }
  }
  return { earnedToday, delivered, total: rows.length };
}

function greeting(): string {
  const h = new Date(new Date().getTime() + 60 * 60 * 1000).getUTCHours();
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  return 'Evening';
}
