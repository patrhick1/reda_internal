import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import { colors, fonts } from '@/lib/theme';
import { Icon } from '@/components/ui';

// Don't hammer the update server: at most one check per this interval, however
// often the app is foregrounded.
const MIN_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Foreground auto-updater with a gentle, non-blocking prompt.
 *
 * Expo's default `checkAutomatically: ON_LOAD` only fires on a true COLD start,
 * which rarely happens because phones keep the app warm for days — so users
 * seldom pick up an OTA update without manually tapping "Check for updates" in
 * Profile. Mounted at the app root, this re-checks whenever the app returns to
 * the FOREGROUND (throttled), downloads any available update in the background,
 * and — once it's staged (`isUpdatePending`) — shows a small "Update ready ·
 * Restart" banner. Nothing is forced: the user restarts when convenient, or
 * dismisses it.
 *
 * JS/asset updates only (native changes still need a store build). Self-guards
 * to real builds via `Updates.isEnabled`, so it's a no-op in dev / Expo Go / web.
 */
export function AutoUpdateBanner() {
  const { isUpdatePending } = useUpdates();
  const insets = useSafeAreaInsets();
  const lastCheckedAt = useRef(0);
  const inFlight = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const checkForUpdate = useCallback(async () => {
    if (__DEV__ || !Updates.isEnabled) return;
    if (inFlight.current) return;
    const now = Date.now();
    if (now - lastCheckedAt.current < MIN_CHECK_INTERVAL_MS) return;
    inFlight.current = true;
    lastCheckedAt.current = now;
    try {
      const res = await Updates.checkForUpdateAsync();
      // fetch stages the bundle → flips useUpdates().isUpdatePending → banner shows.
      if (res.isAvailable) await Updates.fetchUpdateAsync();
    } catch {
      // Offline / no update / transient error — stay silent and retry next foreground.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    checkForUpdate(); // initial foreground (app open)
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') checkForUpdate();
    });
    return () => sub.remove();
  }, [checkForUpdate]);

  // A newly-staged update should re-surface even if a previous prompt was dismissed.
  useEffect(() => {
    if (isUpdatePending) setDismissed(false);
  }, [isUpdatePending]);

  const restart = useCallback(async () => {
    setRestarting(true);
    try {
      await Updates.reloadAsync();
    } catch {
      setRestarting(false); // reload failed — let them tap again
    }
  }, []);

  if (!isUpdatePending || dismissed) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: insets.bottom + 12,
        alignItems: 'center',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          maxWidth: 480,
          backgroundColor: colors.black,
          borderRadius: 14,
          paddingLeft: 14,
          paddingRight: 8,
          paddingVertical: 10,
          shadowColor: colors.black,
          shadowOpacity: 0.2,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }}
      >
        <Icon name="refresh" size={18} color={colors.white} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.white }}>
            Update ready
          </Text>
          <Text
            style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.border, marginTop: 1 }}
          >
            Restart to apply the latest version
          </Text>
        </View>
        <Pressable
          onPress={restart}
          disabled={restarting}
          hitSlop={8}
          style={{
            minWidth: 78,
            alignItems: 'center',
            backgroundColor: colors.white,
            borderRadius: 9,
            paddingHorizontal: 14,
            paddingVertical: 8,
          }}
        >
          {restarting ? (
            <ActivityIndicator size="small" color={colors.black} />
          ) : (
            <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.black }}>
              Restart
            </Text>
          )}
        </Pressable>
        <Pressable onPress={() => setDismissed(true)} hitSlop={8} style={{ padding: 6 }}>
          <Icon name="x" size={16} color={colors.border} />
        </Pressable>
      </View>
    </View>
  );
}
