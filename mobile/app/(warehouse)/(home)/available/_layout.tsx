import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function WarehouseAvailableLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[agentId]" options={{ headerShown: false }} />
    </Stack>
  );
}
