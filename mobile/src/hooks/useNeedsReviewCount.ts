// Live-ish count of bot_inbound_messages in needs_review state. Drives the
// Review tab badge in admin + ops layouts so users see at a glance when
// something needs their attention.
//
// Refresh strategy: poll every 30s + refetch on AppState 'active'. Polling
// is intentional over realtime subscriptions — review work isn't
// sub-second-critical, the count is best-effort, and the extra plumbing
// (channels, RLS reasoning) is not worth it for a badge. Errors are
// swallowed: a transient network blip should not flicker the UI.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { countNeedsReview } from '@/services/bot';

const POLL_MS = 30_000;

export function useNeedsReviewCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const n = await countNeedsReview();
        if (!cancelled) setCount(n);
      } catch {
        // Best-effort. A failure just means the badge stays at its last value
        // until the next successful poll.
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
  }, []);

  return count;
}
