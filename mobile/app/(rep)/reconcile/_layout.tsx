import { Stack } from 'expo-router';

// Rep reconcile has its own stack so per-client detail can push on top of the
// client list while keeping the rep tab bar visible underneath. Each screen
// renders its own AppBar, so the native header is hidden.
export default function RepReconcileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="client/[id]" />
    </Stack>
  );
}
