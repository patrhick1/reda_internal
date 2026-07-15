// Cached reference-data hooks (audit Phase 2). Each wraps React Query and adapts
// the result to the { data, loading, error, reload } shape the codebase's
// useAsync consumers already expect — so migrating a screen is a one-line swap
// (useAsync(() => listX(), []) → useX()) with identical downstream usage.
//
// Only cache data that is safe to SHARE across the screens keyed by the same
// query key. Reference data that RLS filters by role/user must include role/user
// in its key (added when those types migrate); status definitions are global
// config, so a bare key is correct.

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { errorMessage } from '@/lib/errors';
import { queryClient } from '@/lib/query';
import { todayLagos } from '@/lib/date';
import type { Role } from '@/lib/permissions';
import { useAuth } from '@/hooks/useAuth';
import {
  listStatusDefs,
  listDeliveries,
  listUnassigned,
  listPostponed,
  listAgentPostponed,
  type DeliveryStatusDef,
  type DeliveryRow,
  type ListFilters,
} from '@/services/deliveries';
import { listUsers, type AppUser } from '@/services/users';
import { listClients, type Client } from '@/services/clients';
import { listLocations, type Location } from '@/services/locations';
import {
  listActiveProductsByClient,
  listProducts,
  type Product,
  type ProductWithClient,
} from '@/services/products';
import { listCurrentStock, type StockMatrixRow } from '@/services/stock';

/** The subset of useAsync's return shape that consumers rely on. */
export type AsyncLike<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

/** Adapt a React Query result to useAsync's shape. `loading` maps to isLoading
 *  (first fetch in flight only) — a background revalidate over cached data does
 *  NOT flip it (the SWR win: show stale data, not a spinner), and a disabled
 *  query reads as not-loading rather than pending-forever. `reload` forces a
 *  refetch (pull-to-refresh / post-mutation reloads). */
function asAsync<T>(q: UseQueryResult<T>): AsyncLike<T> {
  return {
    data: q.data ?? null,
    loading: q.isLoading,
    error: q.error ? errorMessage(q.error) : null,
    reload: async () => {
      await q.refetch();
    },
  };
}

/** Query-key partition for RLS-scoped reference data: the signed-in user id (or
 *  'anon' pre-auth). Cache is also cleared wholesale on sign-out, so this is
 *  defense-in-depth against one account seeing another's role-filtered view. */
function useUid(): string {
  const { account } = useAuth();
  return account.kind === 'active' ? account.userId : 'anon';
}

// Reference catalogs change rarely; a few minutes of staleness is fine because
// catalog mutations invalidate these keys for same-device immediacy.
const REFERENCE_STALE = 5 * 60_000;

/** Delivery status definitions. Static config that never changes at runtime and
 *  is global (not RLS-scoped), so cache it forever under one shared key — every
 *  status picker / detail screen reads the single cached copy. */
export function useStatusDefs(): AsyncLike<DeliveryStatusDef[]> {
  return asAsync(
    useQuery({
      queryKey: ['status-defs'],
      queryFn: () => listStatusDefs(),
      staleTime: Infinity,
      gcTime: Infinity,
    }),
  );
}

/** Users directory. RLS-scoped, so keyed by uid + includeInactive. Catalog
 *  create/update/(de/re)activate + self-profile edits invalidate ['users'] (see
 *  services/users.ts) so a change shows on cached screens without a manual
 *  reload. `enabled: false` skips the fetch for callers that only need it in
 *  some states (e.g. the ops-only delivery-list filter). */
export function useUsers(
  opts: { includeInactive?: boolean; enabled?: boolean } = {},
): AsyncLike<AppUser[]> {
  const uid = useUid();
  const includeInactive = !!opts.includeInactive;
  return asAsync(
    useQuery({
      queryKey: ['users', uid, includeInactive],
      queryFn: () => listUsers({ includeInactive }),
      staleTime: REFERENCE_STALE,
      enabled: opts.enabled ?? true,
    }),
  );
}

/** Vendors directory. Invalidated by services/clients.ts on any client mutation
 *  (create/update/bank/ceiling/(de/re)activate). */
export function useClients(
  opts: { includeInactive?: boolean; enabled?: boolean } = {},
): AsyncLike<Client[]> {
  const uid = useUid();
  const includeInactive = !!opts.includeInactive;
  return asAsync(
    useQuery({
      queryKey: ['clients', uid, includeInactive],
      queryFn: () => listClients({ includeInactive }),
      staleTime: REFERENCE_STALE,
      enabled: opts.enabled ?? true,
    }),
  );
}

