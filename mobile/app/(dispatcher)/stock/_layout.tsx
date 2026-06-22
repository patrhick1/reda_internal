// Dispatcher stock: Overview + per-client detail + Transfer (warehouse_issue /
// warehouse_return / agent→agent). Receive + Adjust stay warehouse-only —
// dispatcher doesn't hold stock themselves, they just coordinate moves.
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
      <Stack.Screen name="transfer" options={{ title: 'New transfer' }} />
      <Stack.Screen name="holder/[holderId]" options={{ headerShown: false }} />
      <Stack.Screen name="movements/[holderId]" options={{ headerShown: false }} />
      <Stack.Screen name="all-movements" options={{ headerShown: false }} />
      <Stack.Screen name="movements-client/[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
