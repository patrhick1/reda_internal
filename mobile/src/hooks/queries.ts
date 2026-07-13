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
import { listStatusDefs, type DeliveryStatusDef } from '@/services/deliveries';

/** The subset of useAsync's return shape that consumers rely on. */
export type AsyncLike<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

/** Adapt a React Query result to useAsync's shape. `loading` maps to isPending
 *  (no data yet) — a background revalidate over cached data does NOT flip it, so
 *  screens show stale data instead of a spinner, which is the SWR win. `reload`
 *  forces a refetch (used by pull-to-refresh / post-mutation reloads). */
function asAsync<T>(q: UseQueryResult<T>): AsyncLike<T> {
  return {
    data: q.data ?? null,
    loading: q.isPending,
    error: q.error ? errorMessage(q.error) : null,
    reload: async () => {
      await q.refetch();
    },
  };
}

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