/** Delivery locations / zones. Invalidated by services/locations.ts on any
 *  location mutation. */
export function useLocations(
  opts: { includeInactive?: boolean; enabled?: boolean } = {},
): AsyncLike<Location[]> {
  const uid = useUid();
  const includeInactive = !!opts.includeInactive;
  return asAsync(
    useQuery({
      queryKey: ['locations', uid, includeInactive],
      queryFn: () => listLocations({ includeInactive }),
      staleTime: REFERENCE_STALE,
      enabled: opts.enabled ?? true,
    }),
  );
}

/** Product catalog (joined with client name). Invalidated by services/
 *  products.ts on any product mutation, and by services/clients.ts on client
 *  (de/re)activation (which cascades to that client's products). */
export function useProducts(
  opts: { includeInactive?: boolean; enabled?: boolean } = {},
): AsyncLike<ProductWithClient[]> {
  const uid = useUid();
  const includeInactive = !!opts.includeInactive;
  return asAsync(
    useQuery({
      queryKey: ['products', uid, includeInactive],
      queryFn: () => listProducts({ includeInactive }),
      staleTime: REFERENCE_STALE,
      enabled: opts.enabled ?? true,
    }),
  );
}

/** Active products for one client (the delivery-creation picker). A null client
 *  resolves to [] without a request. Shares the ['products-by-client'] key space
 *  invalidated alongside ['products']. */
export function useActiveProductsByClient(clientId: string | null): AsyncLike<Product[]> {
  const uid = useUid();
  return asAsync(
    useQuery({
      queryKey: ['products-by-client', uid, clientId],
      queryFn: () =>
        clientId ? listActiveProductsByClient(clientId) : Promise.resolve([] as Product[]),
      staleTime: REFERENCE_STALE,
    }),
  );
}

// --- Delivery lists (audit Phase 2.4) --------------------------------------
// The delivery list (`deliveries_admin` ≈454 KB/load + line items) is ≈75% of
// egress and was refetched with no cache on every focus, filter toggle, and by
// each dashboard separately. Cache it briefly so back-navigation and the
// list↔dashboard reads collapse into one fetch, but revalidate on focus once
// stale AND on every delivery mutation so live ops data never goes wrong.
// staleTime sits in the audit's 15–30 s band.
//
// Every variant (date-scoped list, unassigned, postponed, agent-postponed)
// shares the ['deliveries', uid, …] key PREFIX so a single invalidateDeliveries()
// (services/deliveries.ts — called after each direct mutation RPC and from the
// queue drain loop when a delivery job lands) refreshes them all at once.
const DELIVERIES_STALE = 20_000;

/** useAsync shape + two extras the live lists need:
 *  - `fetching` (isFetching): true during ANY fetch incl. background revalidate,
 *    so the pull-to-refresh spinner reflects real network activity (`loading` is
 *    first-load-only under the cache, so it can't drive it anymore).
 *  - `refetchIfStale`: refetch ONLY when the cached data is older than the list
 *    staleTime. Wire it to screen focus so returning to a still-fresh list is a
 *    cache hit (the egress win); `reload` stays a forced fetch for pull-to-
 *    refresh and post-action reloads. */
export type DeliveryListResult<T> = AsyncLike<T> & {
  fetching: boolean;
  refetchIfStale: () => void;
};

/** Map a ListFilters to a stable key segment + the NORMALIZED filters actually
 *  sent to the server, so the cache key and the query can never diverge. The
 *  filterless default (a dashboard's `listDeliveries(role)`) and an explicit
 *  `{date: today}` (the list) resolve to the SAME segment, so they share one
 *  cache entry and one fetch. A search of >=2 chars overrides the date scope
 *  server-side, so the key drops the date to match. */
function deliveryListKey(f: ListFilters): { seg: string; filters: ListFilters } {
  const search = (f.search ?? '').trim();
  if (search.length >= 2) return { seg: `search:${search.toLowerCase()}`, filters: { search } };
  if (f.allDates) return { seg: 'all', filters: { allDates: true } };
  const date = f.date ?? todayLagos();
  return { seg: `date:${date}`, filters: { date } };
}

/** Refetch a delivery query only when its cached data has gone stale. Used on
 *  screen focus so a fresh list isn't re-downloaded on every back-navigation. A
 *  query that was never fetched (no state) or is already fetching is left alone —
 *  the mounted observer handles the first load and in-flight fetches. */
