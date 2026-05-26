import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

export default function QueueLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        headerStyle: { backgroundColor: colors.white },
        headerTintColor: colors.black,
        headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
      }}
    >
      <Stack.Screen name="dead-letter" />
    </Stack>
  );
}
