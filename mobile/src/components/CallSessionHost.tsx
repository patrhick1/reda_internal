import { useEffect } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { callSession, useCallSession } from '@/lib/calls/session';
import { isLiveCall } from '@/lib/calls/session-core';
import { colors, fonts } from '@/lib/theme';
import { canPlaceCall } from '@/lib/calls/availability';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';

/** Mounted above navigation: Back only hides the screen, never the session. */
export function CallSessionHost({ userId }: { userId: string | null }) {
  const session = useCallSession();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const enabled = canPlaceCall() && !!userId;
  const active = isLiveCall(session.call);
  const callId = active ? session.call?.id : null;
  useSupabaseChannel(
    enabled && callId ? `active-call:${callId}` : null,
    (channel) =>
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` },
        () => {
          void callSession.refresh();
        },
      ),
    [callId],
  );

  useEffect(() => {
    callSession.setUser(enabled ? userId : null);
    if (!enabled) return;
    void callSession.refresh();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') void callSession.refresh();
    });
    return () => {
      foreground.remove();
      callSession.setUser(null);
    };
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled) return;
    // Polling also reconciles missed Realtime events after network/app restarts.
    const timer = setInterval(
      () => {
        void callSession.refresh();
      },
      active ? 3000 : 15000,
    );
    return () => clearInterval(timer);
  }, [enabled, active]);

  if (!enabled || !active || !callId || path.startsWith('/call/')) return null;
  return (
    <View
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        top: insets.top + 4,
        borderRadius: 14,
        backgroundColor: colors.black,
        padding: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        elevation: 20,
        zIndex: 1000,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Return to call"
        onPress={() => router.push(`/call/${callId}`)}
        style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: colors.white, fontFamily: fonts.bold }}>Return to call</Text>
        <Text style={{ color: colors.white, fontFamily: fonts.regular, fontSize: 12 }}>
          {session.error
            ? 'Connection needs attention'
            : session.call?.status === 'ringing'
              ? 'Ringing…'
              : 'Call in progress'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="End call"
        disabled={session.ending}
        onPress={() => {
          void callSession.end();
        }}
        style={{ padding: 12 }}
      >
        <Text style={{ color: colors.white, fontFamily: fonts.bold }}>
          {session.ending ? 'Ending…' : 'End'}
        </Text>
      </Pressable>
    </View>
  );
}
