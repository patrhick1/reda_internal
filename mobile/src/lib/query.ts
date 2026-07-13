// Shared React Query client (audit Phase 2 — stale-while-revalidate cache).
//
// A single app-wide QueryClient so screens sharing a query key (reference data,
// deliveries, stock, …) hit ONE cache instead of each firing its own request.
// Cached data renders immediately while a background revalidate checks freshness,
// so back-navigation is instant and repeated reference fetches collapse to one.
//
// Exported as a module singleton (not just via context) so non-React code — the
// sign-out flow in useAuth — can clear it to prevent one account's data leaking
// into the next.

import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Conservative default; per-query hooks widen it (reference data) or keep
      // it short (deliveries/stock). SWR means a stale query still returns its
      // cached value instantly and revalidates in the background.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 2,
      refetchOnWindowFocus: true, // respects staleTime — only refetches if stale
      refetchOnReconnect: true,
    },
  },
});

// Online/offline from NetInfo so React Query pauses fetches when the device is
// offline and resumes on reconnect (works on web too).
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => setOnline(!!state.isConnected)),
);

// Focus from AppState on native so refetchOnWindowFocus fires when the app
// returns to the foreground. On web we leave React Query's built-in
// visibilitychange handling in place (AppState there is a thin shim).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (status) => {
    focusManager.setFocused(status === 'active');
  });
}
