import { supabase } from '@/lib/supabase';
import { newClientUuid } from '@/lib/uuid';
import { getOrCreateDeviceUuid } from '@/lib/calls/deviceUuid';
import type { Role } from '@/lib/permissions';

export type CallStatus =
  | 'ringing'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'missed'
  | 'completed'
  | 'failed';

export type Call = {
  id: string;
  caller_id: string;
  callee_id: string;
  caller_device_uuid: string;
  accepted_device_uuid: string | null;
  agora_channel: string;
  status: CallStatus;
  related_delivery_id: string | null;
  ringing_until: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  client_uuid: string | null;
  last_token_issued_at: string | null;
  created_at: string;
};

export type AgoraToken = {
  token: string;
  app_id: string;
  channel: string;
  uid: number;
  expires_in: number;
  role: 'caller' | 'callee';
};

export type CallableUser = {
  id: string;
  display_name: string;
  role: Role;
};

function firstRow(data: unknown): Call | null {
  if (!data) return null;
  return (Array.isArray(data) ? data[0] : data) as Call;
}

export async function initiateCall(opts: {
  calleeId: string;
  relatedDeliveryId?: string | null;
}): Promise<Call> {
  const deviceUuid = await getOrCreateDeviceUuid();
  const { data, error } = await supabase.rpc('initiate_call', {
    p_callee_id: opts.calleeId,
    p_caller_device_uuid: deviceUuid,
    p_related_delivery_id: (opts.relatedDeliveryId ?? null) as string,
    p_client_uuid: newClientUuid(),
  });
  if (error) throw error;
  const row = firstRow(data);
  if (!row) throw new Error('initiate_call returned no row');
  return row;
}

export async function acceptCall(callId: string): Promise<Call> {
  const deviceUuid = await getOrCreateDeviceUuid();
  const { data, error } = await supabase.rpc('accept_call', {
    p_call_id: callId,
    p_device_uuid: deviceUuid,
  });
  if (error) throw error;
  const row = firstRow(data);
  if (!row) throw new Error('accept_call returned no row');
  return row;
}

export async function declineCall(callId: string, reason: string | null = null): Promise<Call> {
  const { data, error } = await supabase.rpc('decline_call', {
    p_call_id: callId,
    p_reason: reason as string,
  });
  if (error) throw error;
  const row = firstRow(data);
  if (!row) throw new Error('decline_call returned no row');
  return row;
}

export async function cancelCall(callId: string): Promise<Call> {
  const { data, error } = await supabase.rpc('cancel_call', { p_call_id: callId });
  if (error) throw error;
  const row = firstRow(data);
  if (!row) throw new Error('cancel_call returned no row');
  return row;
}

export async function endCall(callId: string): Promise<Call> {
  const { data, error } = await supabase.rpc('end_call', { p_call_id: callId });
  if (error) throw error;
  const row = firstRow(data);
  if (!row) throw new Error('end_call returned no row');
  return row;
}

export async function getCall(callId: string): Promise<Call | null> {
  const { data, error } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Call | null;
}

export async function fetchAgoraToken(callId: string): Promise<AgoraToken> {
  const deviceUuid = await getOrCreateDeviceUuid();
  const { data, error } = await supabase.functions.invoke('issue-agora-token', {
    body: { call_id: callId, device_uuid: deviceUuid },
  });
  if (error) throw error;
  if (!data) throw new Error('issue-agora-token returned no data');
  return data as AgoraToken;
}

export type CallHistoryRow = Call & {
  caller_name: string | null;
  callee_name: string | null;
};

export async function listCallHistory(
  currentUserId: string,
  limit = 50,
): Promise<CallHistoryRow[]> {
  const { data, error } = await supabase
    .from('calls')
    .select(
      `
      *,
      caller:users!calls_caller_id_fkey(display_name),
      callee:users!calls_callee_id_fkey(display_name)
    `,
    )
    .or(`caller_id.eq.${currentUserId},callee_id.eq.${currentUserId}`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  type Raw = Call & {
    caller: { display_name: string | null } | null;
    callee: { display_name: string | null } | null;
  };
  return ((data ?? []) as Raw[]).map((r) => ({
    ...(r as Call),
    caller_name: r.caller?.display_name ?? null,
    callee_name: r.callee?.display_name ?? null,
  }));
}

export async function listCallableUsers(currentUserId: string): Promise<CallableUser[]> {
  const { data, error } = await supabase
    .from('users')
    .select('id, display_name, role')
    .eq('is_active', true)
    .neq('id', currentUserId)
    .order('display_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CallableUser[];
}
