import { useEffect, useState } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { ActivityIndicator, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth, type AccountState } from '@/hooks/useAuth';
import { usePushTokenRegistration } from '@/hooks/usePushTokenRegistration';
import { useRedaFonts } from '@/hooks/useRedaFonts';
import { initSentry } from '@/lib/sentry';
import { isBiometricEnabled } from '@/lib/biometric';
import {
  configureNotifications,
  useCallInvitePushHandler,
  useNotificationTapRouting,
} from '@/lib/notifications';
import { BiometricLockScreen } from '@/screens/BiometricLockScreen';
import { colors } from '@/lib/theme';
import { QueueProvider } from '@/queue/QueueProvider';
import { ErrorBoundary } from '@/components/ui';
import { setupCallKeep, addAnswerListener, addEndListener } from '@/lib/calls/callkeep';
import * as callCoord from '@/lib/calls/coordinator';
import { useIncomingCallSubscription } from '@/hooks/useIncomingCallSubscription';
import { IncomingCallOverlay } from '@/components/IncomingCallOverlay';

initSentry();
configureNotifications();
// CallKeep setup is best-effort at module load. Skipped entirely on web
// (no native bridge, no system ring UI). On Android, if react-native-callkeep
// fails to load (e.g. New Architecture incompatibility on this build), DO NOT
// crash app startup — calling falls back gracefully: outgoing audio still
// works via Agora directly; only the system ring UI is affected. Wrap each
// native bridge call in its own try so a partial failure doesn't cascade.
if (Platform.OS !== 'web') {
  try {
    setupCallKeep();
  } catch (err) {
    console.warn('[layout] CallKeep setup failed; calls will degrade gracefully', err);
  }
  try {
    addAnswerListener(({ callUUID }) => {
      callCoord.answer(callUUID).catch(() => {
        /* logged */
      });
    });
    addEndListener(({ callUUID }) => {
      callCoord.declineFromSystemUI(callUUID);
    });
  } catch (err) {
    console.warn('[layout] CallKeep listener registration failed', err);
  }
}

export default function RootLayout() {
  const fontsLoaded = useRedaFonts();
  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.black,
          }}
        >
          <ActivityIndicator color={colors.white} />
        </View>
      </SafeAreaProvider>
    );
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <ErrorBoundary>
        {/* AuthProvider must wrap QueueProvider — the queue keys its
            persisted storage off the signed-in userId via useAuth(). */}
        <AuthProvider>
          <QueueProvider>
            <AuthGate />
          </QueueProvider>
        </AuthProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

// (queue) is a sibling group containing the dead-letter review screen. Any
// active user can navigate to it regardless of role, so we allow it as a
// pass-through group in the gate. (call) is similar — internal Team roster
// and in-call screens are reachable from every role.
const PASSTHROUGH_GROUPS = new Set(['(queue)', '(profile)', '(call)']);

function AuthGate() {
  usePushTokenRegistration();
  const { account } = useAuth();
  useNotificationTapRouting(account.kind === 'active' ? account.role : null);
  useCallInvitePushHandler();
  useIncomingCallSubscription(
    account.kind === 'active' ? account.userId : null,
    account.kind === 'active' ? account.role : null,
  );
  const segments = useSegments();
  const router = useRouter();

  // Biometric lock state. `checking` = haven't read AsyncStorage yet for this
  // session; `needs` = locked, awaiting unlock; `unlocked` = pass through.
  // Resets when the active user id changes (e.g. after sign-out + sign-in).
  const userId = account.kind === 'active' ? account.userId : null;
  const [lockState, setLockState] = useState<'checking' | 'needs' | 'unlocked'>('checking');

  useEffect(() => {
    if (!userId) {
      setLockState('checking');
      return;
    }
    // Web has no biometric API. Even if an enabled flag drifted into
    // localStorage from a previous session, we can't prompt for Face/Touch
    // ID in a browser — short-circuit straight to unlocked.
    if (Platform.OS === 'web') {
      setLockState('unlocked');
      return;
    }
    let cancelled = false;
    setLockState('checking');
    isBiometricEnabled().then((on) => {
      if (cancelled) return;
      setLockState(on ? 'needs' : 'unlocked');
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const currentGroup = segments[0] as string | undefined;
  const expectedRoute = expectedRouteFor(account);
  const expectedGroup = expectedRoute?.split('/')[1]; // e.g. "/(admin)" → "(admin)"
  const inExpectedGroup = expectedGroup !== undefined && currentGroup === expectedGroup;
  const inPassthrough =
    account.kind === 'active' && currentGroup !== undefined && PASSTHROUGH_GROUPS.has(currentGroup);

  useEffect(() => {
    if (!expectedRoute) return; // account still loading
    if (!inExpectedGroup && !inPassthrough) router.replace(expectedRoute);
  }, [expectedRoute, inExpectedGroup, inPassthrough, router]);

  if (!expectedRoute || (!inExpectedGroup && !inPassthrough)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (account.kind === 'active' && lockState === 'needs') {
    return <BiometricLockScreen onUnlock={() => setLockState('unlocked')} />;
  }

  return (
    <>
      <Slot />
      {/* Calls aren't supported on web (Agora bridge + CallKeep ring UI are
          native-only). Skip mounting the overlay entirely; users see the
          "Calls work on the mobile app" hint at the call entry points. */}
      {account.kind === 'active' && Platform.OS !== 'web' ? <IncomingCallOverlay /> : null}
    </>
  );
}

function expectedRouteFor(account: AccountState): `/${string}` | null {
  switch (account.kind) {
    case 'loading':
      return null;
    case 'signed_out':
      return '/(auth)/login';
    case 'incomplete':
      return '/(status)/incomplete';
    case 'unreachable':
      return '/(status)/unreachable';
    case 'deactivated':
      return '/(status)/deactivated';
    case 'active':
      return `/(${account.role})`;
  }
}
