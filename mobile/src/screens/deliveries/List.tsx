import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
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
  listPostponed,
  deliveryProductsLabel,
  rolledFromLabel,
  type DeliveryRow,
} from '@/services/deliveries';
import { listActiveFollowups, type ActiveFollowup } from '@/services/followups';
import { opsUnreadAgentCounts } from '@/services/delivery-messages';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { listUsers, type AppUser } from '@/services/users';
import {
  canBulkAssignDelivery,
  canBulkChangeStatus,
  canBulkDeleteDeliveries,
  canCreateDelivery,
  canFilterDeliveriesList,
  canSeeClientName,
} from '@/lib/permissions';
import { formatNaira, formatYmdShort } from '@/lib/format';
import {
  AppBar,
  Avatar,
  Button,
  Card,
  Empty,
  FAB,
  FilterChips,
  Icon,
  Input,
  StatusPill,
} from '@/components/ui';
import { BulkAssignSheet } from '@/components/sheets/BulkAssignSheet';
import { BulkStatusSheet } from '@/components/sheets/BulkStatusSheet';
import { BulkDeleteSheet } from '@/components/sheets/BulkDeleteSheet';
import {
  colors,
  fonts,
  statusBucket,
  isAssignedActive,
  STATUS_GROUPS,
  STATUS_META,
} from '@/lib/theme';
import { todayLagos, yesterdayLagos } from '@/lib/date';

const SOFT_STATUSES = new Set<string>(STATUS_GROUPS.soft);
// Stable empty map so rows don't see a fresh object (→ re-render) before the
// unread query resolves.
const EMPTY_UNREAD: ReadonlyMap<string, number> = new Map();

// --- Unassigned grouping --------------------------------------------------
// On the Unassigned tab the queue is grouped by the prior-day snapshot
// (rolled_from_status): all "Not answering" together, all "Tomorrow" together,
// etc., with the never-attempted/new orders in their own group. Same soft-only
// gate as the carried-over badge, so a grouped row always shows its matching
// badge. Carried groups come first (in the status defs' natural order, so the
// unreachable statuses sit together and the deferrals sit together), New last.
type UnassignedGroupHeader = { label: string; count: number; carried: boolean };
const NEW_ORDERS_GROUP = '__new__';
const EMPTY_HEADER_MAP: ReadonlyMap<string, UnassignedGroupHeader> = new Map();

function unassignedGroupKey(d: DeliveryRow): string {
  return d.rolled_from_status && SOFT_STATUSES.has(d.rolled_from_status)
    ? d.rolled_from_status
    : NEW_ORDERS_GROUP;
}
function unassignedGroupOrder(key: string): number {
  const i = STATUS_GROUPS.soft.indexOf(key);
  return i === -1 ? STATUS_GROUPS.soft.length : i; // New (and any non-soft) last
}

type BasePath = '/(admin)' | '/(dispatcher)' | '/(rep)';
type Filter = 'all' | 'active' | 'available' | 'soft' | 'postponed' | 'done' | 'unassigned';
type DatePreset = 'today' | 'yesterday' | 'custom' | 'all';

