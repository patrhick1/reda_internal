import AsyncStorage from '@react-native-async-storage/async-storage';
import { HINTS, type HintId } from './registry';

/** AsyncStorage key shape: `reda.hint.<hintId>.<userId>`. Per-user so a
 *  shared device / re-sign-in surfaces the same hint to a different user. */
function key(id: HintId, userId: string): string {
  return `reda.hint.${id}.${userId}`;
}

export async function isHintDismissed(id: HintId, userId: string): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(key(id, userId));
    return v === '1';
  } catch {
    // If AsyncStorage is unhealthy, fall back to "show the hint" — losing a
    // dismiss is harmless; suppressing a hint that should appear isn't.
    return false;
  }
}

export async function dismissHint(id: HintId, userId: string): Promise<void> {
  try { await AsyncStorage.setItem(key(id, userId), '1'); } catch { /* swallow */ }
}

/** Clears every dismissed-hint flag for this user across the full HINTS
 *  registry. Used by the Profile "See hints again" row. Other users' flags
 *  on the same device are untouched. */
export async function resetAllHints(userId: string): Promise<void> {
  const keys = Object.values(HINTS).map((id) => key(id, userId));
  try { await AsyncStorage.multiRemove(keys); } catch { /* swallow */ }
}
