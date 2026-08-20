import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  useClients,
  useDeliveriesList,
  useFailedDeliveryOutcomes,
  useOpsUnread,
  usePostponedDeliveries,
  useUnassignedDeliveries,
  useUsers,
} from '@/hooks/queries';
import {
  rolledFromLabel,
  FAILED_DELIVERIES_LIMIT,
  SEARCH_LIMIT,
  ALL_DATES_LIMIT,
  type DeliveryRow,
  type FailedDeliveryRow,
} from '@/services/deliveries';
import { listActiveFollowups, type ActiveFollowup } from '@/services/followups';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { type AppUser } from '@/services/users';
import { type Client } from '@/services/clients';
import {
  canBulkAssignDelivery,
  canBulkChangeStatus,
  canBulkDeleteDeliveries,
  canBulkMarkClientNotified,
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
  DateField,
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
import { BulkNotifySheet } from '@/components/sheets/BulkNotifySheet';
import type { BulkNotifyCounts } from '@/services/clientNotifications';
import {
  colors,
  fonts,
  statusBucket,
  isAssignedActive,
  awaitsClientNotification,
  STATUS_GROUPS,
  STATUS_META,
} from '@/lib/theme';
import {
  daysAgoLagos,
  formatDateTimeLagos,
  formatRangeLagos,
  todayLagos,
  yesterdayLagos,
  ymdLagos,
  isYmd,
} from '@/lib/date';

const SOFT_STATUSES = new Set<string>(STATUS_GROUPS.soft);
// Stable empty map so rows don't see a fresh object (→ re-render) before the
// unread query resolves.
const EMPTY_UNREAD: ReadonlyMap<string, number> = new Map();

// --- Unassigned grouping --------------------------------------------------
// On the Unassigned tab the queue is grouped by the prior-day snapshot
// (rolled_from_status): all "Not picking" together, all "Tomorrow" together,
// etc., with the never-attempted/new orders in their own group. Same soft-only
// gate as the carried-over badge, so a grouped row always shows its matching
// badge. Carried groups come first (in the status defs' natural order, so the
// unreachable statuses sit together and the deferrals sit together), New last.
type UnassignedGroupHeader = { label: string; count: number; carried: boolean };
type LocationFilterOption = { id: string; name: string; count: number };
const NEW_ORDERS_GROUP = '__new__';
const UNMATCHED_LOCATION = '__unmatched_location__';
const EMPTY_HEADER_MAP: ReadonlyMap<string, UnassignedGroupHeader> = new Map();
// Stable empty selection so an unchanged "All locations" state doesn't hand the
// unassigned memo a fresh Set (→ needless recompute) each render.
const EMPTY_LOCATION_IDS: ReadonlySet<string> = new Set();

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
// Single source of truth for the chip ids: the `Filter` union and the runtime
// validation set are both derived from this, so adding a filter is a one-line edit.
const FILTER_IDS_LIST = [
  'all',
  'to_notify',
  'unread',
  'active',
  'available',
  'soft',
  'postponed',
  'done',
  'failed',
  'unassigned',
] as const;
type Filter = (typeof FILTER_IDS_LIST)[number];
const FILTER_IDS = new Set<string>(FILTER_IDS_LIST);
type DatePreset = 'today' | 'yesterday' | 'custom' | 'all';
type FailedDatePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';
type FailedKindFilter = 'attempted' | 'auto_closed';

export function DeliveriesList({ basePath }: { basePath: BasePath }) {
  const user = useCurrentUser();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Optional deep-link target — the rep dashboard's "Awaiting client update" card
  // routes here with ?filter=to_notify. Validated against FILTER_IDS so a stray
  // param can never put the chips in an unknown state.
  const params = useLocalSearchParams<{ filter?: string; agent?: string }>();
  const [filter, setFilter] = useState<Filter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('today');
  // Persists across preset toggles so switching today → yesterday → custom
  // doesn't blank the value the user already typed.
  const [customDate, setCustomDate] = useState<string>(todayLagos());
  // Failed outcomes are event history, so they use an explicit bounded range
  // rather than the normal list's scheduled-date selector. Seven days gives a
  // useful operational default without adding a query to the regular screen.
  const [failedDatePreset, setFailedDatePreset] = useState<FailedDatePreset>('last7');
  const [failedCustomFrom, setFailedCustomFrom] = useState<string>(daysAgoLagos(6));
  const [failedCustomTo, setFailedCustomTo] = useState<string>(todayLagos());
  const [failedKind, setFailedKind] = useState<FailedKindFilter>('attempted');
  // null = "All agents". Agents see only their own deliveries server-side,
  // so the picker stays hidden for them — narrowing has no work to do.
  const [agentId, setAgentId] = useState<string | null>(null);
  // null = "All clients". Same ops-only client-side narrow as the agent picker
  // (Uzo, 2026-06-22): slice the list to one vendor to gauge their pipeline —
  // e.g. how many orders Decency has before sending more stock out.
  const [clientId, setClientId] = useState<string | null>(null);
  // Empty set = "All locations". MULTI-select, intentionally scoped to the
  // cross-date Unassigned queue: dispatch picks several areas at once (e.g. every
  // Island location), selects every visible order, then bulk-assigns the lot to
  // one rider in a single pass (Uzo, 2026-07-29).
  const [locationIds, setLocationIds] = useState<ReadonlySet<string>>(EMPTY_LOCATION_IDS);
  // Apply deep-link params then consume them: ?filter= from the dashboard "View
  // all" card, ?agent= from a tapped Agent-workload row. Consuming (setParams →
  // undefined) keeps the URL from retaining a stale filter/agent after the user
  // changes chips, and lets a repeat navigation with the same value re-trigger
  // instead of silently no-opping on an unchanged param. The agent id isn't
  // allow-list-validated (it's an arbitrary uuid) — a bogus one just yields an
  // empty list, and it only ever arrives from our own buttons.
  useEffect(() => {
    const cleared: Record<string, undefined> = {};
    if (params.filter && FILTER_IDS.has(params.filter)) {
      setFilter(params.filter as Filter);
      cleared.filter = undefined;
    }
    if (typeof params.agent === 'string' && params.agent) {
      setAgentId(params.agent);
      cleared.agent = undefined;
    }
    if (Object.keys(cleared).length > 0) router.setParams(cleared);
  }, [params.filter, params.agent, router]);
  // The list-narrowing affordances — customer-name search, agent picker, and
  // client picker — all share one audience: the full ops set (admin +
  // dispatcher + rep). Reps coordinate with vendors and asked to scan "show me
  // Tunde's queue" / "show me Decency's orders" the same way managers do — these
  // are client-side filters, not the manager-only assign action. One gate so the
  // three can never drift apart.
  const showListFilters = canFilterDeliveriesList(user.role);
  // Multi-select bulk reassign — Uzo's morning queue flow. Admin + dispatcher
  // only (canBulkAssignDelivery). Long-press a row to enter select mode; in
  // select mode rows toggle selection on tap and the bottom action bar
  // surfaces "Assign to…". See BulkAssignSheet for the picker.
  const canBulkAssign = canBulkAssignDelivery(user.role);
  const canBulkStatus = canBulkChangeStatus(user.role);
  const canBulkDelete = canBulkDeleteDeliveries(user.role);
  // Tagging "client notified" in bulk is the rep's main list action, and it's
  // the first bulk action reps can reach — select mode used to be manager-only.
  const canBulkNotify = canBulkMarkClientNotified(user.role);
  const canBulkSelect = canBulkAssign || canBulkStatus || canBulkDelete || canBulkNotify;
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkSheetOpen, setBulkSheetOpen] = useState(false);
  const [bulkStatusSheetOpen, setBulkStatusSheetOpen] = useState(false);
  const [bulkDeleteSheetOpen, setBulkDeleteSheetOpen] = useState(false);
  const [bulkNotifySheetOpen, setBulkNotifySheetOpen] = useState(false);
  // Reps coordinate with vendors and need the client name on each row so they
  // can scan and call back without opening the detail. Agents have a separate
  // screen (`(agent)/today/index.tsx`) — this gate is defensive in case the
  // shared list is ever wired into an agent route.
  const showClient = canSeeClientName(user.role);
  const [nameQuery, setNameQuery] = useState('');
  const nameNeedle = nameQuery.trim().toLowerCase();

  // Debounce the needle for the SERVER query. A search runs server-side across
  // ALL dates (you search because you don't know the date) and is index-backed
  // (pg_trgm) + bounded, so it scales as the table grows instead of loading
  // everything to filter on-device. The instant nameNeedle still refines the
  // already-loaded list below for snappiness while the debounce settles.
  const [debouncedNeedle, setDebouncedNeedle] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedNeedle(nameNeedle), 300);
    return () => clearTimeout(t);
  }, [nameNeedle]);

  // Derive the filter passed to the service. Mirrors the reconcile pattern.
  // `search` overrides the date scope server-side when present.
  const listFilters = useMemo(() => {
    const search = debouncedNeedle || null;
    switch (datePreset) {
      case 'today':
        return { date: todayLagos(), search };
      case 'yesterday':
        return { date: yesterdayLagos(), search };
      case 'custom':
        return { date: customDate, search };
      case 'all':
        return { allDates: true, search };
    }
  }, [datePreset, customDate, debouncedNeedle]);

  const failedRange = useMemo(() => {
    switch (failedDatePreset) {
      case 'today': {
        const day = todayLagos();
        return { from: day, to: day, valid: true };
      }
      case 'yesterday': {
        const day = yesterdayLagos();
        return { from: day, to: day, valid: true };
      }
      case 'last7':
        return { from: daysAgoLagos(6), to: todayLagos(), valid: true };
      case 'last30':
        return { from: daysAgoLagos(29), to: todayLagos(), valid: true };
      case 'custom':
        return {
          from: failedCustomFrom,
          to: failedCustomTo,
          valid:
            isYmd(failedCustomFrom) && isYmd(failedCustomTo) && failedCustomFrom <= failedCustomTo,
        };
    }
  }, [failedDatePreset, failedCustomFrom, failedCustomTo]);

  // Cached delivery list (audit Phase 2.4): keyed by role + the normalized
  // filter, so detail→back within staleTime is a cache hit and each date/search
  // scope keeps its own entry. `fetching` drives the pull-to-refresh spinner;
  // `refetchIfStale` (wired to focus below) only re-downloads once the cache has
  // aged past the list staleTime. Delivery mutations invalidate ['deliveries']
  // so live changes still land immediately.
  const { data, loading, error, reload, fetching, refetchIfStale } = useDeliveriesList(
    user.role,
    listFilters,
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
  //
  // [Egress Phase 4.1] Cached + shared with RepDashboard (one fetch, not two),
  // and served by the grouped RPC. Still NOT date-scoped: allRows merges
  // cross-date rows (a postponed order shows on its postpone day while its
  // scheduled_date is already bumped forward; Unassigned is date-independent),
  // and the chip is allRows ∩ this map — a date scope would strip those chips.
  // Reps don't handle 'not my route' (admin/dispatcher reassign job), so it's
  // excluded from their chip (not_my_route_admin_only.sql).
  const unreadQ = useOpsUnread({
    excludeNotMyRoute: user.role === 'rep',
    enabled: canSeeClaims,
  });

  // Every postponed order, across ALL dates, ordered by postpone-to date. Drives
  // the dedicated "Postponed" filter — a separate query because the main list is
  // date-scoped, while postponed orders scatter across future dates. Ops-wide
  // (RLS-scoped); see listPostponed.
  const postponedQ = usePostponedDeliveries(user.role, { enabled: canSeeClaims });

  // Every unassigned, still-open delivery across ALL dates. Like Postponed, this
  // is its OWN query — the Unassigned chip is deliberately date-INDEPENDENT (a
  // row waiting for an agent is queue work no matter its scheduled_date) and
  // never shows terminal rows (both enforced server-side in listUnassigned).
  // Ops-wide (RLS-scoped); empty for agents.
  const unassignedQ = useUnassignedDeliveries(user.role, { enabled: canSeeClaims });

  // Dedicated server query: only mounted while Failed is selected. Agent,
  // client and search are sent to the RPC so a 30-day audit never downloads a
  // broad result just to throw most rows away on-device.
  const failedQ = useFailedDeliveryOutcomes(
    {
      from: failedRange.from,
      to: failedRange.to,
      kind: failedKind,
      agentId,
      clientId,
      search: debouncedNeedle || null,
    },
    { enabled: canSeeClaims && filter === 'failed' && failedRange.valid },
  );

  // Roster for the agent picker. Cached ['users'] hook (audit Phase 2.4b) — one
  // shared fetch across every screen, invalidated by user mutations; skipped for
  // roles that never render the picker (agents).
  const agentsQ = useUsers({ enabled: showListFilters });
  const agents = useMemo(() => {
    return (agentsQ.data ?? [])
      .filter((u) => u.role === 'agent' && u.is_active)
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
  }, [agentsQ.data]);
  // Active clients for the client picker (cached ['clients'] hook — active-only,
  // name-sorted, shared + invalidated by client mutations). Same gate as the
  // agent picker; agents can't read clients (anti-poaching RLS) but the picker
  // never renders for them anyway.
  const clientsQ = useClients({ enabled: showListFilters });
  const clients = useMemo(() => clientsQ.data ?? [], [clientsQ.data]);
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
  // Location-filter toggles for the Unassigned queue. Changing the location set
  // drops any in-progress row selection (a hidden row must never stay selected
  // once the visible pool shifts under the action bar) — same reason the picker
  // used to clear it inline.
  const toggleLocation = useCallback(
    (id: string) => {
      exitSelect();
      setLocationIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [exitSelect],
  );
  const clearLocations = useCallback(() => {
    exitSelect();
    setLocationIds(EMPTY_LOCATION_IDS);
  }, [exitSelect]);
  const onBulkAssigned = useCallback(
    (updated: number) => {
      setBulkSheetOpen(false);
      exitSelect();
      setLocationIds(EMPTY_LOCATION_IDS);
      reload();
      postponedQ.reload();
      unassignedQ.reload();
      const msg = `Assigned ${updated} ${updated === 1 ? 'delivery' : 'deliveries'}.`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert('Done', msg);
      }
    },
    [exitSelect, reload, postponedQ, unassignedQ],
  );
  const onBulkStatusChanged = useCallback(
    (counts: { changedCount: number; skippedCount: number }) => {
      setBulkStatusSheetOpen(false);
      exitSelect();
      setLocationIds(EMPTY_LOCATION_IDS);
      reload();
      postponedQ.reload();
      unassignedQ.reload();
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
    [exitSelect, reload, postponedQ, unassignedQ],
  );
  const onBulkDeleted = useCallback(
    (counts: { deletedCount: number; skippedCount: number }) => {
      setBulkDeleteSheetOpen(false);
      exitSelect();
      setLocationIds(EMPTY_LOCATION_IDS);
      reload();
      postponedQ.reload();
      unassignedQ.reload();
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
    [exitSelect, reload, postponedQ, unassignedQ],
  );
  const onBulkNotified = useCallback(
    (counts: BulkNotifyCounts) => {
      setBulkNotifySheetOpen(false);
      exitSelect();
      reload();
      // Rows are independent, so report what actually landed rather than a
      // flat "done": a peer beating you to a row and a server refusal are
      // different outcomes and only one of them is worth acting on.
      const parts = [`Tagged ${counts.notified}`];
      if (counts.alreadyTagged > 0) parts.push(`${counts.alreadyTagged} already done`);
      if (counts.failed > 0) parts.push(`${counts.failed} failed`);
      const msg = `${parts.join(', ')}.${counts.firstError ? `\n${counts.firstError}` : ''}`;
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert(msg);
      } else {
        Alert.alert(counts.failed > 0 ? 'Partly done' : 'Done', msg);
      }
    },
    [exitSelect, reload],
  );

  useReloadOnFocus(() => {
    // Stale-aware on focus: a list still within staleTime is served from cache
    // (the back-navigation egress win); only an aged list re-downloads. The
    // overlays still force-refresh so their pills stay live — cheap now that
    // unread is the grouped RPC (~1 row, Phase 4.1) and followups is uncached
    // but small; both are realtime-backed anyway.
    if (filter === 'failed') {
      failedQ.refetchIfStale();
      if (canSeeClaims) {
        followupsQ.reload();
        unreadQ.reload();
      }
      return;
    }
    refetchIfStale();
    if (canSeeClaims) {
      followupsQ.reload();
      unreadQ.reload();
      postponedQ.refetchIfStale();
      unassignedQ.refetchIfStale();
    }
  });

  // Selection belongs to the current list scope. Changing status/date filters
  // clears it so a hidden row can never remain selected after the visible pool
  // changes underneath the action bar.
  useEffect(() => {
    exitSelect();
  }, [
    filter,
    datePreset,
    customDate,
    failedDatePreset,
    failedCustomFrom,
    failedCustomTo,
    failedKind,
    agentId,
    clientId,
    nameNeedle,
    exitSelect,
  ]);

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
  //
  // [Egress Phase 4.1] COALESCED. The subscription is deliberately unfiltered
  // (any ops user must see any agent's reply), so it fires on every message
  // change system-wide. mark_messages_read() flips read_at one row at a time, so
  // opening a 5-message thread emitted 5 events → 5 back-to-back refetches of
  // the whole map, on every connected ops device: reading messages generated the
  // traffic. A trailing debounce collapses each burst into one refetch. 250 ms is
  // well under human-perceptible for a chip and is the audit's recommended
  // 100–300 ms window (finding 7, Stage A).
  const unreadReloadRef = useRef(unreadQ.reload);
  unreadReloadRef.current = unreadQ.reload;
  const unreadBurst = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (unreadBurst.current) clearTimeout(unreadBurst.current);
    },
    [],
  );
  useSupabaseChannel(
    canSeeClaims ? 'deliveries-list-unread' : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_messages' },
        () => {
          if (unreadBurst.current) clearTimeout(unreadBurst.current);
          unreadBurst.current = setTimeout(() => {
            unreadBurst.current = null;
            unreadReloadRef.current();
          }, 250);
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
  // (Active/Soft/Done) reflect just the slice the user is looking at — matches
  // the intent of "show me Tunde's pending for Mr Adeyemi". The Unassigned count
  // is exempt: it's the separate unassignedRows slice, which no agent narrow
  // touches (unassigned rows have no agent). Name match is a case-insensitive
  // substring on customer_name.
  const all = useMemo(() => {
    let rows = data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (clientId) rows = rows.filter((d) => d.client_id === clientId);
    if (nameNeedle)
      rows = rows.filter(
        (d) =>
          (d.customer_name ?? '').toLowerCase().includes(nameNeedle) ||
          (d.customer_phone ?? '').toLowerCase().includes(nameNeedle),
      );
    return rows;
  }, [data, agentId, clientId, nameNeedle]);
  const buckets = useMemo(
    () => ({
      all,
      // Cross-cutting slice: latest status the client hasn't been told about yet.
      // The shared predicate also applies per-client policy (auto-cancel clients
      // do not receive failed_delivery updates).
      // (shared predicate with the rep dashboard card). Orthogonal to the status
      // buckets below — a "To notify" row can be available, soft-fail, delivered, …
      to_notify: all.filter(awaitsClientNotification),
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
      // NB: Unassigned is NOT bucketed here — it's a separate cross-date query
      // (unassignedRows below), date-independent and terminal-free, per Uzo.
    }),
    [all],
  );

  // Build the location menu directly from the unassigned payload. Every list
  // row already carries location_id + location_name, so this adds no query or
  // database function. Counts make the dispatch split visible before selection;
  // the unmatched bucket keeps orders whose address still needs correction from
  // becoming impossible to find.
  const locationOptions = useMemo<LocationFilterOption[]>(() => {
    const byId = new Map<string, LocationFilterOption>();
    for (const row of unassignedQ.data ?? []) {
      const id = row.location_id ?? UNMATCHED_LOCATION;
      const existing = byId.get(id);
      if (existing) {
        existing.count += 1;
      } else {
        byId.set(id, {
          id,
          name: row.location_name ?? 'Unmatched location',
          count: 1,
        });
      }
    }
    return [...byId.values()].sort((a, b) => {
      if (a.id === UNMATCHED_LOCATION) return 1;
      if (b.id === UNMATCHED_LOCATION) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [unassignedQ.data]);
  const locationFilterActive = locationIds.size > 0;
  // Human label for the active location narrow — drives the empty-state copy.
  const selectedLocationsLabel =
    locationIds.size === 0
      ? null
      : locationIds.size === 1
        ? (locationOptions.find((location) => locationIds.has(location.id))?.name ??
          'this location')
        : `${locationIds.size} locations`;

  // Unassigned is a separate cross-date slice (its own query), narrowed by the
  // same client + name filters as the date-scoped list plus its location picker.
  // The agent picker is intentionally NOT applied here: an unassigned row has no
  // agent, so any agent narrow empties the list. Ignoring a leftover agentId
  // (set on another tab) keeps the queue visible when the user switches over.
  const unassignedRows = useMemo(() => {
    let rows = unassignedQ.data ?? [];
    if (clientId) rows = rows.filter((d) => d.client_id === clientId);
    if (locationIds.size > 0) {
      rows = rows.filter((d) => locationIds.has(d.location_id ?? UNMATCHED_LOCATION));
    }
    if (nameNeedle)
      rows = rows.filter(
        (d) =>
          (d.customer_name ?? '').toLowerCase().includes(nameNeedle) ||
          (d.customer_phone ?? '').toLowerCase().includes(nameNeedle),
      );
    return rows;
  }, [unassignedQ.data, clientId, locationIds, nameNeedle]);

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
    const decorated = unassignedRows.map((row) => {
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
  }, [filter, unassignedRows]);

  // Postponed is a separate cross-date slice (its own query), narrowed by the
  // same agent + name filters as the date-scoped list so the counts and the
  // picker behave consistently.
  const postponedRows = useMemo(() => {
    let rows = postponedQ.data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (clientId) rows = rows.filter((d) => d.client_id === clientId);
    if (nameNeedle)
      rows = rows.filter(
        (d) =>
          (d.customer_name ?? '').toLowerCase().includes(nameNeedle) ||
          (d.customer_phone ?? '').toLowerCase().includes(nameNeedle),
      );
    return rows;
  }, [postponedQ.data, agentId, clientId, nameNeedle]);

  // "To notify" must include postponed orders even when they're scheduled for a
  // FUTURE date (Uzo, 2026-06-20): postpone moves scheduled_date forward in place,
  // so those rows fall outside the date-scoped `all` and would otherwise never
  // reach the notify predicate. Merge the cross-date postponed slice in, deduped
  // by id (today's postponed already sit in buckets.to_notify), each still gated
  // by awaitsClientNotification so already-notified rows stay out.
  const toNotifyRows = useMemo(() => {
    const seen = new Set<string>();
    const out: DeliveryRow[] = [];
    for (const d of [...buckets.to_notify, ...postponedRows]) {
      if (!awaitsClientNotification(d)) continue;
      const rid = d.id;
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      out.push(d);
    }
    return out;
  }, [buckets.to_notify, postponedRows]);

  // The single calendar day currently in view, or null when there's no single-day
  // scope (All dates) or a search is active (search spans all dates). Mirrors the
  // server `listFilters.date`. Drives the postpone-day merge into All below.
  const viewDate = useMemo(() => {
    if (debouncedNeedle) return null;
    switch (datePreset) {
      case 'today':
        return todayLagos();
      case 'yesterday':
        return yesterdayLagos();
      case 'custom':
        return isYmd(customDate) ? customDate : null;
      default:
        return null; // 'all'
    }
  }, [datePreset, customDate, debouncedNeedle]);

  // "All" = the date-scoped rows, PLUS any postponed order whose POSTPONE DAY is
  // the day being viewed (Uzo, 2026-06-28). Postpone bumps scheduled_date forward
  // in place, so a just-postponed order would otherwise vanish from All the moment
  // you push it — this keeps it visible in All on the day you postponed it. It
  // reappears in All on its due date naturally (via the date-scoped fetch), and on
  // the days in between it lives only under the Postponed chip. The postpone day =
  // latest_changed_at: a postponed row's current status was entered at its last
  // status change (verified invariant). No merge in All-dates/search (no single
  // day). Deduped by id (a due-date row is already in buckets.all).
  const allRows = useMemo(() => {
    if (!viewDate) return buckets.all;
    const seen = new Set(buckets.all.map((d) => d.id));
    const extra = postponedRows.filter(
      (p) => p.id && !seen.has(p.id) && ymdLagos(p.latest_changed_at) === viewDate,
    );
    return extra.length > 0 ? [...buckets.all, ...extra] : buckets.all;
  }, [buckets.all, postponedRows, viewDate]);

  // Deliveries with an unread agent message — the per-row "agent replied" chip,
  // promoted to a list filter. Built from the on-screen rows (allRows) ∩ the
  // unread map so the count matches what's visible (the map itself isn't
  // date-scoped — see opsUnreadAgentCounts). Ops only; read state is team-shared.
  const unreadRows = useMemo(
    () => allRows.filter((d) => (d.id ? (unreadByDelivery.get(d.id) ?? 0) > 0 : false)),
    [allRows, unreadByDelivery],
  );

  const failedRows = failedQ.data ?? [];

  const list =
    filter === 'postponed'
      ? postponedRows
      : filter === 'to_notify'
        ? toNotifyRows
        : filter === 'unread'
          ? unreadRows
          : filter === 'all'
            ? allRows
            : filter === 'unassigned'
              ? (unassignedSorted ?? unassignedRows)
              : filter === 'failed'
                ? failedRows
                : buckets[filter];

  const visibleIds = useMemo(() => list.flatMap((d) => (d.id ? [d.id] : [])), [list]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  // The location picker is a queue-building tool: once dispatch has chosen the
  // areas, the next intended action is always a bulk operation on that entire
  // result. Select the current result directly from the sheet instead of making
  // the user close it, reveal the rows, and tap a second "Select all" button.
  // Replace (rather than merge) the selection so hidden/stale rows can never be
  // carried into the next bulk action.
  const selectAllVisible = useCallback(() => {
    if (visibleIds.length === 0) return;
    setSelectMode(true);
    setSelectedIds(new Set(visibleIds));
  }, [visibleIds]);
  const toggleSelectAllVisible = useCallback(() => {
    setSelectMode(true);
    setSelectedIds((previous) => {
      if (visibleIds.length === 0) return previous;
      const next = new Set(previous);
      const everyVisibleSelected = visibleIds.every((id) => next.has(id));
      if (everyVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, [visibleIds]);

  // Resolve IDs from the list currently visible on screen. This includes the
  // separate cross-date Postponed query and postponed rows merged into All, so
  // bulk status/delete previews receive the same rows the user highlighted.
  const selectedRows = useMemo<DeliveryRow[]>(() => {
    if (!selectMode || selectedIds.size === 0) return [];
    return list.filter((d) => d.id && selectedIds.has(d.id));
  }, [list, selectMode, selectedIds]);
  const filterOptions = [
    { id: 'all' as const, label: 'All', count: allRows.length },
    { id: 'to_notify' as const, label: 'To notify', count: toNotifyRows.length },
    ...(canSeeClaims ? [{ id: 'unread' as const, label: 'Unread', count: unreadRows.length }] : []),
    { id: 'active' as const, label: 'Active', count: buckets.active.length },
    { id: 'available' as const, label: 'Available', count: buckets.available.length },
    { id: 'soft' as const, label: 'Soft fail', count: buckets.soft.length },
    { id: 'postponed' as const, label: 'Postponed', count: postponedRows.length },
    { id: 'done' as const, label: 'Done', count: buckets.done.length },
    { id: 'failed' as const, label: 'Failed' },
    { id: 'unassigned' as const, label: 'Unassigned', count: unassignedRows.length },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {selectMode ? (
        <AppBar
          title={`${selectedRows.length} selected`}
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
        <AppBar
          title="Deliveries"
          subtitle={
            filter === 'failed'
              ? failedRangeSubtitle(failedDatePreset, failedRange.from, failedRange.to)
              : nameNeedle
                ? 'Searching all dates'
                : subtitleFor(datePreset, customDate)
          }
        />
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
          options={filter === 'failed' ? FAILED_DATE_OPTIONS : DATE_OPTIONS}
          value={filter === 'failed' ? failedDatePreset : datePreset}
          onChange={(v) => {
            exitSelect();
            if (filter === 'failed') setFailedDatePreset(v as FailedDatePreset);
            else setDatePreset(v as DatePreset);
          }}
        />
        {filter === 'failed' && failedDatePreset === 'custom' ? (
          <View
            style={{
              paddingHorizontal: 16,
              paddingBottom: 8,
              flexDirection: 'row',
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <DateField
                label="From"
                value={failedCustomFrom}
                onChange={(value) => {
                  exitSelect();
                  setFailedCustomFrom(value);
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <DateField
                label="To"
                value={failedCustomTo}
                onChange={(value) => {
                  exitSelect();
                  setFailedCustomTo(value);
                }}
              />
            </View>
          </View>
        ) : filter !== 'failed' && datePreset === 'custom' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <DateField
              label="Date"
              value={customDate}
              onChange={(value) => {
                exitSelect();
                setCustomDate(value);
              }}
            />
          </View>
        ) : null}
        <FilterChips
          options={filterOptions}
          value={filter}
          onChange={(value) => {
            exitSelect();
            setFilter(value);
          }}
        />
        {filter === 'failed' ? (
          <View>
            <Text
              style={{
                paddingHorizontal: 16,
                paddingTop: 2,
                fontFamily: fonts.bold,
                fontSize: 10,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: colors.textSecondary,
              }}
            >
              Outcome type
            </Text>
            <FilterChips
              options={[
                {
                  id: 'attempted',
                  label: 'Attempted',
                },
                {
                  id: 'auto_closed',
                  label: 'Auto-closed',
                },
              ]}
              value={failedKind}
              onChange={setFailedKind}
            />
          </View>
        ) : null}
        {showListFilters ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
            <Input
              icon="search"
              value={nameQuery}
              onChange={(value) => {
                exitSelect();
                setNameQuery(value);
              }}
              placeholder={
                filter === 'failed'
                  ? 'Search failed orders by name or phone'
                  : 'Search name or phone (all dates)'
              }
              autoCapitalize="none"
              autoCorrect={false}
              rightAdornment={
                nameQuery ? (
                  <Pressable
                    onPress={() => {
                      exitSelect();
                      setNameQuery('');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                    hitSlop={8}
                  >
                    <Icon name="x" size={16} color={colors.textSecondary} />
                  </Pressable>
                ) : null
              }
            />
            {filter !== 'failed' && nameNeedle && (data?.length ?? 0) >= SEARCH_LIMIT ? (
              <Text
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 11,
                  color: colors.textSecondary,
                  marginTop: 6,
                }}
              >
                Showing the first {SEARCH_LIMIT} matches — narrow your search to see more.
              </Text>
            ) : null}
          </View>
        ) : null}
        {/* The agent picker is hidden on the Unassigned tab — those rows have no
            agent, so narrowing by agent can only ever empty the list (Uzo,
            2026-07-29). This also drops Unassigned back to two filters (client +
            location), matching every other tab. */}
        {showListFilters && filter !== 'unassigned' ? (
          <AgentPicker
            value={agentId}
            agents={agents}
            loading={agentsQ.loading}
            onChange={(value) => {
              exitSelect();
              setAgentId(value);
            }}
          />
        ) : null}
        {showListFilters ? (
          <ClientPicker
            value={clientId}
            clients={clients}
            loading={clientsQ.loading}
            onChange={(value) => {
              exitSelect();
              setClientId(value);
            }}
          />
        ) : null}
        {showListFilters && filter === 'unassigned' ? (
          <LocationPicker
            selectedIds={locationIds}
            locations={locationOptions}
            visibleOrderCount={visibleIds.length}
            loading={unassignedQ.loading}
            onToggle={toggleLocation}
            onClear={clearLocations}
            onSelectAll={canBulkSelect ? selectAllVisible : undefined}
          />
        ) : null}
        {!selectMode && canBulkSelect && filter === 'unassigned' && visibleIds.length > 0 ? (
          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Button variant="secondary" size="sm" full onPress={toggleSelectAllVisible}>
              {`Select all ${visibleIds.length} visible`}
            </Button>
          </View>
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
                failure={filter === 'failed' ? (item as FailedDeliveryRow) : undefined}
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
                  canBulkSelect && filter !== 'failed' && itemId
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
              filter === 'failed'
                ? failedQ.fetching && !!failedQ.data
                : filter === 'postponed'
                  ? postponedQ.fetching && !!postponedQ.data
                  : filter === 'unassigned'
                    ? unassignedQ.fetching && !!unassignedQ.data
                    : fetching && !!data
            }
            onRefresh={() => {
              if (filter === 'failed') {
                failedQ.reload();
                return;
              }
              reload();
              postponedQ.reload();
              unassignedQ.reload();
            }}
            tintColor={colors.black}
          />
        }
        contentContainerStyle={{
          padding: 16,
          paddingBottom: selectMode ? 132 + insets.bottom : 96,
          flexGrow: 1,
        }}
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        ListFooterComponent={
          filter === 'failed' && (failedQ.data?.length ?? 0) >= FAILED_DELIVERIES_LIMIT ? (
            <Text
              style={{
                textAlign: 'center',
                color: colors.textSecondary,
                fontFamily: fonts.medium,
                fontSize: 12,
                paddingVertical: 16,
              }}
            >
              Showing the {FAILED_DELIVERIES_LIMIT} most recent. Narrow the date range to see older
              records.
            </Text>
          ) : // "All dates" is capped to the most recent ALL_DATES_LIMIT rows to keep
          // egress down; tell the user how to reach older orders. Only relevant to
          // the date-scoped filters (Postponed/Unassigned run their own uncapped,
          // small cross-date queries).
          datePreset === 'all' &&
            filter !== 'postponed' &&
            filter !== 'unassigned' &&
            (data?.length ?? 0) >= ALL_DATES_LIMIT ? (
            <Text
              style={{
                textAlign: 'center',
                color: colors.textSecondary,
                fontFamily: fonts.medium,
                fontSize: 12,
                paddingVertical: 16,
              }}
            >
              Showing the {ALL_DATES_LIMIT} most recent. Search a name or phone to find older
              orders.
            </Text>
          ) : null
        }
        ListEmptyComponent={
          filter === 'failed' ? (
            !failedRange.valid ? (
              <Empty
                icon="calendar"
                title="Check the date range"
                sub="Enter valid From and To dates, with From no later than To."
              />
            ) : failedQ.error ? (
              <Empty icon="alert" title="Could not load failed deliveries" sub={failedQ.error} />
            ) : failedQ.loading ? (
              <View style={{ padding: 60, alignItems: 'center' }}>
                <ActivityIndicator color={colors.black} />
              </View>
            ) : (
              <Empty
                icon="check"
                title={failedKind === 'attempted' ? 'No attempted failures' : 'Nothing here'}
                sub={
                  failedKind === 'attempted'
                    ? 'No confirmed orders ended unsuccessfully in this range. Auto-closed policy records are kept in their own tab.'
                    : 'No failed-delivery records match this range and the active filters.'
                }
              />
            )
          ) : filter === 'postponed' ? (
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
          ) : filter === 'unassigned' ? (
            unassignedQ.error ? (
              <Empty icon="alert" title="Could not load" sub={unassignedQ.error} />
            ) : unassignedQ.loading ? (
              <View style={{ padding: 60, alignItems: 'center' }}>
                <ActivityIndicator color={colors.black} />
              </View>
            ) : (
              <Empty
                icon="package"
                title={locationFilterActive ? 'No unassigned orders here' : 'Nothing unassigned'}
                sub={
                  locationFilterActive
                    ? `No open unassigned orders match ${selectedLocationsLabel ?? 'the selected locations'} and the other active filters.`
                    : 'Open orders with no agent show here, across all dates.'
                }
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
                clients.find((c) => c.id === clientId)?.name ?? null,
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
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button
                variant="secondary"
                size="sm"
                full
                onPress={toggleSelectAllVisible}
                disabled={visibleIds.length === 0}
              >
                {allVisibleSelected ? 'Clear visible' : 'Select all visible'}
              </Button>
            </View>
            {canBulkStatus ? (
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  full
                  onPress={() => setBulkStatusSheetOpen(true)}
                  disabled={selectedRows.length === 0}
                  accessibilityLabel={`Change status for ${selectedRows.length} selected`}
                >
                  Status
                </Button>
              </View>
            ) : null}
            {canBulkDelete ? (
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  full
                  icon="trash"
                  onPress={() => setBulkDeleteSheetOpen(true)}
                  disabled={selectedRows.length === 0}
                  accessibilityLabel={`Delete ${selectedRows.length} selected`}
                >
                  Delete
                </Button>
              </View>
            ) : null}
            {/* Notify sits in the secondary row only when Assign owns the
                emphasis slot below; otherwise it IS the emphasis action. */}
            {canBulkNotify && canBulkAssign ? (
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  full
                  onPress={() => setBulkNotifySheetOpen(true)}
                  disabled={selectedRows.length === 0}
                  accessibilityLabel={`Mark ${selectedRows.length} selected as client notified`}
                >
                  Notify
                </Button>
              </View>
            ) : null}
          </View>
          {/* Assign is manager-only, but select mode is now reachable by reps
              (bulk notify), so this has to be gated — an unguarded Assign would
              open a sheet whose RPC refuses them. */}
          {canBulkAssign ? (
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={() => setBulkSheetOpen(true)}
              disabled={selectedRows.length === 0}
            >
              {`Assign ${selectedRows.length}`}
            </Button>
          ) : canBulkNotify ? (
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={() => setBulkNotifySheetOpen(true)}
              disabled={selectedRows.length === 0}
            >
              {`Mark ${selectedRows.length} notified`}
            </Button>
          ) : null}
        </View>
      ) : null}

      <BulkAssignSheet
        open={bulkSheetOpen}
        deliveryIds={selectedRows.flatMap((d) => (d.id ? [d.id] : []))}
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
      <BulkNotifySheet
        open={bulkNotifySheetOpen}
        selected={selectedRows}
        onClose={() => setBulkNotifySheetOpen(false)}
        onNotified={onBulkNotified}
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
  failure,
  onPress,
  onLongPress,
  followup,
  showClient,
  unreadCount,
  selectMode,
  selected,
}: {
  delivery: DeliveryRow;
  failure?: FailedDeliveryRow;
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
  // Format the working date once per row — reused by the corner date and the
  // postponed badge (avoids re-running Intl formatting up to 3× per render).
  const dateLabel = delivery.scheduled_date ? formatYmdShort(delivery.scheduled_date) : null;
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
            {delivery.product_label}
            {delivery.location_name ? ` · ${delivery.location_name}` : ` · `}
            {!delivery.location_name ? (
              <Text style={{ color: colors.red, fontFamily: fonts.bold }}>Unmatched</Text>
            ) : null}
          </Text>
          {failure ? (
            <View
              style={{
                marginTop: 7,
                padding: 9,
                borderRadius: 10,
                backgroundColor:
                  failure.failure_kind === 'attempted' ? colors.redSoft : colors.warningSoft,
                gap: 3,
              }}
            >
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
                    fontFamily: fonts.bold,
                    fontSize: 10,
                    letterSpacing: 0.5,
                    textTransform: 'uppercase',
                    color: failure.failure_kind === 'attempted' ? colors.red : colors.warningDark,
                  }}
                >
                  {failure.failure_kind === 'attempted' ? 'Attempted' : 'Auto-closed'} ·{' '}
                  {STATUS_META[failure.failure_status]?.label ?? failure.failure_status}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 10,
                    color: colors.textSecondary,
                  }}
                >
                  {formatDateTimeLagos(failure.failed_at)}
                </Text>
              </View>
              <Text
                numberOfLines={2}
                style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.black }}
              >
                {failure.failure_reason}
              </Text>
              <Text
                numberOfLines={1}
                style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textSecondary }}
              >
                {failure.raw_address?.trim() || failure.location_name || 'Address not provided'}
              </Text>
            </View>
          ) : null}
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
          {status === 'postponed' && dateLabel ? (
            <View
              accessibilityLabel={`Postponed to ${dateLabel}`}
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
                Postponed to {dateLabel}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
              {delivery.assigned_agent_name ? (
                <>
                  <Avatar user={{ display_name: delivery.assigned_agent_name }} size={20} />
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: fonts.semibold,
                      fontSize: 12,
                      color: colors.black,
                      flexShrink: 1,
                    }}
                  >
                    {/* Full display name — show the namesake's second word (e.g. "Mummy Jerry",
                        "Mr Austin") so agents who share a first name are distinguishable. */}
                    {delivery.assigned_agent_name}
                  </Text>
                </>
              ) : (
                <Text
                  numberOfLines={1}
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    flexShrink: 1,
                  }}
                >
                  {delivery.raw_address?.trim() || delivery.location_name || 'Address not provided'}
                </Text>
              )}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              {dateLabel ? (
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 11,
                    color: colors.textTertiary,
                    marginBottom: 1,
                  }}
                >
                  {dateLabel}
                </Text>
              ) : null}
              <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                {formatNaira(delivery.customer_price)}
              </Text>
            </View>
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

const FAILED_DATE_OPTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom' },
];

function failedRangeSubtitle(preset: FailedDatePreset, from: string, to: string): string {
  switch (preset) {
    case 'today':
      return 'Failed today';
    case 'yesterday':
      return 'Failed yesterday';
    case 'last7':
      return 'Failures in the last 7 days';
    case 'last30':
      return 'Failures in the last 30 days';
    case 'custom':
      return isYmd(from) && isYmd(to) && from <= to
        ? `Failures · ${formatRangeLagos(from, to)}`
        : 'Choose a valid failure range';
  }
}

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
  clientName: string | null,
): string {
  const when =
    preset === 'today'
      ? 'today'
      : preset === 'yesterday'
        ? 'yesterday'
        : preset === 'custom'
          ? customDate
          : 'any date';
  // Compose a single message from whichever narrowers are active so any
  // combination of client / agent / name reads correctly (client first since
  // it's the broadest lens, then agent, then the free-text search).
  const narrowers: string[] = [];
  if (clientName) narrowers.push(clientName);
  if (agentName) narrowers.push(agentName);
  if (nameQuery) narrowers.push(`"${nameQuery}"`);
  if (narrowers.length > 0) {
    return `No deliveries for ${narrowers.join(' · ')} on ${when}. Try clearing the filters or switching dates.`;
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

/** Compact dropdown that opens a bottom-sheet list of active clients, with an
 *  in-sheet search box — there are dozens of vendors, so plain scrolling like
 *  the agent picker wouldn't cut it. Ops set only (gated at the call site by
 *  canFilterDeliveriesList). `value=null` means "All clients". Mirrors
 *  AgentPicker otherwise. */
function ClientPicker({
  value,
  clients,
  onChange,
  loading,
}: {
  value: string | null;
  clients: Client[];
  onChange: (v: string | null) => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = clients.find((c) => c.id === value) ?? null;
  const triggerLabel = loading
    ? 'Loading clients…'
    : selected
      ? `Client: ${selected.name}`
      : 'Client: All clients';
  const needle = q.trim().toLowerCase();
  const filtered = needle ? clients.filter((c) => c.name.toLowerCase().includes(needle)) : clients;
  const close = () => {
    setOpen(false);
    setQ('');
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          if (!loading) setOpen(true);
        }}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Filter by client"
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

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(10,10,10,0.42)', justifyContent: 'flex-end' }}
          onPress={close}
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
              Filter by client
            </Text>
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <Input
                icon="search"
                value={q}
                onChange={setQ}
                placeholder="Search clients"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <FlatList
              data={[null as string | null, ...filtered.map((c) => c.id)]}
              keyExtractor={(v) => v ?? '__all__'}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const c = item ? clients.find((x) => x.id === item) : null;
                const label = c ? c.name : 'All clients';
                const active = (value ?? null) === item;
                return (
                  <Pressable
                    onPress={() => {
                      onChange(item);
                      close();
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
              ListEmptyComponent={
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.textSecondary,
                    padding: 20,
                  }}
                >
                  No clients match “{q.trim()}”.
                </Text>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** Unassigned-queue location narrower — MULTI-select. Options and counts come
 * from the rows already loaded by listUnassigned, so the picker includes
 * inactive or unmatched locations still present in the queue without another
 * request. Dispatch picks several areas (e.g. every Island location), then the
 * sheet selects the complete filtered result in one action for bulk assignment.
 * Empty selection = "All locations". */
function LocationPicker({
  selectedIds,
  locations,
  visibleOrderCount,
  onToggle,
  onClear,
  onSelectAll,
  loading,
}: {
  selectedIds: ReadonlySet<string>;
  locations: LocationFilterOption[];
  visibleOrderCount: number;
  onToggle: (id: string) => void;
  onClear: () => void;
  onSelectAll?: () => void;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const count = selectedIds.size;
  const onlySelected = count === 1 ? (locations.find((l) => selectedIds.has(l.id)) ?? null) : null;
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? locations.filter((location) => location.name.toLowerCase().includes(needle))
    : locations;
  const triggerLabel = loading
    ? 'Loading locations…'
    : count === 0
      ? 'Location: All locations'
      : count === 1
        ? onlySelected
          ? `Location: ${onlySelected.name} (${onlySelected.count})`
          : 'Location: 1 location'
        : `Location: ${count} locations`;
  const close = () => {
    setOpen(false);
    setQ('');
  };
  const selectAllAndClose = () => {
    onSelectAll?.();
    close();
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8 }}>
      <Pressable
        onPress={() => {
          if (!loading) setOpen(true);
        }}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel="Filter unassigned orders by location"
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
            color: count > 0 ? colors.black : colors.textSecondary,
          }}
        >
          {triggerLabel}
        </Text>
        <Icon name="chevronDown" size={16} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(10,10,10,0.42)', justifyContent: 'flex-end' }}
          onPress={close}
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
              Filter unassigned by location — pick any
            </Text>
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <Input
                icon="search"
                value={q}
                onChange={setQ}
                placeholder="Search locations"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <FlatList
              style={{ flexShrink: 1 }}
              data={[null as string | null, ...filtered.map((location) => location.id)]}
              keyExtractor={(id) => id ?? '__all_locations__'}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: id }) => {
                // The lead row clears the whole selection ("All locations");
                // every other row toggles its own location in/out of the set.
                if (id === null) {
                  const active = count === 0;
                  return (
                    <Pressable
                      onPress={onClear}
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
                        All locations
                      </Text>
                      {active ? <Icon name="check" size={18} color={colors.black} /> : null}
                    </Pressable>
                  );
                }
                const location = locations.find((candidate) => candidate.id === id);
                const active = selectedIds.has(id);
                return (
                  <Pressable
                    onPress={() => onToggle(id)}
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
                      {location ? location.name : 'Unknown location'}
                    </Text>
                    {location ? (
                      <Text
                        style={{
                          fontFamily: fonts.bold,
                          fontSize: 13,
                          color: colors.textSecondary,
                          marginRight: 10,
                        }}
                      >
                        {location.count}
                      </Text>
                    ) : null}
                    {active ? <Icon name="check" size={18} color={colors.black} /> : null}
                  </Pressable>
                );
              }}
              ItemSeparatorComponent={() => (
                <View style={{ height: 1, backgroundColor: colors.border }} />
              )}
              ListEmptyComponent={
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 13,
                    color: colors.textSecondary,
                    padding: 20,
                  }}
                >
                  No locations match “{q.trim()}”.
                </Text>
              }
            />
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <Button full onPress={selectAllAndClose} disabled={visibleOrderCount === 0}>
                {visibleOrderCount === 0
                  ? `No orders to ${onSelectAll ? 'select' : 'show'}`
                  : `${onSelectAll ? 'Select all' : 'Show'} ${visibleOrderCount} ${visibleOrderCount === 1 ? 'order' : 'orders'}`}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
