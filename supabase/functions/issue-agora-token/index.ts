// Edge Function: issue-agora-token
//
// Mints a short-lived Agora RTC token for one party to one call. Called from
// the mobile client AFTER a successful initiate_call (caller side) or
// accept_call (callee side). The user's session JWT identifies them; we
// reject if they're not a party to the named call, the call isn't in a
// tokenable state, or the device_uuid doesn't match what's on the row.
//
// Body shape:
//   { call_id: uuid, device_uuid: uuid }
//
// Response (200):
//   { token, app_id, channel, uid, expires_in }
//
// Required env vars (set via `supabase secrets set ...`):
//   AGORA_APP_ID, AGORA_APP_CERT
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (auto-provided)
//
// Token TTL is 5 minutes. The mobile client refreshes via this same endpoint
// on Agora's onTokenPrivilegeWillExpire callback.
//
// Deploy: supabase functions deploy issue-agora-token

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { RtcTokenBuilder, RtcRole } from 'npm:agora-token@2.0.5';

const TOKEN_TTL_SECONDS = 300;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response('unauthorized', { status: 401 });
  }

  let body: { call_id?: unknown; device_uuid?: unknown };
  try { body = await req.json(); }
  catch { return new Response('invalid JSON', { status: 400 }); }

  const callId     = typeof body.call_id     === 'string' ? body.call_id     : null;
  const deviceUuid = typeof body.device_uuid === 'string' ? body.device_uuid : null;
  if (!callId || !deviceUuid) {
    return new Response('call_id and device_uuid required', { status: 400 });
  }

  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const anonKey      = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const agoraAppId   = Deno.env.get('AGORA_APP_ID');
  const agoraAppCert = Deno.env.get('AGORA_APP_CERT');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return new Response('server misconfigured (supabase env)', { status: 500 });
  }
  if (!agoraAppId || !agoraAppCert) {
    return new Response('server misconfigured (agora env)', { status: 500 });
  }

  // 1. Resolve the user from the JWT.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false },
  });
  const { data: userResult, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userResult.user) {
    return new Response('unauthorized', { status: 401 });
  }
  const userId = userResult.user.id;

  // 2. Service-role client for the call lookup + token-stamp RPC.
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: call, error: callErr } = await admin
    .from('calls')
    .select('id, caller_id, callee_id, caller_device_uuid, accepted_device_uuid, agora_channel, status')
    .eq('id', callId)
    .maybeSingle();
  if (callErr) {
    console.error('call lookup failed', callErr);
    return new Response('call lookup failed', { status: 500 });
  }
  if (!call) return new Response('call not found', { status: 404 });

  // 3. Identity + device gate.
  let role: 'caller' | 'callee';
  if (userId === call.caller_id) {
    role = 'caller';
    if (deviceUuid !== call.caller_device_uuid) {
      return new Response('device_uuid does not match caller_device_uuid', { status: 403 });
    }
  } else if (userId === call.callee_id) {
    role = 'callee';
    if (!call.accepted_device_uuid) {
      return new Response('call has not been accepted yet', { status: 409 });
    }
    if (deviceUuid !== call.accepted_device_uuid) {
      return new Response('device_uuid does not match accepted_device_uuid', { status: 403 });
    }
  } else {
    return new Response('not a participant', { status: 403 });
  }

  // 4. State gate. Caller can mint during ringing or accepted; callee only
  //    during accepted (already enforced by accepted_device_uuid check above).
  if (!['ringing', 'accepted'].includes(call.status)) {
    return new Response(`call not in a tokenable state: ${call.status}`, { status: 409 });
  }

  // 5. Derive a stable Agora uid from the device_uuid (FNV-1a 32-bit).
  //    Per-device, not per-user: that way the multi-device guard plus this
  //    deterministic uid means Agora kicks any accidental dupe on the same uid.
  const agoraUid = fnv1a32(deviceUuid);

  // 6. Mint. agora-token v2 expects DURATIONS in seconds (not unix timestamps)
  // for both tokenExpire and privilegeExpire. Passing a unix timestamp would
  // mint a 56-year-valid token — long-lived tokens are a security smell, so
  // we pass TOKEN_TTL_SECONDS directly.
  const token = RtcTokenBuilder.buildTokenWithUid(
    agoraAppId,
    agoraAppCert,
    call.agora_channel,
    agoraUid,
    RtcRole.PUBLISHER,
    TOKEN_TTL_SECONDS,
    TOKEN_TTL_SECONDS,
  );

  // 7. Stamp last_token_issued_at for observability. Fire-and-forget; failure
  //    here doesn't break the call.
  admin.rpc('mark_token_issued', { p_call_id: callId }).then(({ error }) => {
    if (error) console.warn('mark_token_issued failed', error);
  });

  console.log('issued agora token', { call_id: callId, role, agora_uid: agoraUid });

  return new Response(
    JSON.stringify({
      token,
      app_id:     agoraAppId,
      channel:    call.agora_channel,
      uid:        agoraUid,
      expires_in: TOKEN_TTL_SECONDS,
      role,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

// FNV-1a 32-bit hash. Deterministic, fast, no crypto needed (token security
// comes from the App Certificate, not the uid).
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
