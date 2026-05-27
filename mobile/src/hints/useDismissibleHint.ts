import { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from '@/hooks/useAuth';
import { dismissHint, isHintDismissed } from './storage';
import type { HintId } from './registry';

export type UseDismissibleHint = {
  /** `false` while we're checking AsyncStorage on mount and after dismiss. */
  visible: boolean;
  /** Fire-and-forget. Hides the hint locally on the next render and writes
   *  the dismiss flag in the background. */
  dismiss: () => void;
};

/** Drives the `<Hint>` component. Reads the dismiss flag from AsyncStorage
 *  once on mount; flips local state immediately on dismiss so the UI doesn't
 *  wait on the write. */
export function useDismissibleHint(id: HintId): UseDismissibleHint {
  const user = useCurrentUser();
  // `undefined` = still loading; `true` = render the hint; `false` = hidden.
  const [visible, setVisible] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const dismissed = await isHintDismissed(id, user.userId);
      if (cancelled) return;
      setVisible(!dismissed);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user.userId]);

  const dismiss = useCallback(() => {
    setVisible(false);
    // Fire-and-forget; if the write fails the hint just shows again next session.
    void dismissHint(id, user.userId);
  }, [id, user.userId]);

  return { visible: visible === true, dismiss };
}
