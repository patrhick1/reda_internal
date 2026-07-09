import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

/**
 * Re-run `reload` whenever the screen regains focus, but SKIP the very first
 * focus. `useAsync` already fetches once on mount, and `useFocusEffect` fires
 * on that same initial focus — so a naive `useFocusEffect(reload)` double-fetches
 * every screen the moment it opens. Skipping the first focus keeps the
 * refetch-on-return behaviour (navigate away and back → fresh data) without the
 * duplicate initial request.
 *
 * `reload` is read through a ref, so the latest closure is always called and the
 * focus subscription never re-registers (no eslint dep churn at call sites).
 */
export function useReloadOnFocus(reload: () => void) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const seenFirstFocus = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!seenFirstFocus.current) {
        seenFirstFocus.current = true;
        return;
      }
      reloadRef.current();
    }, []),
  );
}
