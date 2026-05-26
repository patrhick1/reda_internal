import { supabase } from '@/lib/supabase';

export type InboundStatus =
  | 'queued'
  | 'parsed'
  | 'shadow_only'
  | 'needs_review'
  | 'created_delivery'
  | 'duplicate'
  | 'error';

export type BotInboundRow = {
  id: string;
  wasender_message_id: string;
  remote_jid: string | null;
  raw_text: string | null;
  received_at: string;
  processed_at: string | null;
  status: InboundStatus;
  parse_result: unknown;
  delivery_id: string | null;
  error_text: string | null;
};

export async function listBotInbound(status: InboundStatus | 'all', limit = 100): Promise<BotInboundRow[]> {
  let q = supabase
    .from('bot_inbound_messages')
    .select('id, wasender_message_id, remote_jid, raw_text, received_at, processed_at, status, parse_result, delivery_id, error_text')
    .order('received_at', { ascending: false })
    .limit(limit);
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as BotInboundRow[];
}

export type BotInboundDetailRow = BotInboundRow & {
  raw_payload: unknown;
};

/** Fetches a single inbound row by id, including raw_payload (the
 *  contractor's webhook body). Used by the review-fix detail screen. */
export async function getBotInbound(id: string): Promise<BotInboundDetailRow | null> {
  const { data, error } = await supabase
    .from('bot_inbound_messages')
    .select('id, wasender_message_id, remote_jid, raw_text, raw_payload, received_at, processed_at, status, parse_result, delivery_id, error_text')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as BotInboundDetailRow | null) ?? null;
}

/** Marks a needs_review row as resolved into a freshly-created delivery.
 *  Call after createDelivery succeeds. Server enforces admin/dispatcher and
 *  the caller's edit lock; also drops the lock row. */
export async function resolveInboundToDelivery(inboundId: string, deliveryId: string): Promise<void> {
  const { error } = await supabase.rpc('resolve_inbound_to_delivery', {
    p_inbound_id:  inboundId,
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
}

/** Moves a review row to status='error' with a reason. Used when the message
 *  isn't a real order (spam, duplicate, etc.). Server enforces admin/dispatcher
 *  and the caller's edit lock; also drops the lock row. */
export async function discardInbound(inboundId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('discard_inbound', {
    p_inbound_id: inboundId,
    p_reason:     reason,
  });
  if (error) throw error;
}

export type FeatureFlag = {
  key: string;
  enabled: boolean;
  description: string | null;
  updated_at: string;
};

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled, description, updated_at')
    .order('key');
  if (error) throw error;
  return (data ?? []) as FeatureFlag[];
}

export async function setFeatureFlag(key: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_feature_flag', { p_key: key, p_enabled: enabled });
  if (error) throw error;
}
