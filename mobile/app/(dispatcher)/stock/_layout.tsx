// Dispatcher stock is read-only — no receive/transfer/adjust modal routes,
// the shared Overview hides those CTAs via the permission helpers. Just an
// index + per-client detail page.
import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function DispatcherStockLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="client/[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
