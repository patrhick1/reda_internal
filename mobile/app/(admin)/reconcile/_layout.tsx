import { Stack } from 'expo-router';

// Reconciliation has its own stack so per-client detail can push on top of the
// main reconcile screen while keeping the admin tab bar visible underneath.
// Header is hidden because each screen renders its own AppBar.
export default function ReconcileLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="client/[id]" />
    </Stack>
  );
}
