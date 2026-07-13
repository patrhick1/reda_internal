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
import { useAuth } from '@/hooks/useAuth';
import { listStatusDefs, type DeliveryStatusDef } from '@/services/deliveries';
import { listUsers, type AppUser } from '@/services/users';

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
