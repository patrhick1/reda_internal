// Warehouse "Stock" tab = a Stack (not loose tab screens). The dashboard
// (index) is the root; Transfer / Receive / Adjust / Available / Movements are
// PUSHED on top. This is what makes `router.back()` both navigate AND unmount
// the action screen after a queued submit settles — the same proven pattern as
// the dispatcher stock stack. When these lived as hidden `Tabs.Screen`s, a
// `router.back()` couldn't pop a root tab route, so a successful Transfer left
// the submit button spinning forever (the screen never unmounted, `submitting`
// never reset). Keeping them on a real stack fixes Transfer, Receive and Adjust
// together.
import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function WarehouseHomeLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      {/* Dashboard renders its own AppBar. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="transfer" options={{ title: 'New transfer' }} />
      <Stack.Screen name="receive" options={{ title: 'Receive stock' }} />
      <Stack.Screen name="adjust" options={{ title: 'Adjustment' }} />
      {/* These carry their own AppBar / nested stack. */}
      <Stack.Screen name="available" options={{ headerShown: false }} />
      <Stack.Screen name="movements/[holderId]" options={{ headerShown: false }} />
    </Stack>
  );
}
