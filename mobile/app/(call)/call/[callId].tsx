import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator, Alert, StatusBar as RNStatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon, Avatar } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import {
  cancelCall, endCall, fetchAgoraToken, type Call,
} from '@/services/calls';
import {
  joinChannel, leaveChannel, setMuted as agoraSetMuted, setSpeakerOn as agoraSetSpeakerOn,
  registerEventHandler, unregisterEventHandler, renewToken,
} from '@/lib/calls/agora';
import { dismissCall as callkeepDismiss } from '@/lib/calls/callkeep';
import { useOutgoingCallSubscription } from '@/hooks/useOutgoingCallSubscription';

const TERMINAL_STATES = new Set<Call['status']>([
  'declined', 'cancelled', 'missed', 'completed', 'failed',
]);

export default function CallScreen() {
  const { callId } = useLocalSearchParams<{ callId: string }>();
  const router = useRouter();
  const { account } = useAuth();
  const userId = account.kind === 'active' ? account.userId : null;

  const call = useOutgoingCallSubscription(callId ?? null);
  const [peer, setPeer] = useState<{ id: string; display_name: string } | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [agoraConnected, setAgoraConnected] = useState(false);
  const [remoteJoined, setRemoteJoined] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [ending, setEnding] = useState(false);

  // Joined Agora? Only run once per call_id so a Realtime update doesn't rejoin.
  const joinedRef = useRef<string | null>(null);

  // Identify the peer (the OTHER party) and fetch their display name once.
  useEffect(() => {
    if (!call || !userId) return;
    const peerId = call.caller_id === userId ? call.callee_id : call.caller_id;
    if (peer?.id === peerId) return;
    supabase
      .from('users')
      .select('id, display_name')
      .eq('id', peerId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setPeer({ id: data.id as string, display_name: (data.display_name as string) ?? '' });
      });
  }, [call, userId, peer?.id]);

  // Join Agora once we have a tokenable call. The caller joins during
  // 'ringing' (Agora supports join-early). The callee already joined inside
  // the coordinator's answer() flow before navigating here, so we only join
  // if we're the caller AND not yet joined.
  const isCaller = call && userId === call.caller_id;
  useEffect(() => {
    if (!call) return;
    if (joinedRef.current === call.id) return;
    if (!isCaller) {
      // Callee already joined inside coord.answer() — just mark joined so we
      // don't re-fetch a token.
      joinedRef.current = call.id;
      return;
    }
    if (!['ringing', 'accepted'].includes(call.status)) return;

    joinedRef.current = call.id;
    (async () => {
      try {
        const t = await fetchAgoraToken(call.id);
        joinChannel(t.app_id, t.token, t.channel, t.uid);
      } catch (err: any) {
        console.error('[call] joinChannel failed', err);
        Alert.alert('Could not connect call', err?.message ?? String(err));
        await cancelCallSafe(call.id);
        router.back();
      }
    })();
  }, [call, router, isCaller]);

  // Wire Agora event handlers — token refresh + remote-user state.
  useEffect(() => {
    const handler = {
      onJoinChannelSuccess: () => setAgoraConnected(true),
      onUserJoined: () => setRemoteJoined(true),
      onUserOffline: () => setRemoteJoined(false),
      // Agora's connection state. 4 = Reconnecting (network blip).
      // 3 = Connected (we're good). Anything else we treat as transient.
      onConnectionStateChanged: (_conn: unknown, state: number) => {
        setReconnecting(state === 4);
        if (state === 3) setAgoraConnected(true);
      },
      onTokenPrivilegeWillExpire: async () => {
        if (!callId) return;
        try {
          const t = await fetchAgoraToken(callId);
          renewToken(t.token);
        } catch (err) {
          console.warn('[call] token renew failed', err);
        }
      },
      onError: (err: number, msg: string) => {
        console.warn('[call] agora error', err, msg);
      },
    };
    registerEventHandler(handler);
    return () => { unregisterEventHandler(handler); };
  }, [callId]);

  // Terminal state: leave Agora, dismiss CallKeep (no-op for caller side),
  // pop back after a brief delay so the user sees the final label.
  useEffect(() => {
    if (!call) return;
    if (!TERMINAL_STATES.has(call.status)) return;
    leaveChannel();
    callkeepDismiss(call.id);
    const t = setTimeout(() => { router.back(); }, 1500);
    return () => clearTimeout(t);
  }, [call?.status, router, call]);

  // Tick the duration counter once we're accepted.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (call?.status !== 'accepted') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.status]);

  const durationLabel = useMemo(() => {
    if (!call?.started_at) return '';
    const seconds = Math.max(0, Math.floor((now - new Date(call.started_at).getTime()) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [call?.started_at, now]);

  const onToggleMute = useCallback(() => {
    const next = !muted; setMuted(next); agoraSetMuted(next);
  }, [muted]);
  const onToggleSpeaker = useCallback(() => {
    const next = !speaker; setSpeaker(next); agoraSetSpeakerOn(next);
  }, [speaker]);

  const onEnd = useCallback(async () => {
    if (!call || ending) return;
    setEnding(true);
    try {
      if (call.status === 'ringing' && isCaller) {
        await cancelCall(call.id);
      } else if (call.status === 'accepted') {
        await endCall(call.id);
      }
    } catch (err: any) {
      console.warn('[call] end failed', err);
    } finally {
      leaveChannel();
      callkeepDismiss(call.id);
      router.back();
    }
  }, [call, ending, isCaller, router]);

  if (!callId) return null;

  const status = call?.status ?? 'ringing';
  const peerName = peer?.display_name ?? '…';

  return (
    <View style={{ flex: 1, backgroundColor: colors.black }}>
      <RNStatusBar barStyle="light-content" />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing['3xl'] }}>
        <Avatar user={{ display_name: peerName }} size={120} />
        <Text style={{
          fontFamily: fonts.bold, fontSize: 28, color: colors.white,
          marginTop: spacing['2xl'], textAlign: 'center',
        }}>
          {peerName}
        </Text>
        <Text style={{
          fontFamily: fonts.regular, fontSize: 16,
          color: reconnecting ? colors.warning : colors.textTertiary,
          marginTop: spacing.md,
        }}>
          {reconnecting ? 'Reconnecting…' : statusLabel(status, remoteJoined, agoraConnected)}
        </Text>
        {status === 'accepted' && (
          <Text style={{
            fontFamily: fonts.monoMedium, fontSize: 18, color: colors.white,
            marginTop: spacing.lg,
          }}>
            {durationLabel}
          </Text>
        )}
      </View>

      <View style={{
        paddingHorizontal: spacing['3xl'],
        paddingBottom: spacing['3xl'] + 16,
        gap: spacing['2xl'],
      }}>
        {status === 'accepted' && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <ControlButton
              icon={muted ? 'micOff' : 'mic'}
              label={muted ? 'Unmute' : 'Mute'}
              active={muted}
              onPress={onToggleMute}
            />
            <ControlButton
              icon="volume2"
              label="Speaker"
              active={speaker}
              onPress={onToggleSpeaker}
            />
          </View>
        )}

        <TouchableOpacity
          onPress={onEnd}
          disabled={ending}
          activeOpacity={0.8}
          style={{
            height: 64,
            borderRadius: radii.pill,
            backgroundColor: colors.red,
            alignItems: 'center', justifyContent: 'center',
            flexDirection: 'row', gap: spacing.md,
            opacity: ending ? 0.6 : 1,
          }}
        >
          {ending
            ? <ActivityIndicator color={colors.white} />
            : <Icon name="phoneOff" size={24} color={colors.white} />}
          <Text style={{ fontFamily: fonts.semibold, color: colors.white, fontSize: 16 }}>
            {status === 'ringing' ? 'Cancel' : status === 'accepted' ? 'End call' : 'Close'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ControlButton({
  icon, label, active, onPress,
}: {
  icon: 'mic' | 'micOff' | 'volume2';
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <View style={{ alignItems: 'center', gap: spacing.sm }}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={{
          width: 64, height: 64, borderRadius: 32,
          backgroundColor: active ? colors.white : 'rgba(255,255,255,0.15)',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={28} color={active ? colors.black : colors.white} />
      </TouchableOpacity>
      <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textTertiary }}>
        {label}
      </Text>
    </View>
  );
}

function statusLabel(status: Call['status'], remoteJoined: boolean, connected: boolean): string {
  switch (status) {
    case 'ringing':   return connected ? 'Ringing…' : 'Connecting…';
    case 'accepted':  return remoteJoined ? 'Connected' : 'Connecting…';
    case 'declined':  return 'Call declined';
    case 'cancelled': return 'Call cancelled';
    case 'missed':    return 'No answer';
    case 'completed': return 'Call ended';
    case 'failed':    return 'Call failed';
  }
}

// Best-effort cancel that doesn't surface errors — used when we already know
// we want to bail out (e.g. token fetch failed). The row may already be in a
// terminal state, in which case cancel_call returns 40001; that's fine.
async function cancelCallSafe(id: string) {
  try { await cancelCall(id); } catch { /* noop */ }
}