export function DeliveriesList({ basePath }: { basePath: BasePath }) {
  const user = useCurrentUser();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  // Persists across preset toggles so switching today → yesterday → custom
  // doesn't blank the value the user already typed.
  const [customDate, setCustomDate] = useState<string>(todayLagos());
  // null = "All agents". Agents see only their own deliveries server-side,
  // so the picker stays hidden for them — narrowing has no work to do.
  const [agentId, setAgentId] = useState<string | null>(null);
  // Read-only narrowing affordance, open to the full ops set (admin +
  // dispatcher + rep). Reps coordinate with vendors and asked to scan
  // "show me Tunde's queue" the same way managers do — it's a client-side
  // filter, not the manager-only assign action.
  const showAgentPicker = canFilterDeliveriesList(user.role);
  // Multi-select bulk reassign — Uzo's morning queue flow. Admin + dispatcher
  // only (canBulkAssignDelivery). Long-press a row to enter select mode; in
  // select mode rows toggle selection on tap and the bottom action bar
  // surfaces "Assign to…". See BulkAssignSheet for the picker.
  const canBulkAssign = canBulkAssignDelivery(user.role);
  const canBulkStatus = canBulkChangeStatus(user.role);
  const canBulkDelete = canBulkDeleteDeliveries(user.role);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  const [bulkStatusSheetOpen, setBulkStatusSheetOpen] = useState(false);
  const [bulkDeleteSheetOpen, setBulkDeleteSheetOpen] = useState(false);
  // Reps coordinate with vendors and need the client name on each row so they
  // can scan and call back without opening the detail. Agents have a separate
  // screen (`(agent)/today/index.tsx`) — this gate is defensive in case the
  // shared list is ever wired into an agent route.
  const showClient = canSeeClientName(user.role);
  // Customer-name substring filter. Ops roles (admin / dispatcher / rep) —
  // agents have at most a handful of rows on screen and don't need it. Plain
  // client-side narrow over the already-fetched list; no extra round-trip.
  const showNameSearch = canFilterDeliveriesList(user.role);
  const [nameQuery, setNameQuery] = useState('');
  const nameNeedle = nameQuery.trim().toLowerCase();

  // Derive the filter passed to the service. Mirrors the reconcile pattern.
  const listFilters = useMemo(() => {
    switch (datePreset) {
      case 'today':
        return { date: todayLagos() };
      case 'yesterday':
        return { date: yesterdayLagos() };
      case 'custom':
        return { date: customDate };
      case 'all':
        return { allDates: true };
    }
  }, [datePreset, customDate]);

  const { data, loading, error, reload } = useAsync(
    () => listDeliveries(user.role, listFilters),
    [user.role, datePreset, customDate],
  );

  // Active follow-up claims, fetched only for the ops set (admin / dispatcher /
  // rep — agents don't see the claim overlay in v1). Paired with the
  // deliveries reload so both stay in sync on focus + pull-to-refresh.
  const canSeeClaims = user.role === 'admin' || user.role === 'dispatcher' || user.role === 'rep';
  const followupsQ = useAsync<ActiveFollowup[]>(
    () => (canSeeClaims ? listActiveFollowups() : Promise.resolve([])),
    [canSeeClaims],
  );

  // Per-row "agent replied" indicator for the ops set. Unread agent-authored
  // messages keyed by delivery_id; a row shows a red message chip when an agent
  // has responded and no ops user has opened the thread yet. Shared across ops
  // (read_at is a single column — see opsUnreadAgentCounts). Kept in lock-step
  // with the deliveries reload (focus + pull-to-refresh) plus a realtime sub
  // below so the chip clears the moment someone opens the thread.
  const unreadQ = useAsync<Map<string, number>>(
    () => (canSeeClaims ? opsUnreadAgentCounts() : Promise.resolve(new Map())),
    [canSeeClaims],
  );

  // Every postponed order, across ALL dates, ordered by postpone-to date. Drives
  // the dedicated "Postponed" filter — a separate query because the main list is
  // date-scoped, while postponed orders scatter across future dates. Ops-wide
  // (RLS-scoped); see listPostponed.
  const postponedQ = useAsync<DeliveryRow[]>(
    () => (canSeeClaims ? listPostponed(user.role) : Promise.resolve([])),
    [canSeeClaims, user.role],
  );

  // Roster for the agent picker. Skip the fetch entirely when the picker
  // won't render (agents). Cached for the screen's lifetime — agents don't
  // get added/deactivated mid-session in practice.
  const agentsQ = useAsync<AppUser[]>(
    () => (showAgentPicker ? listUsers() : Promise.resolve([])),
    [showAgentPicker],
  );
  const agents = useMemo(() => {
    return (agentsQ.data ?? [])
      .filter((u) => u.role === 'agent' && u.is_active)
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
  }, [agentsQ.data]);
  // Pool for bulk-assign — only top-level agents (no sub-agents). Mirrors
  // bulk_assign_deliveries' server-side check so the sheet doesn't show
  // anyone the RPC would reject.
  const bulkAssignTargets = useMemo(() => agents.filter((a) => !a.parent_agent_id), [agents]);

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
  const onBulkAssigned = useCallback(
    (updated: number) => {
      setBulkSheetOpen(false);
      exitSelect();
      reload();
      const msg = `Assigned ${updated} ${updated === 1 ? 'delivery' : 'deliveries'}.`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert('Done', msg);
      }
    },
    [exitSelect, reload],
  );
  const onBulkStatusChanged = useCallback(
    (counts: { changedCount: number; skippedCount: number }) => {
      setBulkStatusSheetOpen(false);
      exitSelect();
      reload();
      const msg =
        counts.skippedCount > 0
          ? `Changed ${counts.changedCount}, skipped ${counts.skippedCount}.`
          : `Changed ${counts.changedCount}.`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert('Done', msg);
      }
    },
    [exitSelect, reload],
  );
  const onBulkDeleted = useCallback(
    (counts: { deletedCount: number; skippedCount: number }) => {
      setBulkDeleteSheetOpen(false);
      exitSelect();
      reload();
      const msg =
        counts.skippedCount > 0
          ? `Deleted ${counts.deletedCount}, skipped ${counts.skippedCount}.`
          : `Deleted ${counts.deletedCount}.`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert('Done', msg);
      }
    },
    [exitSelect, reload],
  );

  // Resolve the selected IDs back to full DeliveryRow objects so the bulk
  // sheets can preview eligibility (FINAL_STATUSES, already-deleted) without
  // a second roundtrip. Memoised against the underlying list + selection set.
  const selectedRows = useMemo<DeliveryRow[]>(() => {
    if (!selectMode || selectedIds.size === 0 || !data) return [];
    return data.filter((d) => d.id && selectedIds.has(d.id));
  }, [data, selectMode, selectedIds]);

  useFocusEffect(
    useCallback(() => {
      reload();
      if (canSeeClaims) {
        followupsQ.reload();
        unreadQ.reload();
        postponedQ.reload();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reload, canSeeClaims]),
  );

  // Bulk actions resolve `selectedRows` from the date-scoped `data`. The
  // Postponed view is a separate cross-date pool not in `data`, so leaving
  // select mode active across that boundary would act on a stale set. Drop out
  // of select mode whenever we cross into (or out of) the Postponed view.
  const isPostponedView = filter === 'postponed';
  useEffect(() => {
    exitSelect();
  }, [isPostponedView, exitSelect]);

  // Realtime: keep the per-row claimer avatar pill live for the ops set.
  // Mirrors FollowupClaimBanner's per-delivery sub but unfiltered at the
  // screen level — one channel covers every row. Pairs with
  // scripts/delivery-followups-realtime.sql which adds the table to the
  // supabase_realtime publication.
  useSupabaseChannel(
    canSeeClaims ? 'deliveries-list-followups' : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_followups' },
        () => {
          followupsQ.reload();
        },
      ),
    [canSeeClaims],
  );

  // Realtime: any delivery_messages change (an agent reply lands, or read_at
  // flips when an ops user opens the thread) → refetch the unread map so the
  // per-row chip appears/clears live. delivery_messages is already in the
  // supabase_realtime publication (added for the agent badge).
  useSupabaseChannel(
    canSeeClaims ? 'deliveries-list-unread' : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_messages' },
        () => {
          unreadQ.reload();
        },
      ),
    [canSeeClaims],
  );

  const followupByDelivery = useMemo(() => {
    const m = new Map<string, ActiveFollowup>();
    for (const f of followupsQ.data ?? []) m.set(f.delivery_id, f);
    return m;
  }, [followupsQ.data]);

  const unreadByDelivery = unreadQ.data ?? EMPTY_UNREAD;

  // Narrow by agent + customer-name FIRST so the status segment counts
  // (Active/Soft/Done/Unassigned) reflect just the slice the user is looking
  // at — matches the intent of "show me Tunde's pending for Mr Adeyemi".
  // When agentId is set, the Unassigned count is 0 by definition (an
  // unassigned delivery has no agent). Name match is a case-insensitive
  // substring on customer_name.
  const all = useMemo(() => {
    let rows = data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (nameNeedle)
      rows = rows.filter((d) => (d.customer_name ?? '').toLowerCase().includes(nameNeedle));
    return rows;
  }, [data, agentId, nameNeedle]);
  const buckets = useMemo(
    () => ({
      all,
      // Note on assignment-gating: "Active" is the ONLY status segment that
      // also requires an assigned agent (isAssignedActive). That's deliberate
      // — a freshly-rolled pending order is queue work, so it belongs under
      // "Unassigned", not "Active" (otherwise the whole 804-row queue would
      // show as Active too). Available/Soft/Done are NOT assignment-gated
      // because those statuses are only ever set by an agent working the
      // order, so an unassigned row practically never lands in them.
      active: all.filter(isAssignedActive),
      available: all.filter(
        (d) => d.current_status === 'available' || d.current_status === 'available_evening',
      ),
      soft: all.filter((d) => statusBucket(d.current_status) === 'soft'),
      done: all.filter((d) => statusBucket(d.current_status) === 'done'),
      unassigned: all.filter((d) => !d.assigned_agent_id),
    }),
    [all],
  );

  // Unassigned tab: sort into prior-status groups and compute the header that
  // sits above the first row of each group. Other tabs keep the server order.
  const { unassignedSorted, headerByRowId } = useMemo(() => {
    if (filter !== 'unassigned') {
      return { unassignedSorted: null, headerByRowId: EMPTY_HEADER_MAP };
    }
    // Decorate each row with its group key + sort order ONCE, so the sort
    // comparator is O(1) (no per-comparison key recompute / indexOf) and the
    // counts/headers passes reuse the same key. Also tallies group counts in
    // the same pass.
    const counts = new Map<string, number>();
    const decorated = buckets.unassigned.map((row) => {
      const key = unassignedGroupKey(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { row, key, order: unassignedGroupOrder(key) };
    });
    // Only group when there's more than one prior-status group — otherwise the
    // grouping adds a redundant lone header and needlessly re-sorts an all-fresh
    // queue. With <2 groups, fall back to the default (newest-first) order.
    if (counts.size < 2) {
      return { unassignedSorted: null, headerByRowId: EMPTY_HEADER_MAP };
    }
    decorated.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      // Within a group, oldest-first so the longest-waiting orders surface.
      const ta = a.row.created_at ?? '';
      const tb = b.row.created_at ?? '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return (a.row.id ?? '').localeCompare(b.row.id ?? '');
    });
    const headers = new Map<string, UnassignedGroupHeader>();
    let prevKey: string | null = null;
    for (const d of decorated) {
      if (d.key !== prevKey) {
        if (d.row.id) {
          headers.set(d.row.id, {
            label: d.key === NEW_ORDERS_GROUP ? 'New orders' : (STATUS_META[d.key]?.label ?? d.key),
            count: counts.get(d.key) ?? 0,
            carried: d.key !== NEW_ORDERS_GROUP,
          });
        }
        prevKey = d.key;
      }
    }
    return { unassignedSorted: decorated.map((d) => d.row), headerByRowId: headers };
  }, [filter, buckets.unassigned]);

  // Postponed is a separate cross-date slice (its own query), narrowed by the
  // same agent + name filters as the date-scoped list so the counts and the
  // picker behave consistently.
  const postponedRows = useMemo(() => {
    let rows = postponedQ.data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (nameNeedle)
      rows = rows.filter((d) => (d.customer_name ?? '').toLowerCase().includes(nameNeedle));
    return rows;
  }, [postponedQ.data, agentId, nameNeedle]);

  const list = filter === 'postponed' ? postponedRows : (unassignedSorted ?? buckets[filter]);
  const filterOptions = [
    { id: 'all' as const, label: 'All', count: buckets.all.length },
    { id: 'active' as const, label: 'Active', count: buckets.active.length },
    { id: 'available' as const, label: 'Available', count: buckets.available.length },
    { id: 'soft' as const, label: 'Soft fail', count: buckets.soft.length },
    { id: 'postponed' as const, label: 'Postponed', count: postponedRows.length },
    { id: 'done' as const, label: 'Done', count: buckets.done.length },
    { id: 'unassigned' as const, label: 'Unassigned', count: buckets.unassigned.length },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {selectMode ? (
        <AppBar
          title={`${selectedIds.size} selected`}
          subtitle={subtitleFor(datePreset, customDate)}
          left={
            <Pressable
              onPress={exitSelect}
              hitSlop={8}
              style={{ padding: 4, marginLeft: -4 }}
              accessibilityRole="button"
              accessibilityLabel="Exit select mode"
            >
              <Icon name="x" size={24} color={colors.black} />
            </Pressable>
          }
          right={
            <Pressable
              onPress={exitSelect}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                Done
              </Text>
            </Pressable>
          }
        />
      ) : (
        <AppBar title="Deliveries" subtitle={subtitleFor(datePreset, customDate)} />
      )}
      <View
        style={{
          backgroundColor: colors.white,
          paddingTop: 12,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <FilterChips
          options={DATE_OPTIONS}
          value={datePreset}
          onChange={(v) => setDatePreset(v as DatePreset)}
        />
        {datePreset === 'custom' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <Input
              label="Date"
              value={customDate}
              onChange={setCustomDate}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="YYYY-MM-DD"
            />
          </View>
        ) : null}
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
        {showNameSearch ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
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
        ) : null}
        {showAgentPicker ? (
          <AgentPicker
            value={agentId}
            agents={agents}
            loading={agentsQ.loading}
            onChange={setAgentId}
          />
        ) : null}
      </View>
      <FlatList
        data={list}
        keyExtractor={keyForDelivery}
        renderItem={({ item }) => {
          const claim = item.id ? followupByDelivery.get(item.id) : undefined;
          const itemId = item.id ?? '';
          const selected = selectMode && itemId ? selectedIds.has(itemId) : false;
          const header = itemId ? headerByRowId.get(itemId) : undefined;
          return (
            <>
              {header ? (
                <GroupHeaderRow
                  label={header.label}
                  count={header.count}
                  carried={header.carried}
                />
              ) : null}
              <DeliveryListRow
                delivery={item}
                followup={claim}
                showClient={showClient}
                unreadCount={itemId ? (unreadByDelivery.get(itemId) ?? 0) : 0}
                selectMode={selectMode}
                selected={selected}
                onPress={() => {
                  if (selectMode) {
                    if (itemId) toggleSelected(itemId);
                    return;
                  }
                  router.push({
                    pathname: `${basePath}/deliveries/[id]` as
                      | `/(admin)/deliveries/[id]`
                      | `/(dispatcher)/deliveries/[id]`
                      | `/(rep)/deliveries/[id]`,
                    params: { id: itemId },
                  });
                }}
                onLongPress={
                  canBulkAssign && itemId && filter !== 'postponed'
                    ? () => {
                        if (!selectMode) enterSelect(itemId);
                        else toggleSelected(itemId);
                      }
                    : undefined
                }
              />
            </>
          );
        }}
        ItemSeparatorComponent={SeparatorH8}
        refreshControl={
          <RefreshControl
            refreshing={
              filter === 'postponed' ? postponedQ.loading && !!postponedQ.data : loading && !!data
            }
            onRefresh={() => {
              reload();
              postponedQ.reload();
            }}
            tintColor={colors.black}
          />
        }
        contentContainerStyle={{
          padding: 16,
          paddingBottom: selectMode ? 120 + insets.bottom : 96,
          flexGrow: 1,
        }}
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        ListEmptyComponent={
          filter === 'postponed' ? (
            postponedQ.error ? (
              <Empty icon="alert" title="Could not load" sub={postponedQ.error} />
            ) : postponedQ.loading ? (
              <View style={{ padding: 60, alignItems: 'center' }}>
                <ActivityIndicator color={colors.black} />
              </View>
            ) : (
              <Empty
                icon="calendar"
                title="No postponed orders"
                sub="Orders postponed to a later date show here with their due date, soonest first."
              />
            )
          ) : error ? (
            <Empty icon="alert" title="Could not load" sub={error} />
          ) : loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="package"
              title="Nothing here"
              sub={emptySubtitle(
                datePreset,
                customDate,
                agents.find((a) => a.id === agentId)?.display_name ?? null,
                nameQuery.trim() || null,
              )}
            />
          )
        }
      />
      {!selectMode && canCreateDelivery(user.role) ? (
        <FAB
          icon="plus"
          label="Create"
          onPress={() =>
            router.push(
              `${basePath}/deliveries/new` as
                | `/(admin)/deliveries/new`
                | `/(dispatcher)/deliveries/new`,
            )
          }
        />
      ) : null}

      {selectMode ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12 + insets.bottom,
            backgroundColor: colors.white,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            flexDirection: 'row',
            gap: 8,
          }}
        >
          <Button
            variant="secondary"
            onPress={() => setSelectedIds(new Set())}
            disabled={selectedIds.size === 0}
          >
            Clear
          </Button>
          {canBulkStatus ? (
            <Button
              variant="secondary"
              onPress={() => setBulkStatusSheetOpen(true)}
              disabled={selectedIds.size === 0}
            >
              {`Status ${selectedIds.size}`}
            </Button>
          ) : null}
          {canBulkDelete ? (
            <Button
              variant="secondary"
              icon="trash"
              onPress={() => setBulkDeleteSheetOpen(true)}
              disabled={selectedIds.size === 0}
            >
              {`Delete ${selectedIds.size}`}
            </Button>
          ) : null}
          <View style={{ flex: 1 }}>
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={() => setBulkSheetOpen(true)}
              disabled={selectedIds.size === 0}
            >
              {`Assign ${selectedIds.size}`}
            </Button>
          </View>
        </View>
      ) : null}

      <BulkAssignSheet
        open={bulkSheetOpen}
        deliveryIds={Array.from(selectedIds)}
        agents={bulkAssignTargets}
        onClose={() => setBulkSheetOpen(false)}
        onAssigned={onBulkAssigned}
      />
      <BulkStatusSheet
        open={bulkStatusSheetOpen}
        selected={selectedRows}
        onClose={() => setBulkStatusSheetOpen(false)}
        onChanged={onBulkStatusChanged}
      />
      <BulkDeleteSheet
        open={bulkDeleteSheetOpen}
        selected={selectedRows}
        onClose={() => setBulkDeleteSheetOpen(false)}
        onDeleted={onBulkDeleted}
      />
    </View>
  );
}

