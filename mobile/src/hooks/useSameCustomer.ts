import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCurrentUser } from '@/hooks/useAuth';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { isOps } from '@/lib/permissions';
import {
  getSameCustomerBadges,
  getSameCustomerConfig,
  getSameCustomerOrders,
  getSameCustomerSummary,
  getSameCustomerShadowPay,
  listSameCustomerOrders,
  type SameCustomerFilters,
} from '@/services/same-customer';

export function useSameCustomerShadowPay(deliveryId: string, enabled = true) {
  const user = useCurrentUser();
  const query = useQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'shadow-pay', deliveryId],
    queryFn: () => getSameCustomerShadowPay(deliveryId),
    enabled: enabled && user.role === 'admin' && !!deliveryId,
    staleTime: 0,
    refetchInterval: 30_000,
  });
  useReloadOnFocus(() => {
    if (enabled && user.role === 'admin' && deliveryId) void query.refetch();
  });
  return query;
}

export function useSameCustomerConfig() {
  const user = useCurrentUser();
  return useQuery({
    queryKey: ['same-customer-config', user.userId],
    queryFn: getSameCustomerConfig,
    enabled: isOps(user.role),
    staleTime: 60_000,
  });
}

export function useSameCustomerGroups(filters: SameCustomerFilters, enabled: boolean) {
  const user = useCurrentUser();
  const query = useInfiniteQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'groups', filters],
    queryFn: ({ pageParam }) => listSameCustomerOrders(filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: enabled && isOps(user.role),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  useReloadOnFocus(() => {
    if (enabled && isOps(user.role)) void query.refetch();
  });
  return query;
}

export function useSameCustomerDetails(day: string, groupId: string, enabled: boolean) {
  const user = useCurrentUser();
  const query = useQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'detail', day, groupId],
    queryFn: () => getSameCustomerOrders(day, groupId),
    enabled: enabled && !!day && !!groupId && isOps(user.role),
    staleTime: 0,
    refetchInterval: 30_000,
  });
  useReloadOnFocus(() => {
    if (enabled && isOps(user.role)) void query.refetch();
  });
  return query;
}

export function useSameCustomerBadges(ids: string[], enabled: boolean) {
  const user = useCurrentUser();
  const stableIds = [...new Set(ids)].sort();
  const query = useQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'badges', stableIds],
    queryFn: () => getSameCustomerBadges(stableIds),
    enabled: enabled && !!stableIds.length && isOps(user.role),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  useReloadOnFocus(() => {
    if (enabled && stableIds.length && isOps(user.role)) void query.refetch();
  });
  return query;
}

export function useSameCustomerSummary(filters: SameCustomerFilters, enabled: boolean) {
  const user = useCurrentUser();
  const query = useQuery({
    queryKey: ['deliveries', 'same-customer', user.userId, 'summary', filters],
    queryFn: () => getSameCustomerSummary(filters),
    enabled: enabled && isOps(user.role) && /^\d{4}-\d{2}-\d{2}$/.test(filters.day),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  useReloadOnFocus(() => {
    if (enabled && isOps(user.role)) void query.refetch();
  });
  return query;
}
