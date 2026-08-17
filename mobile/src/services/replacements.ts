import { queryClient } from '@/lib/query';
import { rpcUntyped } from '@/lib/supabase';
import { invalidateDeliveries } from './deliveries';
import { invalidateStock } from './stock';

export type ReplacementReason =
  | 'customer_requested_different_product'
  | 'damaged_product'
  | 'vendor_order_error'
  | 'wrong_product_delivered'
  | 'other';

export type ReturnInstruction =
  | 'ask_if_damaged'
  | 'collect_and_hold'
  | 'do_not_collect_damaged';

export type ReplacementItemInput = {
  productCatalogId: string;
  quantity: number;
};

export type ReplacementReturnInput = ReplacementItemInput & {
  vendorInstruction: ReturnInstruction;
};

export type CreateReplacementInput = {
  clientUuid: string;
  clientId: string;
  customerName: string;
  customerPhone: string;
  customerPhoneAlt: string | null;
  rawAddress: string;
  locationId: string;
  scheduledDate: string;
  assignedAgentId: string | null;
  outboundItems: ReplacementItemInput[];
  returnItems: ReplacementReturnInput[];
  reason: ReplacementReason;
  notes: string | null;
  successClientCharge: number;
  successAgentPayment: number;
};

export type ReturnOutcome =
  | 'usable_collected'
  | 'damaged_collected'
  | 'left_with_customer'
  | 'discarded';

export type ReplacementReturnOutcomeInput = {
  returnItemId: string;
  outcome: ReturnOutcome;
  quantity: number;
  notes: string | null;
};

export type ReplacementAttemptOutcome =
  | 'customer_unreachable'
  | 'customer_postponed'
  | 'details_incorrect'
  | 'customer_rejected'
  | 'cancelled'
  | 'other';

export type ReplacementReturnItem = {
  id: string;
  product_catalog_id: string;
  product_name: string;
  quantity_expected: number;
  vendor_instruction: ReturnInstruction;
  actual_quantity: number | null;
  reported_condition: 'usable' | 'damaged' | 'unknown' | null;
  outcome: ReturnOutcome | null;
  custody_state: string;
  current_holder_id: string | null;
  current_holder_name: string | null;
  rider_notes: string | null;
  collected_at: string | null;
  warehouse_received_at: string | null;
};

export type ReplacementAttempt = {
  id: string;
  outcome: ReplacementAttemptOutcome | 'completed';
  status_after: string;
  notes: string | null;
  next_attempt_date: string | null;
  client_charge: number | null;
  agent_payment: number | null;
  attempted_at: string;
  attempted_by_name: string;
};

export type ReplacementDetails = {
  job: {
    delivery_id: string;
    original_delivery_id: string | null;
    reason: ReplacementReason;
    notes: string | null;
    success_client_charge: number | null;
    success_agent_payment: number | null;
  };
  returns: ReplacementReturnItem[];
  attempts: ReplacementAttempt[];
};

export type ReplacementReturnQueueRow = {
  return_item_id: string;
  delivery_id: string;
  customer_name: string;
  raw_address: string;
  client_name: string;
  product_name: string;
  quantity: number;
  reported_condition: 'usable' | 'damaged' | 'unknown' | null;
  custody_state: string;
  vendor_instruction: ReturnInstruction;
  rider_name: string | null;
  collected_at: string | null;
};

function money(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function createReplacement(input: CreateReplacementInput): Promise<string> {
  const { data, error } = await rpcUntyped<string>('create_replacement', {
    p_client_uuid: input.clientUuid,
    p_client_id: input.clientId,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_customer_phone_alt: input.customerPhoneAlt,
    p_raw_address: input.rawAddress,
    p_location_id: input.locationId,
    p_scheduled_date: input.scheduledDate,
    p_assigned_agent_id: input.assignedAgentId,
    p_outbound_items: input.outboundItems.map((item) => ({
      product_catalog_id: item.productCatalogId,
      quantity: item.quantity,
    })),
    p_return_items: input.returnItems.map((item) => ({
      product_catalog_id: item.productCatalogId,
      quantity: item.quantity,
      vendor_instruction: item.vendorInstruction,
    })),
    p_reason: input.reason,
    p_notes: input.notes,
    p_success_client_charge: money(input.successClientCharge),
    p_success_agent_payment: money(input.successAgentPayment),
  });
  if (error) throw error;
  invalidateDeliveries();
  return data as string;
}

export async function getReplacementDetails(
  deliveryId: string,
): Promise<ReplacementDetails | null> {
  const { data, error } = await rpcUntyped<ReplacementDetails>('get_replacement_details', {
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
  return data;
}

export async function listReplacementReturns(): Promise<ReplacementReturnQueueRow[]> {
  const { data, error } = await rpcUntyped<ReplacementReturnQueueRow[]>(
    'list_replacement_returns',
  );
  if (error) throw error;
  return data ?? [];
}

export type ReplacementReturnDisposition =
  | 'accept_to_stock'
  | 'hold_for_vendor'
  | 'reject_damaged'
  | 'returned_to_vendor';

export async function receiveReplacementReturn(input: {
  clientUuid: string;
  returnItemId: string;
  disposition: ReplacementReturnDisposition;
  warehouseId: string | null;
  notes: string | null;
}): Promise<void> {
  const { error } = await rpcUntyped('receive_replacement_return', {
    p_client_uuid: input.clientUuid,
    p_return_item_id: input.returnItemId,
    p_disposition: input.disposition,
    p_warehouse_id: input.warehouseId,
    p_notes: input.notes,
  });
  if (error) throw error;
  invalidateStock();
  invalidateDeliveries();
  void queryClient.invalidateQueries({ queryKey: ['replacement-returns'] });
}

export async function updateReplacementAttemptFees(input: {
  attemptId: string;
  clientCharge: number;
  agentPayment: number;
  reason: string;
}): Promise<void> {
  const { error } = await rpcUntyped('update_replacement_attempt_fees', {
    p_attempt_id: input.attemptId,
    p_client_charge: money(input.clientCharge),
    p_agent_payment: money(input.agentPayment),
    p_reason: input.reason,
  });
  if (error) throw error;
  invalidateDeliveries();
  void queryClient.invalidateQueries({ queryKey: ['reconciliation'] });
}

export const REPLACEMENT_REASON_LABELS: Record<ReplacementReason, string> = {
  customer_requested_different_product: 'Customer wants a different product',
  damaged_product: 'Product was damaged',
  vendor_order_error: 'Vendor sent incorrect order details',
  wrong_product_delivered: 'Wrong product was delivered',
  other: 'Other',
};

export const RETURN_INSTRUCTION_LABELS: Record<ReturnInstruction, string> = {
  ask_if_damaged: 'Collect if usable; ask vendor if damaged',
  collect_and_hold: 'Collect it even if damaged and hold for vendor',
  do_not_collect_damaged: 'Do not collect if damaged',
};

export const RETURN_OUTCOME_LABELS: Record<ReturnOutcome, string> = {
  usable_collected: 'Collected — appears usable',
  damaged_collected: 'Collected — damaged; hold only',
  left_with_customer: 'Not collected / left with customer',
  discarded: 'Discarded as instructed',
};

export const ATTEMPT_OUTCOME_LABELS: Record<ReplacementAttemptOutcome, string> = {
  customer_unreachable: 'Customer did not answer',
  customer_postponed: 'Customer postponed',
  details_incorrect: 'Replacement details were incorrect',
  customer_rejected: 'Customer rejected the replacement',
  cancelled: 'Replacement cancelled',
  other: 'Other unsuccessful attempt',
};