// Section header for the Unassigned tab's prior-status groups. Carried groups
// get the rollover icon + amber tint (matching the per-row badge); "New orders"
// is neutral.
function GroupHeaderRow({
  label,
  count,
  carried,
}: {
  label: string;
  count: number;
  carried: boolean;
}) {
  const color = carried ? colors.warningDark : colors.textSecondary;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 6,
        paddingLeft: 2,
      }}
    >
      {carried ? <Icon name="refresh" size={12} color={color} /> : null}
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 11,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color,
        }}
      >
        {label}
      </Text>
      <View
        style={{
          backgroundColor: carried ? colors.warningSoft : colors.surfaceAlt,
          borderRadius: 999,
          paddingHorizontal: 7,
          paddingVertical: 1,
        }}
      >
        <Text style={{ fontFamily: fonts.bold, fontSize: 10, color }}>{count}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border, marginLeft: 4 }} />
    </View>
  );
}

// Memoised so unchanged rows don't re-render when the parent re-creates
// renderItem closures on filter switches.
const DeliveryListRow = memo(function DeliveryListRow({
  delivery,
  onPress,
  onLongPress,
  followup,
  showClient,
  unreadCount,
  selectMode,
  selected,
}: {
  delivery: DeliveryRow;
  onPress: () => void;
  onLongPress?: () => void;
  followup?: ActiveFollowup;
  showClient: boolean;
  /** Unread agent-authored messages on this delivery — drives the red "agent
   *  replied" chip. 0 = no chip. Ops set only (the parent passes 0 otherwise). */
  unreadCount: number;
  /** When true, the screen is in multi-select mode — render the checkbox and
   *  let tap toggle selection. The actual selection logic lives in the parent. */
  selectMode: boolean;
  selected: boolean;
}) {
  const status = delivery.current_status ?? 'pending';
  const showFollowup = followup && SOFT_STATUSES.has(status);
  const carriedLabel = rolledFromLabel(delivery);
  return (
    <Card dense onPress={onPress} onLongPress={onLongPress}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        {selectMode ? (
          <View
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: 2,
              borderColor: selected ? colors.black : colors.border,
              backgroundColor: selected ? colors.black : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 2,
            }}
          >
            {selected ? <Icon name="check" size={14} color={colors.white} /> : null}
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          {showClient && delivery.client_name ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: colors.textSecondary,
                marginBottom: 2,
              }}
              numberOfLines={1}
            >
              {delivery.client_name}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text
              style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
              numberOfLines={1}
            >
              {delivery.customer_name}
            </Text>
            {unreadCount > 0 ? (
              <View
                accessibilityLabel={`${unreadCount} unread message${unreadCount === 1 ? '' : 's'} from the agent`}
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
            {showFollowup ? (
              <View
                accessibilityLabel={`${followup!.holder_name} is handling the follow-up`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: colors.infoSoft,
                  borderRadius: 999,
                }}
              >
                <Avatar user={{ display_name: followup!.holder_name }} size={16} />
                <Text style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.infoDark }}>
                  {followup!.holder_name.split(/\s+/)[0]}
                </Text>
              </View>
            ) : null}
            {delivery.latest_notified ? (
              <View
                accessibilityLabel="Client has been notified of the latest status"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  backgroundColor: colors.successSoft,
                  borderRadius: 999,
                }}
              >
                <Icon name="check" size={10} color={colors.successDark} />
                <Text
                  style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.successDark }}
                >
                  Notified
                </Text>
              </View>
            ) : null}
            <StatusPill status={status} variant="subtle" size="sm" />
          </View>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {deliveryProductsLabel(delivery)}
            {delivery.location_name ? ` · ${delivery.location_name}` : ` · `}
            {!delivery.location_name ? (
              <Text style={{ color: colors.red, fontFamily: fonts.bold }}>Unmatched</Text>
            ) : null}
          </Text>
          {carriedLabel ? (
            <View
              accessibilityLabel={`Carried over — ${carriedLabel}`}
              style={{
                marginTop: 5,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                alignSelf: 'flex-start',
                backgroundColor: colors.warningSoft,
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 999,
              }}
            >
              <Icon name="refresh" size={11} color={colors.warningDark} />
              <Text
                numberOfLines={1}
                style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.warningDark }}
              >
                {carriedLabel}
              </Text>
            </View>
          ) : null}
          {status === 'postponed' && delivery.scheduled_date ? (
            <View
              accessibilityLabel={`Postponed to ${formatYmdShort(delivery.scheduled_date)}`}
              style={{
                marginTop: 5,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                alignSelf: 'flex-start',
                backgroundColor: colors.warningSoft,
                paddingHorizontal: 7,
                paddingVertical: 2,
                borderRadius: 999,
              }}
            >
              <Icon name="calendar" size={11} color={colors.warningDark} />
              <Text
                numberOfLines={1}
                style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.warningDark }}
              >
                Postponed to {formatYmdShort(delivery.scheduled_date)}
              </Text>
            </View>
          ) : null}
          <View
            style={{
              marginTop: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {delivery.assigned_agent_name ? (
                <>
                  <Avatar user={{ display_name: delivery.assigned_agent_name }} size={20} />
                  <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.black }}>
                    {delivery.assigned_agent_name.split(/\s+/)[0]}
                  </Text>
                </>
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
            <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
              {formatNaira(delivery.customer_price)}
            </Text>
          </View>
        </View>
      </View>
    </Card>
  );
});

