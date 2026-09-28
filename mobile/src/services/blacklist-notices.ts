import { rpcUntyped } from '@/lib/supabase';

export type BlacklistNoticeSummary = {
  count: number;
  through_id: string | null;
  inbound_id: string | null;
};

export async function getBlacklistNoticeSummary(): Promise<BlacklistNoticeSummary> {
  const { data, error } = await rpcUntyped<BlacklistNoticeSummary>(
    'get_blacklist_notice_summary',
    {},
  );
  if (error) throw error;
  return data ?? { count: 0, through_id: null, inbound_id: null };
}

export async function acknowledgeBlacklistNotices(throughId: string): Promise<void> {
  const { error } = await rpcUntyped('acknowledge_blacklist_notices', { p_through_id: throughId });
  if (error) throw error;
}