function refetchIfStale(queryKey: readonly unknown[]): void {
  const state = queryClient.getQueryState(queryKey);
  if (!state || state.dataUpdatedAt === 0) return;
  if (state.fetchStatus === 'fetching') return;
  if (Date.now() - state.dataUpdatedAt >= DELIVERIES_STALE) {
    void queryClient.refetchQueries({ queryKey, exact: true });
  }
}

/** The main date-scoped delivery list (deliveries_admin/safe by role) — the big
 *  win. Keyed by uid + role + the normalized filter so each date/search scope is
 *  its own cache entry and detail→back within staleTime is a cache hit. The
 *  queryFn's AbortSignal is forwarded to `.abortSignal()` so a superseded
 *  filter/search fetch is cancelled on the wire (Phase 1 behavior, preserved). */
export function useDeliveriesList(
  role: Role,
  rawFilters: ListFilters = {},
): DeliveryListResult<DeliveryRow[]> {
  const uid = useUid();
  const { seg, filters } = deliveryListKey(rawFilters);
  const queryKey = ['deliveries', uid, role, 'list', seg];
  const q = useQuery({
    queryKey,
    queryFn: ({ signal }) => listDeliveries(role, filters, signal),
    staleTime: DELIVERIES_STALE,
  });
  return { ...asAsync(q), fetching: q.isFetching, refetchIfStale: () => refetchIfStale(queryKey) };
}

/** Every unassigned, still-open delivery across all dates (the ops "Unassigned"
 *  chip). Ops-only — `enabled:false` skips the fetch for roles that never see it
 *  (agents). */
export function useUnassignedDeliveries(
  role: Role,
  opts: { enabled?: boolean } = {},
): DeliveryListResult<DeliveryRow[]> {
  const uid = useUid();
  const queryKey = ['deliveries', uid, role, 'unassigned'];
  const q = useQuery({
    queryKey,
    queryFn: () => listUnassigned(role),
    staleTime: DELIVERIES_STALE,
    enabled: opts.enabled ?? true,
  });
  return { ...asAsync(q), fetching: q.isFetching, refetchIfStale: () => refetchIfStale(queryKey) };
}

/** Every postponed delivery across all dates (the ops "Postponed" chip). Ops
 *  view (RLS-scoped). `enabled:false` skips it for roles that don't render it. */
export function usePostponedDeliveries(
  role: Role,
  opts: { enabled?: boolean } = {},
): DeliveryListResult<DeliveryRow[]> {
  const uid = useUid();
  const queryKey = ['deliveries', uid, role, 'postponed'];
  const q = useQuery({
    queryKey,
    queryFn: () => listPostponed(role),
    staleTime: DELIVERIES_STALE,
    enabled: opts.enabled ?? true,
  });
  return { ...asAsync(q), fetching: q.isFetching, refetchIfStale: () => refetchIfStale(queryKey) };
}

/** [Egress Phase 3] The global stock matrix (every holder × product). Legitimately
 *  needed by the three BROAD stock screens (Overview, Stock-by-client, Agent-stock
 *  list) — cached under the ['stock'] prefix so they share ONE fetch instead of
 *  pulling the whole matrix each. The drill-down screens (holder / client / agent
 *  detail) do NOT use this — they run scoped queries (listHolderStock /
 *  listClientStock). Stock is live-ish, so it uses the short list staleTime;
 *  invalidateStock() (queue drain) refreshes it the moment stock actually moves. */
export function useStockMatrix(): DeliveryListResult<StockMatrixRow[]> {
  const uid = useUid();
  const queryKey = ['stock', uid, 'matrix'];
  const q = useQuery({
    queryKey,
    queryFn: () => listCurrentStock(),
    staleTime: DELIVERIES_STALE,
  });
  return { ...asAsync(q), fetching: q.isFetching, refetchIfStale: () => refetchIfStale(queryKey) };
}

/** The signed-in agent's own future-dated postponed orders (the agent Today
 *  "Postponed" chip). Keyed by the agent id it queries. */
export function useAgentPostponed(userId: string): DeliveryListResult<DeliveryRow[]> {
  const uid = useUid();
  const queryKey = ['deliveries', uid, 'agent-postponed', userId];
  const q = useQuery({
    queryKey,
    queryFn: () => listAgentPostponed(userId),
    staleTime: DELIVERIES_STALE,
  });
  return { ...asAsync(q), fetching: q.isFetching, refetchIfStale: () => refetchIfStale(queryKey) };
}