// Stable references for FlatList — passing fresh inline functions/objects
// every render defeats the virtualiser's diff.
function keyForDelivery(d: DeliveryRow): string {
  return d.id ?? Math.random().toString();
}
function SeparatorH8() {
  return <View style={{ height: 8 }} />;
}

const DATE_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'custom', label: 'Custom' },
  { id: 'all', label: 'All dates' },
];

function subtitleFor(preset: DatePreset, customDate: string): string {
  switch (preset) {
    case 'today':
      return 'Today';
    case 'yesterday':
      return 'Yesterday';
    case 'custom':
      return customDate;
    case 'all':
      return 'All dates';
  }
}

function emptySubtitle(
  preset: DatePreset,
  customDate: string,
  agentName: string | null,
  nameQuery: string | null,
): string {
  const when =
    preset === 'today'
      ? 'today'
      : preset === 'yesterday'
        ? 'yesterday'
        : preset === 'custom'
          ? customDate
          : 'any date';
  if (nameQuery && agentName) {
    return `No deliveries matching "${nameQuery}" for ${agentName} on ${when}. Try clearing the search or agent filter.`;
  }
  if (nameQuery) {
    return `No deliveries matching "${nameQuery}" on ${when}. Try clearing the search or switching dates.`;
  }
  if (agentName) {
    return `No deliveries for ${agentName} on ${when}. Try clearing the agent filter or switching dates.`;
  }
  switch (preset) {
    case 'today':
      return 'No deliveries scheduled for today. New orders show up here when the bot creates them or you add one with the red + button.';
    case 'yesterday':
      return 'No deliveries scheduled for yesterday.';
    case 'custom':
      return `No deliveries scheduled for ${customDate}. Try a different date.`;
    case 'all':
      return 'No deliveries yet across all dates. Switch filters above or tap the red + button to create one.';
  }
}

