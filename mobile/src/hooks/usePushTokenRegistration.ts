import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';

export const PUSH_TOKEN_STORAGE_KEY = 'reda.push.lastToken';

/**
 * Registers the Expo push token for the currently signed-in user.
 * No-op on web (no native push) and in simulators (no token available).
 *
 * Retries on every app foreground (AppState 'active'), not just login — a
 * single login-time attempt was leaving ~1/3 of agents with no token when that
 * one shot hit a transient FCM-init / projectId / token-refresh failure, so a
 * reply notification silently went nowhere. `set_my_expo_push_token` upserts,
 * so re-running is cheap and idempotent. (A hard permission denial still can't
 * be re-prompted by the OS — that subset needs a manual settings nudge.)
 */
export function usePushTokenRegistration() {
  const { account } = useAuth();
  const userId = account.kind === 'active' ? account.userId : null;

  useEffect(() => {
    if (!userId) return;
    if (Platform.OS === 'web') return;
    if (!Device.isDevice) return;

    let cancelled = false;

    async function register() {
      try {
        const existing = await Notifications.getPermissionsAsync();
        let granted = existing.granted;
        if (!granted && existing.canAskAgain) {
          const req = await Notifications.requestPermissionsAsync();
          granted = req.granted;
        }
        if (!granted || cancelled) return;

        const projectId =
          Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

        const token = await Notifications.getExpoPushTokenAsync(
          projectId ? { projectId } : undefined,
        );
        if (cancelled || !token?.data) return;

        // Skip the network write when the token is unchanged since last success.
        const last = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
        if (last === token.data) return;

        const deviceLabel = Device.modelName ?? Device.deviceName ?? null;
        await supabase.rpc('set_my_expo_push_token', {
          p_token: token.data,
          p_platform: Platform.OS,
          p_device_label: deviceLabel ?? undefined,
        });
        await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token.data);
      } catch (e) {
        // Best-effort — but log so we can diagnose the agents-with-no-token
        // mystery. Permission denials, projectId mismatches, and FCM init
        // failures all surface here. Foreground retry recovers transient ones.
        console.warn('push token registration failed', e);
      }
    }

    void register();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void register();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [userId]);
}
