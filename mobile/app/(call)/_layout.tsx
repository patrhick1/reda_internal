import { Stack } from 'expo-router';

// The (call) group hosts the Team roster and in-call screens. Reachable from
// any role — registered as a passthrough group in app/_layout.tsx so the
// AuthGate doesn't bounce users back to their role group when they navigate
// here.
export default function CallLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="team" />
      <Stack.Screen name="history" />
      <Stack.Screen name="call/[callId]" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