/** Compact dropdown that opens a bottom-sheet list of active agents.
 *  Ops set (admin + dispatcher + rep) — gated by `canFilterDeliveriesList(role)`
 *  at the call site. `value=null` means "All agents". No "Unassigned" entry —
 *  that's the status segment's job; keeping them orthogonal avoids two paths to
 *  the same filter. */
function AgentPicker({
  value,
  agents,
  onChange,
  loading,
}: {
  value: string | null;
  agents: AppUser[];
  onChange: (v: string | null) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = agents.find((a) => a.id === value) ?? null;
  const triggerLabel = loading
    ? 'Loading agents…'
    : selected
      ? `Agent: ${selected.display_name}`
      : 'Agent: All agents';
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          if (!loading) setOpen(true);
        }}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Filter by agent"
        style={({ pressed }) => [
          {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.white,
          },
          pressed && { opacity: 0.9 },
        ]}
      >
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontFamily: fonts.semibold,
            fontSize: 13,
            color: selected ? colors.black : colors.textSecondary,
          }}
        >
          {triggerLabel}
        </Text>
        <Icon name="chevronDown" size={16} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(10,10,10,0.42)', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: colors.white,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingBottom: 24,
              maxHeight: '70%',
            }}
            onPress={() => undefined}
          >
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <View
                style={{ width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2 }}
              />
            </View>
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 13,
                color: colors.textSecondary,
                textTransform: 'uppercase',
                letterSpacing: 0.8,
                paddingHorizontal: 20,
                paddingTop: 8,
                paddingBottom: 8,
              }}
            >
              Filter by agent
            </Text>
            <FlatList
              data={[null as string | null, ...agents.map((a) => a.id)]}
              keyExtractor={(v) => v ?? '__all__'}
              renderItem={({ item }) => {
                const a = item ? agents.find((x) => x.id === item) : null;
                const label = a ? a.display_name : 'All agents';
                const active = (value ?? null) === item;
                return (
                  <Pressable
                    onPress={() => {
                      onChange(item);
                      setOpen(false);
                    }}
                    style={({ pressed }) => [
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 20,
                        paddingVertical: 14,
                      },
                      active && { backgroundColor: colors.surface },
                      pressed && { opacity: 0.88 },
                    ]}
                  >
                    <Text
                      style={{
                        flex: 1,
                        fontFamily: fonts.semibold,
                        fontSize: 15,
                        color: colors.black,
                      }}
                    >
                      {label}
                    </Text>
                    {active ? <Icon name="check" size={18} color={colors.black} /> : null}
                  </Pressable>
                );
              }}
              ItemSeparatorComponent={() => (
                <View style={{ height: 1, backgroundColor: colors.border }} />
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
