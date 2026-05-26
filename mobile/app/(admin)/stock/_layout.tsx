import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function AdminStockLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      <Stack.Screen name="index"      options={{ headerShown: false }} />
      <Stack.Screen name="adjust"     options={{ title: 'New adjustment', presentation: 'modal' }} />
      <Stack.Screen name="transfer"   options={{ title: 'New transfer',   presentation: 'modal' }} />
      <Stack.Screen name="receive"    options={{ title: 'Receive stock',  presentation: 'modal' }} />
      <Stack.Screen name="client/[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
