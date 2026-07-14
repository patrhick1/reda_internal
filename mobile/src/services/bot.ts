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
  raw_text: string | null;
  received_at: string;
  status: InboundStatus;
  parse_result: unknown;
  delivery_id: string | null;
  error_text: string | null;
};

export async function listBotInbound(
  status: InboundStatus | 'all',
  limit = 100,
): Promise<BotInboundRow[]> {
  // [Egress Phase 3] Compact review-list projection. The full parse_result
  // averages ~1.9 KB/row and is mostly provenance the list never renders
  // (extraction_raw provider envelope, extraction_model, vendor_classifications,
  // agent_resolution, hints, items…). The card + reviewReason() use only these
  // six keys, so project them with PostgREST JSON selection and rebuild a compact
  // parse_result — dropping ~1 KB/row. The DETAIL screen refetches the FULL
  // parse_result via getBotInbound(). wasender_message_id / remote_jid /
  // processed_at were selected but never rendered — dropped too.
  let q = supabase
    .from('bot_inbound_messages')
    .select(
      'id, raw_text, received_at, status, delivery_id, error_text,' +
        ' extracted:parse_result->extracted, product:parse_result->product,' +
        ' product_candidates:parse_result->product_candidates,' +
        ' product_matches:parse_result->product_matches,' +
        ' address:parse_result->address, location_hint:parse_result->location_hint',
    )
    .order('received_at', { ascending: false })
    .limit(limit);
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  type ProjectedRow = {
    id: string;
    raw_text: string | null;
    received_at: string;
    status: InboundStatus;
    delivery_id: string | null;
    error_text: string | null;
    extracted: unknown;
    product: unknown;
    product_candidates: unknown;
    product_matches: unknown;
    address: unknown;
    location_hint: unknown;
  };
  return ((data ?? []) as unknown as ProjectedRow[]).map((r) => ({
    id: r.id,
    raw_text: r.raw_text,
    received_at: r.received_at,
    status: r.status,
    delivery_id: r.delivery_id,
    error_text: r.error_text,
    // Rebuild the subset of parse_result the card + reviewReason() read.
    parse_result: {
      extracted: r.extracted,
      product: r.product,
      product_candidates: r.product_candidates,
      product_matches: r.product_matches,
      address: r.address,
      location_hint: r.location_hint,
    },
  }));
}

/** HEAD-count of bot_inbound_messages rows in `needs_review` state. Cheap —
 *  Supabase returns only the count, no row bodies. Used by the Review tab
 *  badge in admin + ops layouts. Returns 0 on error so a transient network
 *  blip doesn't surface as a UI failure. */
export async function countNeedsReview(): Promise<number> {
  const { count, error } = await supabase
    .from('bot_inbound_messages')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'needs_review');
  if (error) throw error;
  return count ?? 0;
}

/** The detail row is now the same shape as the list row. `raw_payload` (the
 *  contractor's full webhook body) was fetched here but is read nowhere in the
 *  app — dropped as pure dead egress. Alias kept so callers don't churn. */
export type BotInboundDetailRow = BotInboundRow;

/** Fetches a single inbound row by id for the review-fix detail screen. */
export async function getBotInbound(id: string): Promise<BotInboundDetailRow | null> {
  const { data, error } = await supabase
    .from('bot_inbound_messages')
    .select('id, raw_text, received_at, status, parse_result, delivery_id, error_text')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as BotInboundDetailRow | null) ?? null;
}

/** Marks a needs_review row as resolved into a freshly-created delivery.
 *  Call after createDelivery succeeds. Server enforces admin/dispatcher and
 *  the caller's edit lock; also drops the lock row. */
export async function resolveInboundToDelivery(
  inboundId: string,
  deliveryId: string,
): Promise<void> {
  const { error } = await supabase.rpc('resolve_inbound_to_delivery', {
    p_inbound_id: inboundId,
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
    p_reason: reason,
  });
  if (error) throw error;
}

/** Admin/dispatcher: re-queue failed (status='error') inbound messages so the bot
 *  re-parses them — e.g. after a transient extraction outage. Server resets each
 *  row to 'queued' and re-fires bot-parse-message (async), returning how many were
 *  re-queued. Reprocessing happens server-side a moment later, so callers should
 *  refresh the list shortly after. Not in the generated RPC types yet → cast. */
export async function requeueFailedInbound(ids: string[]): Promise<number> {
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc('requeue_failed_inbound', { p_ids: ids });
  if (error) throw new Error(error.message);
  return typeof data === 'number' ? data : 0;
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
