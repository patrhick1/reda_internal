// Phase 9 — job executors. Each maps a queued Job to the actual supabase.rpc()
// call. Throwing means "retry"; returning means "done".
//
// We pass every RPC error through classifyRpcError so SQLSTATE-marked
// permanent failures (insufficient_stock, RLS denies, check violations) come
// out as TerminalError. The drain loop short-circuits TerminalError straight
// to dead_letter — no point in 8 retries when the answer won't change.

import { supabase } from '@/lib/supabase';
import { classifyRpcError } from '@/lib/errors';
import type {
  ChangeDeliveryStatusArgs,
  CreateStockAdjustmentArgs,
  CreateStockTransferArgs,
  FlagDeliveryArgs,
  Job,
  JobKind,
  ReturnDeliveryLeftoverArgs,
} from './types';

export type Executor = (clientUuid: string, args: unknown) => Promise<void>;

const EXECUTORS: Record<JobKind, Executor> = {
  async change_delivery_status(clientUuid, raw) {
    const args = raw as ChangeDeliveryStatusArgs;
    const { error } = await supabase.rpc('change_delivery_status', {
      p_client_uuid: clientUuid,
      p_delivery_id: args.deliveryId,
      p_to_status: args.toStatus,
      p_reason: args.reason as unknown as string,
      p_notes: args.notes as unknown as string,
      p_quantity_delivered: args.quantityDelivered as unknown as number,
      p_paid: args.paid as unknown as number,
      p_payment_method: args.paymentMethod as unknown as string,
      p_new_scheduled_date: args.newScheduledDate as unknown as string,
    });
    if (error) throw classifyRpcError(error);
  },
  async flag_delivery(clientUuid, raw) {
    const args = raw as FlagDeliveryArgs;
    const { error } = await supabase.rpc('flag_delivery_issue', {
      p_client_uuid: clientUuid,
      p_delivery_id: args.deliveryId,
      p_issue_type: args.issueType,
      p_note: args.note as unknown as string,
      p_new_status: args.newStatus as unknown as string,
    });
    if (error) throw classifyRpcError(error);
  },
  async create_stock_adjustment(clientUuid, raw) {
    const args = raw as CreateStockAdjustmentArgs;
    const { error } = await supabase.rpc('create_stock_adjustment', {
      p_client_uuid: clientUuid,
      p_agent_id: args.agentId,
      p_product_catalog_id: args.productCatalogId,
      p_quantity_delta: args.quantityDelta,
      p_reason: args.reason,
      p_notes: args.notes as unknown as string,
    });
    if (error) throw classifyRpcError(error);
  },
  async create_stock_transfer(clientUuid, raw) {
    const args = raw as CreateStockTransferArgs;
    const { error } = await supabase.rpc('create_stock_transfer', {
      p_client_uuid: clientUuid,
      p_from_user_id: args.fromUserId,
      p_to_user_id: args.toUserId,
      p_product_catalog_id: args.productCatalogId,
      p_quantity: args.quantity,
      p_reason: args.reason,
      p_notes: args.notes as unknown as string,
    });
    if (error) throw classifyRpcError(error);
  },
  async return_delivery_leftover(clientUuid, raw) {
    const args = raw as ReturnDeliveryLeftoverArgs;
    const { error } = await supabase.rpc('return_delivery_leftover', {
      p_client_uuid: clientUuid,
      p_delivery_id: args.deliveryId,
      p_quantity: args.quantity as unknown as number,
      p_notes: args.notes as unknown as string,
    });
    if (error) throw classifyRpcError(error);
  },
};

export async function executeJob(job: Job): Promise<void> {
  const exec = EXECUTORS[job.kind];
  if (!exec) throw new Error(`unknown job kind: ${job.kind}`);
  await exec(job.clientUuid, job.args);
}
