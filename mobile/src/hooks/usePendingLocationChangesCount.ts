// Live-ish count of pending agent zone-change requests. Drives the at-a-glance
// entry on the admin Home / dispatcher Dashboard so managers know when a
// pay-raising zone change is waiting on them. Same best-effort polling strategy
// as useNeedsReviewCount (30s + on AppState 'active'; errors swallowed).

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { countPendingLocationChanges } from '@/services/deliveries';

const POLL_MS = 30_000;

// `enabled` lets non-manager roles skip the poll entirely (the RPC returns
// nothing for them anyway). Disabled → stays 0, no network.
export function usePendingLocationChangesCount(enabled: boolean = true): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function refresh() {
      try {
        const n = await countPendingLocationChanges();
        if (!cancelled) setCount(n);
      } catch {
        // Best-effort: keep the last value on a transient failure.
      }
    }

    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled]);

  return count;
}
