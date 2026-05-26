// Phase 9 — job executors. Each maps a queued Job to the actual supabase.rpc()
// call. Throwing means "retry"; returning means "done".
//
// Errors that are *permanent* (validation, idempotent conflict already resolved
// favourably, RLS deny) should still throw — the queue will retry, then dead-
// letter. The user reviews dead-letters explicitly. We deliberately do NOT
// try to classify errors here; that would be brittle and the dead-letter UX is
// fine for v1.

import { supabase } from '@/lib/supabase';
import type {
  ChangeDeliveryStatusArgs,
  CreateStockAdjustmentArgs,
  CreateStockTransferArgs,
  Job,
  JobKind,
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
    });
    if (error) throw error;
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
    if (error) throw error;
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
    if (error) throw error;
  },
};

export async function executeJob(job: Job): Promise<void> {
  const exec = EXECUTORS[job.kind];
  if (!exec) throw new Error(`unknown job kind: ${job.kind}`);
  await exec(job.clientUuid, job.args);
}
