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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { useCurrentUser } from '@/hooks/useAuth';
import {
  useClients,
  useDeliveriesList,
  usePostponedDeliveries,
  useUnassignedDeliveries,
  useUsers,
} from '@/hooks/queries';
import {
  rolledFromLabel,
  SEARCH_LIMIT,
  ALL_DATES_LIMIT,
  type DeliveryRow,
} from '@/services/deliveries';
import { listActiveFollowups, type ActiveFollowup } from '@/services/followups';
import { opsUnreadAgentCounts } from '@/services/delivery-messages';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { type AppUser } from '@/services/users';
import { type Client } from '@/services/clients';
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
import {
  colors,
  fonts,
  statusBucket,
  isAssignedActive,
  awaitsClientNotification,
  STATUS_GROUPS,
  STATUS_META,
} from '@/lib/theme';
import { todayLagos, yesterdayLagos, ymdLagos, isYmd } from '@/lib/date';

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
  'unassigned',
] as const;
type Filter = (typeof FILTER_IDS_LIST)[number];
const FILTER_IDS = new Set<string>(FILTER_IDS_LIST);
type DatePreset = 'today' | 'yesterday' | 'custom' | 'all';

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
  // null = "All agents". Agents see only their own deliveries server-side,
  // so the picker stays hidden for them — narrowing has no work to do.
  const [agentId, setAgentId] = useState<string | null>(null);
  // null = "All clients". Same ops-only client-side narrow as the agent picker
  // (Uzo, 2026-06-22): slice the list to one vendor to gauge their pipeline —
  // e.g. how many orders Decency has before sending more stock out.
  const [clientId, setClientId] = useState<string | null>(null);
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
  const canBulkSelect = canBulkAssign || canBulkStatus || canBulkDelete;
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
  const unreadQ = useAsync<Map<string, number>>(
    () =>
      canSeeClaims
        ? // Reps don't handle 'not my route' (admin/dispatcher reassign job), so
          // it's excluded from their per-row chip too (not_my_route_admin_only.sql).
          opsUnreadAgentCounts({ excludeNotMyRoute: user.role === 'rep' })
        : Promise.resolve(new Map()),
    [canSeeClaims, user.role],
  );

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
  const onBulkAssigned = useCallback(
    (updated: number) => {
      setBulkSheetOpen(false);
      exitSelect();
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

  useReloadOnFocus(() => {
    // Stale-aware on focus: a list still within staleTime is served from cache
    // (the back-navigation egress win); only an aged list re-downloads. The
    // uncached overlays (followups / unread — cheap + realtime-backed) still
    // force-refresh so their pills stay live.
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
  }, [filter, datePreset, customDate, agentId, clientId, nameNeedle, exitSelect]);

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
      // Cross-cutting slice: latest status the client hasn't been told about yet
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

  // Unassigned is a separate cross-date slice (its own query), narrowed by the
  // same client + name filters as the date-scoped list. The agent filter makes
  // it empty by definition (an unassigned row has no agent), which is correct.
  const unassignedRows = useMemo(() => {
    let rows = unassignedQ.data ?? [];
    if (agentId) rows = rows.filter((d) => d.assigned_agent_id === agentId);
    if (clientId) rows = rows.filter((d) => d.client_id === clientId);
    if (nameNeedle)
      rows = rows.filter(
        (d) =>
          (d.customer_name ?? '').toLowerCase().includes(nameNeedle) ||
          (d.customer_phone ?? '').toLowerCase().includes(nameNeedle),
      );
    return rows;
  }, [unassignedQ.data, agentId, clientId, nameNeedle]);

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
              : buckets[filter];

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
    { id: 'unassigned' as const, label: 'Unassigned', count: unassignedRows.length },
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
        <AppBar
          title="Deliveries"
          subtitle={nameNeedle ? 'Searching all dates' : subtitleFor(datePreset, customDate)}
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
          options={DATE_OPTIONS}
          value={datePreset}
          onChange={(v) => setDatePreset(v as DatePreset)}
        />
        {datePreset === 'custom' ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <DateField label="Date" value={customDate} onChange={setCustomDate} />
          </View>
        ) : null}
        <FilterChips options={filterOptions} value={filter} onChange={setFilter} />
        {showListFilters ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
            <Input
              icon="search"
              value={nameQuery}
              onChange={setNameQuery}
              placeholder="Search name or phone (all dates)"
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
            {nameNeedle && (data?.length ?? 0) >= SEARCH_LIMIT ? (
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
        {showListFilters ? (
          <AgentPicker
            value={agentId}
            agents={agents}
            loading={agentsQ.loading}
            onChange={setAgentId}
          />
        ) : null}
        {showListFilters ? (
          <ClientPicker
            value={clientId}
            clients={clients}
            loading={clientsQ.loading}
            onChange={setClientId}
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
                  canBulkSelect && itemId
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
              filter === 'postponed'
                ? postponedQ.fetching && !!postponedQ.data
                : filter === 'unassigned'
                  ? unassignedQ.fetching && !!unassignedQ.data
                  : fetching && !!data
            }
            onRefresh={() => {
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
          // "All dates" is capped to the most recent ALL_DATES_LIMIT rows to keep
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
                title="Nothing unassigned"
                sub="Open orders with no agent show here, across all dates."
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
                onPress={() => setSelectedIds(new Set())}
                disabled={selectedIds.size === 0}
              >
                Clear
              </Button>
            </View>
            {canBulkStatus ? (
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  full
                  onPress={() => setBulkStatusSheetOpen(true)}
                  disabled={selectedIds.size === 0}
                  accessibilityLabel={`Change status for ${selectedIds.size} selected`}
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
                  disabled={selectedIds.size === 0}
                  accessibilityLabel={`Delete ${selectedIds.size} selected`}
                >
                  Delete
                </Button>
              </View>
            ) : null}
          </View>
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
