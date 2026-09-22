import { rpcUntyped } from '@/lib/supabase';
import { notifyFinancialChange } from '@/lib/financial-refresh';
import { invalidateDeliveries } from '@/services/deliveries';

export type FeePreview = {
  revision: string;
  charged: number | null;
  agent_payment: number | null;
  proposed_charge: number | null;
  total: number | null;
  pending: boolean;
  settled: boolean;
  orders: {
    delivery_id: string;
    customer_name: string;
    amount: number | null;
    reason: string | null;
    manual: boolean;
  }[];
};

export async function previewFeeAdjustment(
  deliveryId: string,
  charged: number | null = null,
  agentPayment: number | null = null,
  applyAgentOverride = false,
) {
  const { data, error } = await rpcUntyped<FeePreview>('preview_delivery_charge_correction', {
    p_delivery_id: deliveryId,
    p_charged: charged,
    p_agent_payment: agentPayment,
    p_apply_agent_override: applyAgentOverride,
  });
  if (error) throw error;
  if (!data) throw new Error('Fee preview unavailable');
  return data;
}

export async function saveFeeAdjustment(input: {
  requestId: string;
  deliveryId: string;
  revision: string;
  charged: number;
  agentPayment: number;
  reason: string;
  applyAgentOverride: boolean;
}) {
  const { data, error } = await rpcUntyped<FeePreview>('correct_delivery_charge_v2', {
    p_request_id: input.requestId,
    p_delivery_id: input.deliveryId,
    p_revision: input.revision,
    p_charged: input.charged,
    p_agent_payment: input.agentPayment,
    p_reason: input.reason,
    p_apply_agent_override: input.applyAgentOverride,
  });
  if (error) throw error;
  invalidateDeliveries();
  notifyFinancialChange();
  return data;
}

export const PAY_ISSUE_TEXT: Record<string, string> = {
  rate_mismatch:
    'The fees still calculated automatically need a rate check. Open the order to set the agreed rider pay.',
  manual_review:
    'The rider, customer or completion details changed after this adjustment. Open the order to confirm the agreed pay.',
  missing_occurrence: 'The delivery completion day is missing. Open the order to confirm the day.',
  date_discrepancy:
    'The reported completion day differs from the upload day. Open the order to confirm when delivery happened.',
  clock_skew:
    'The reported completion time is ahead of the server. Open the order to confirm the day.',
  settled_period_conflict:
    'This change affects a recorded handover. Review that handover before changing its amounts.',
};

export type AgentPayDetail = {
  delivery_id: string;
  customer_name: string;
  final_state: string;
  final_review_reason: string | null;
  final_amount: number | null;
  manual_amount: number | null;
  manual_reason: string | null;
  manual_actor: string | null;
  manual_at: string | null;
};

export async function listAgentPayDetails(
  agentId: string,
  from: string,
  to: string,
  after: string | null,
) {
  const { data, error } = await rpcUntyped<{
    orders: AgentPayDetail[];
    next_cursor: string | null;
  }>('list_agent_pay_details', {
    p_agent_id: agentId,
    p_from: from,
    p_to: to,
    p_after: after,
    p_limit: 20,
  });
  if (error) throw error;
  if (!data) throw new Error('Fee details unavailable');
  return data;
}
