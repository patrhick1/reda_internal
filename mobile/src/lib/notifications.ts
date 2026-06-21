import { useEffect } from 'react';
import { Platform } from 'react-native';
import { router, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import type { Role } from '@/lib/permissions';
import { getCall } from '@/services/calls';
import * as callCoord from '@/lib/calls/coordinator';

/**
 * One-time setup for receiving push notifications.
 *  - setNotificationHandler so foreground pushes still raise a banner+sound.
 *    Without this, iOS and modern Android silently drop notifications that
 *    arrive while the app is open.
 *  - On Android, create a 'default' high-importance channel. Android 8+
 *    requires a channel for heads-up display, and we send with channelId
 *    'default' from the Edge Function.
 *
 * Safe to call multiple times — the underlying APIs are idempotent.
 */
export async function configureNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Deliveries',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        lightColor: '#E63027',
        sound: 'default',
      });
    } catch (e) {
      console.warn('android notification channel setup failed', e);
    }
  }
}

/**
 * Handles a tap on a delivery notification by deep-linking to the right
 * detail screen for the signed-in user's role.
 *
 * Routing precedence:
 *   1. data.route ∈ {'review','stock','eod'} → role-specific landing
 *   2. data.delivery_id present → role-specific delivery detail
 *
 *  - Cold-start (app was killed): consume getLastNotificationResponseAsync.
 *  - Warm (background/foreground): subscribe to responses while mounted.
 */
export function useNotificationTapRouting(role: Role | null): void {
  const router = useRouter();

  useEffect(() => {
    // expo-notifications has no web implementation — tapping a browser
    // notification can't deep-link into a route anyway. Mirrors the
    // platform guard in usePushTokenRegistration.
    if (Platform.OS === 'web') return;
    if (!role) return;

    function route(data: Record<string, unknown> | undefined) {
      if (!data) return;
      const dest = pathForRoute(role!, data) ?? pathForDelivery(role!, data);
      if (dest) router.push(dest);
    }

    let cancelled = false;
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (cancelled || !resp) return;
      route(resp.notification.request.content.data as Record<string, unknown> | undefined);
    });

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      route(resp.notification.request.content.data as Record<string, unknown> | undefined);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [role, router]);
}

function pathForRoute(role: Role, data: Record<string, unknown>): `/${string}` | null {
  const r = data.route;
  if (typeof r !== 'string') return null;
  switch (r) {
    case 'review':
      // Admins use /(admin)/needs-review; dispatchers and reps have their own list.
      if (role === 'admin') return '/(admin)/needs-review';
      if (role === 'dispatcher') return '/(dispatcher)/review';
      if (role === 'rep') return '/(rep)/review';
      return null;
    case 'stock':
      // Admin gets the full stock dashboard; warehouse gets their own
      // Stock tab (same dashboard data + the new action buttons).
      if (role === 'admin') return '/(admin)/stock';
      if (role === 'warehouse') return '/(warehouse)';
      return null;
    case 'eod':
      return role === 'admin' ? '/(admin)/eod' : null;
    case 'location_approvals':
      // Agent zone-change approvals — managers only (admin + dispatcher).
      if (role === 'admin') return '/(admin)/location-approvals';
      if (role === 'dispatcher') return '/(dispatcher)/location-approvals';
      return null;
    case 'call_invite':
      // Handled by useCallInvitePushHandler — return null so tap-routing
      // doesn't try to navigate. The push will have already triggered
      // CallKeep via the receive handler.
      return null;
    default:
      return null;
  }
}

/**
 * Handles call_invite pushes:
 *   - On receive (foreground/background): trigger CallKeep ring UI.
 *   - On tap (cold-start): same, then let CallKeep take focus.
 *
 * Idempotent against the Realtime subscription — the coordinator's
 * presentIncoming() dedups on call_id.
 *
 * Mount alongside useNotificationTapRouting in the AuthGate.
 */
export function useCallInvitePushHandler(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;

    let cancelled = false;

    async function handle(data: Record<string, unknown> | undefined, source: 'receive' | 'tap') {
      if (cancelled || !data) return;
      if (data.route !== 'call_invite') return;
      const callId = data.call_id;
      const callerName = data.caller_name;
      const ringingUntil = data.ringing_until;
      if (typeof callId !== 'string') return;

      // Staleness short-circuit: if ringing_until has passed AND it's a tap,
      // deep-link to call history with this call highlighted. On 'receive'
      // we just drop it silently (no point ringing a phantom).
      if (typeof ringingUntil === 'string' && new Date(ringingUntil).getTime() < Date.now()) {
        if (source === 'tap') router.push(`/(call)/history?highlight=${callId}`);
        return;
      }

      // Re-check the row server-side; caller may have cancelled between
      // push send and our receive.
      const row = await getCall(callId).catch(() => null);
      if (!row || row.status !== 'ringing') {
        if (source === 'tap') router.push(`/(call)/history?highlight=${callId}`);
        return;
      }

      callCoord.presentIncoming(
        row,
        typeof callerName === 'string' && callerName ? callerName : 'Reda team',
      );
    }

    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp)
        handle(
          resp.notification.request.content.data as Record<string, unknown> | undefined,
          'tap',
        );
    });

    const recvSub = Notifications.addNotificationReceivedListener((notif) => {
      handle(notif.request.content.data as Record<string, unknown> | undefined, 'receive');
    });
    const respSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      handle(resp.notification.request.content.data as Record<string, unknown> | undefined, 'tap');
    });

    return () => {
      cancelled = true;
      recvSub.remove();
      respSub.remove();
    };
  }, []);
}

function pathForDelivery(role: Role, data: Record<string, unknown>): `/${string}` | null {
  const id = data.delivery_id;
  if (typeof id !== 'string' || id.length === 0) return null;
  switch (role) {
    case 'agent':
      return `/(agent)/today/${id}`;
    case 'dispatcher':
      return `/(dispatcher)/deliveries/${id}`;
    case 'rep':
      return `/(rep)/deliveries/${id}`;
    case 'admin':
      return `/(admin)/deliveries/${id}`;
    case 'warehouse':
      return null;
  }
}
