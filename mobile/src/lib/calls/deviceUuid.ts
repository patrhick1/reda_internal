import AsyncStorage from '@react-native-async-storage/async-storage';
import { newClientUuid } from '@/lib/uuid';

// Stable per-install UUID. The same value identifies the device across
// app launches for the multi-device accept guard (see scripts/internal-calls.sql:
// accept_call sets accepted_device_uuid; issue-agora-token verifies it).
const KEY = 'reda.calls.device_uuid';
let cached: string | null = null;

export async function getOrCreateDeviceUuid(): Promise<string> {
  if (cached) return cached;
  const stored = await AsyncStorage.getItem(KEY);
  if (stored) {
    cached = stored;
    return stored;
  }
  const fresh = newClientUuid();
  await AsyncStorage.setItem(KEY, fresh);
  cached = fresh;
  return fresh;
}
