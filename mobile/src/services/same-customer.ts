import { rpcUntyped } from '@/lib/supabase';
import { notifyFinancialChange } from '@/lib/financial-refresh';
import { invalidateDeliveries } from '@/services/deliveries';

export type SameCustomerMatchKind = 'primary' | 'alternate' | 'linked';
export type SameCustomerConfig = {
  discovery_enabled: boolean;
  normalization_version: number;
  shadow_review_enabled?: boolean;
};

export type SameCustomerGroup = {
  group_id: string;
  match_kind: SameCustomerMatchKind;
  delivery_ids: string[];
  customer_name: string;
  order_count: number;
  matching_order_count: number;
  vendor_count: number;
  rider_count: number;
  has_unassigned: boolean;
  addresses_differ: boolean;
};
export type SameCustomerPage = {
  groups: SameCustomerGroup[];
  total_groups: number;
  next_cursor: string | null;
};
export type SameCustomerOrder = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_phone_alt: string | null;
  raw_address: string | null;
  scheduled_date: string;
  status: string;
  client_name: string;
  agent_id: string | null;
  agent_name: string | null;
  revision: number;
  match_mode: 'auto' | 'linked' | 'separate';
  instructions: string | null;
  customer_price: number;
  /** Admin only; the API redacts this for dispatchers and reps. */
  agent_payment: number | null;
  items: { product_name: string; quantity: number }[];
};
export type SameCustomerDetails = {
  group_id: string;
  day: string;
  match_kind: SameCustomerMatchKind | 'single';
  orders: SameCustomerOrder[];
};
export type SameCustomerBadge = {
  delivery_id: string;
  group_id: string;
  day: string;
  order_count: number;
  additional_groups: number;
  possible_only: boolean;
};
export type SameCustomerAssignment = {
  updated_count: number;
  orders: {
    delivery_id: string;
    outcome: 'assigned' | 'already_assigned' | 'closed' | 'unavailable';
  }[];
};

export async function assignSameCustomerOrders(
  requestId: string,
  deliveryIds: string[],
  agentId: string,
): Promise<SameCustomerAssignment> {
  const { data, error } = await rpcUntyped<SameCustomerAssignment>('assign_same_customer_orders', {
    p_request_id: requestId,
    p_delivery_ids: deliveryIds,
    p_agent_id: agentId,
  });
  if (error) throw error;
  if (!data) throw new Error('No assignment result returned. Retry to confirm the result.');
  invalidateDeliveries();
  notifyFinancialChange();
  return data;
}

/** Safe client-first rollout: only a missing RPC means the feature isn't installed.
 * Network/auth failures still surface normally; never masquerade as an empty day. */
export async function getSameCustomerConfig(): Promise<SameCustomerConfig> {
  const { data, error } = await rpcUntyped<SameCustomerConfig>('get_same_customer_config');
  if (error?.code === 'PGRST202' || error?.code === '42883') {
    return { discovery_enabled: false, normalization_version: 1 };
  }
  if (error) throw error;
  return data ?? { discovery_enabled: false, normalization_version: 1 };
}

export type SameCustomerFilters = {
  day: string;
  agentId?: string | null;
  clientId?: string | null;
  search?: string | null;
};
export async function listSameCustomerOrders(
  filters: SameCustomerFilters,
  cursor: string | null = null,
): Promise<SameCustomerPage> {
  const { data, error } = await rpcUntyped<SameCustomerPage>('list_same_customer_orders', {
    p_day: filters.day,
    p_after: cursor,
    p_limit: 50,
    p_agent_id: filters.agentId ?? null,
    p_client_id: filters.clientId ?? null,
    p_search: filters.search ?? null,
  });
  if (error) throw error;
  return data ?? { groups: [], total_groups: 0, next_cursor: null };
}

export async function getSameCustomerOrders(day: string, groupId: string) {
  const { data, error } = await rpcUntyped<SameCustomerDetails>('get_same_customer_orders', {
    p_day: day,
    p_group_id: groupId,
  });
  if (error) throw error;
  return data;
}

export async function getSameCustomerBadges(ids: string[]): Promise<SameCustomerBadge[]> {
  if (!ids.length) return [];
  // One bounded request for each batch, never a request per row. Callers normally
  // pass visible rows; splitting preserves completeness on the existing full-day list.
  const result: SameCustomerBadge[] = [];
  for (let index = 0; index < ids.length; index += 500) {
    const { data, error } = await rpcUntyped<SameCustomerBadge[]>('same_customer_badges', {
      p_delivery_ids: ids.slice(index, index + 500),
    });
    if (error) throw error;
    result.push(...(data ?? []));
  }
  return result;
}

export async function correctSameCustomerMatch(input: {
  requestId: string;
  action: 'link' | 'split' | 'reset';
  orders: Pick<SameCustomerOrder, 'id' | 'revision'>[];
  reason: string;
}): Promise<void> {
  const { error } = await rpcUntyped('correct_delivery_customer_match', {
    p_request_id: input.requestId,
    p_action: input.action,
    p_orders: input.orders,
    p_reason: input.reason.trim(),
  });
  if (error) throw error;
  invalidateDeliveries();
  notifyFinancialChange();
}
