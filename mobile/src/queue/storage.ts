// AsyncStorage-backed persistence for the mutation queue.
//
// Keyed PER USER so a sign-out + different-user sign-in on the same device
// can't see (and therefore can't accidentally replay) the previous user's
// queued mutations. The key shape is `reda:queue:v2:<userId>`.
//
// Why v2: v1 stored everyone's jobs at a single device-scoped key. That
// caused dead-letter items from user A to follow the device to user B,
// who would then see them in their Sync issues screen and the queue would
// try to replay them under B's session — producing "permission denied"
// failures because the RPC's auth.uid() no longer matches the captured
// fromUserId. Versioned key bumps avoid silent migration confusion.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Job } from './types';

const KEY_PREFIX = 'reda:queue:v2';
const LEGACY_KEY = 'reda:queue:v1';

function userKey(userId: string): string {
  return `${KEY_PREFIX}:${userId}`;
}

export async function loadJobs(userId: string): Promise<Job[]> {
  try {
    const raw = await AsyncStorage.getItem(userKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Job[];
  } catch {
    return [];
  }
}

export async function saveJobs(userId: string, jobs: Job[]): Promise<void> {
  await AsyncStorage.setItem(userKey(userId), JSON.stringify(jobs));
}

export async function clearJobs(userId: string): Promise<void> {
  await AsyncStorage.removeItem(userKey(userId));
}

/** One-shot migration of the legacy device-scoped queue (v1) into the
 *  current user's per-user key (v2). The assumption — same as the rest of
 *  the system — is that the currently signed-in user owns any jobs still
 *  sitting at the legacy key. Jobs migrated this way get stamped with
 *  `enqueuedByUserId = userId` so the per-user drain check accepts them.
 *
 *  Returns the number of migrated jobs (for logging). Idempotent: once the
 *  legacy key is consumed, subsequent calls are a no-op. */
export async function migrateLegacyQueue(userId: string): Promise<number> {
  try {
    const legacy = await AsyncStorage.getItem(LEGACY_KEY);
    if (!legacy) return 0;
    const parsed = JSON.parse(legacy);
    if (!Array.isArray(parsed)) {
      await AsyncStorage.removeItem(LEGACY_KEY);
      return 0;
    }
    const stamped = (parsed as Array<Partial<Job> & { enqueuedByUserId?: string }>).map(
      (j) => ({ ...j, enqueuedByUserId: j.enqueuedByUserId ?? userId }) as Job,
    );
    // Merge with anything already at the new key (rare — first-load path is
    // the common one). Concat preserves both lists; the drain skips dups by
    // id anyway.
    const existing = await loadJobs(userId);
    const seen = new Set(existing.map((j) => j.id));
    const merged = [...existing, ...stamped.filter((j) => !seen.has(j.id))];
    await saveJobs(userId, merged);
    await AsyncStorage.removeItem(LEGACY_KEY);
    return stamped.length;
  } catch {
    // Don't let a broken legacy payload block the new code path.
    await AsyncStorage.removeItem(LEGACY_KEY).catch(() => undefined);
    return 0;
  }
}

/** Test-only helper: wipes every per-user queue + the legacy key. Used by
 *  the dead-letter review screen's __clearQueueForTests path. */
export async function clearAllQueueStorageForTests(): Promise<void> {
  const all = await AsyncStorage.getAllKeys();
  const ours = all.filter((k) => k === LEGACY_KEY || k.startsWith(`${KEY_PREFIX}:`));
  if (ours.length > 0) await AsyncStorage.multiRemove(ours);
}
