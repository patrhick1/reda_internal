import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function WarehouseByClientLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      {/* Both screens carry their own AppBar. */}
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
