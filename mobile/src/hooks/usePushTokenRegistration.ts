import { useEffect } from 'react';
import { Platform } from 'react-native';
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
 * Runs once per login; we don't auto-refresh on every render.
 */
export function usePushTokenRegistration() {
  const { account } = useAuth();
  const userId = account.kind === 'active' ? account.userId : null;

  useEffect(() => {
    if (!userId) return;
    if (Platform.OS === 'web') return;
    if (!Device.isDevice) return;

    let cancelled = false;
    (async () => {
      try {
        const existing = await Notifications.getPermissionsAsync();
        let granted = existing.granted;
        if (!granted) {
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

        const deviceLabel = Device.modelName ?? Device.deviceName ?? null;
        await supabase.rpc('set_my_expo_push_token', {
          p_token: token.data,
          p_platform: Platform.OS,
          p_device_label: deviceLabel ?? undefined,
        });
        await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token.data);
      } catch (e) {
        // Best-effort — but log so we can diagnose the 18-of-20-users-with-no-token
        // mystery. Permission denials, projectId mismatches, and FCM init failures
        // all surface here.
        console.warn('push token registration failed', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);
}
