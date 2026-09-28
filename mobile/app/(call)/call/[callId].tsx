import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar as RNStatusBar,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon, Avatar } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import type { Call } from '@/services/calls';
import { callSession, useCallSession } from '@/lib/calls/session';
import { canPlaceCall } from '@/lib/calls/availability';

const TERMINAL_STATES = new Set<Call['status']>([
  'declined',
  'cancelled',
  'missed',
  'completed',
  'failed',
]);

// Wrapper component does ONLY a platform check (no hooks). The inner
// CallScreen owns every hook and runs only on native. This keeps hook
// order trivially consistent on each platform — the call screen tree
// never mounts on web, so its Agora useEffects never fire.
//
// The screen is unreachable through normal flows on web (every Call entry
// point is gated by canPlaceCall()). This is defense-in-depth against
// stale bookmarks or someone pasting the URL into the browser bar.
export default function CallScreenRoute() {
  if (!canPlaceCall()) return <WebUnsupportedRedirect />;
  return <CallScreen />;
}

function WebUnsupportedRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/');
  }, [router]);
  return null;
}

function CallScreen() {
  const { callId } = useLocalSearchParams<{ callId: string }>();
  const router = useRouter();
  const { account } = useAuth();
  const userId = account.kind === 'active' ? account.userId : null;

  const session = useCallSession();
  const call = session.call?.id === callId ? session.call : null;
  const { muted, speaker, connected: agoraConnected, remoteJoined, reconnecting, ending } = session;
  const [peer, setPeer] = useState<{ id: string; display_name: string } | null>(null);
  const seenCall = useRef(false);
  const [checked, setChecked] = useState(false);
  const currentCallId = call?.id;
  const callStatus = call?.status;
  const peerId =
    call && userId ? (call.caller_id === userId ? call.callee_id : call.caller_id) : null;

  useEffect(() => {
    let mounted = true;
    setChecked(false);
    void callSession.refresh().finally(() => {
      if (mounted) setChecked(true);
    });
    return () => {
      mounted = false;
    };
  }, [callId]);
  useEffect(() => {
    if (!currentCallId || !userId) return;
    seenCall.current = true;
    if (!peerId) return;
    let cancelled = false;
    supabase
      .from('users')
      .select('id, display_name')
      .eq('id', peerId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setPeer(data);
      });
    return () => {
      cancelled = true;
    };
  }, [currentCallId, peerId, userId]);

  const minimize = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  // Back is minimization. The root session keeps audio and server reconciliation alive.
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      minimize();
      return true;
    });
    return () => back.remove();
  }, [minimize]);
  useEffect(() => {
    if (callStatus && TERMINAL_STATES.has(callStatus)) {
      const timer = setTimeout(minimize, 1500);
      return () => clearTimeout(timer);
    }
    if (!callStatus && seenCall.current) minimize();
  }, [callStatus, minimize]);

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

  const onToggleMute = () => callSession.mute();
  const onToggleSpeaker = () => callSession.speaker();
  const onEnd = async () => {
    if (!call || TERMINAL_STATES.has(call.status)) minimize();
    else await callSession.end();
  };

  if (!callId) return null;

  const status = call?.status ?? (checked ? 'completed' : 'ringing');
  const peerName = call?.callee_audience === 'ops_team' ? 'Reda team' : (peer?.display_name ?? '…');

  return (
    <View style={{ flex: 1, backgroundColor: colors.black }}>
      <RNStatusBar barStyle="light-content" />
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Minimize call"
        onPress={minimize}
        style={{ padding: 20, paddingTop: 48 }}
      >
        <Text style={{ color: colors.white, fontFamily: fonts.semibold }}>Minimize call</Text>
      </TouchableOpacity>
      {session.error ? (
        <View style={{ padding: 16 }}>
          <Text accessibilityRole="alert" style={{ color: colors.white }}>
            {session.error}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => callSession.reconnect()}
            style={{ paddingVertical: 14 }}
          >
            <Text style={{ color: colors.white, fontFamily: fonts.bold }}>Retry connection</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing['3xl'],
        }}
      >
        <Avatar user={{ display_name: peerName }} size={120} />
        <Text
          style={{
            fontFamily: fonts.bold,
            fontSize: 28,
            color: colors.white,
            marginTop: spacing['2xl'],
            textAlign: 'center',
          }}
        >
          {peerName}
        </Text>
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 16,
            color: reconnecting ? colors.warning : colors.textTertiary,
            marginTop: spacing.md,
          }}
        >
          {reconnecting ? 'Reconnecting…' : statusLabel(status, remoteJoined, agoraConnected)}
        </Text>
        {status === 'accepted' && (
          <Text
            style={{
              fontFamily: fonts.monoMedium,
              fontSize: 18,
              color: colors.white,
              marginTop: spacing.lg,
            }}
          >
            {durationLabel}
          </Text>
        )}
      </View>

      <View
        style={{
          paddingHorizontal: spacing['3xl'],
          paddingBottom: spacing['3xl'] + 16,
          gap: spacing['2xl'],
        }}
      >
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
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: spacing.md,
            opacity: ending ? 0.6 : 1,
          }}
        >
          {ending ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <Icon name="phoneOff" size={24} color={colors.white} />
          )}
          <Text style={{ fontFamily: fonts.semibold, color: colors.white, fontSize: 16 }}>
            {status === 'ringing' ? 'Cancel' : status === 'accepted' ? 'End call' : 'Close'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ControlButton({
  icon,
  label,
  active,
  onPress,
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
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: active ? colors.white : 'rgba(255,255,255,0.15)',
          alignItems: 'center',
          justifyContent: 'center',
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
    case 'ringing':
      return connected ? 'Ringing…' : 'Connecting…';
    case 'accepted':
      return remoteJoined ? 'Connected' : 'Connecting…';
    case 'declined':
      return 'Call declined';
    case 'cancelled':
      return 'Call cancelled';
    case 'missed':
      return 'No answer';
    case 'completed':
      return 'Call ended';
    case 'failed':
      return 'Call failed';
  }
}
