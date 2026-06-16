// Shared "enqueue → stay on-screen until settled" lifecycle for the stock
// write screens (Transfer / Receive / Adjust). Centralises the submit state
// (error + submitting), the offline shortcut, and the settle-watch effect so
// the three screens don't each carry their own copy (which would drift).
//
// Behaviour:
//  - offline at submit → trust the queue and leave (the global QueueBanner
//    surfaces sync state); the screens keep their own "will sync" affordance.
//  - online → watch the enqueued jobs. All succeed → leave. Any dead-letter →
//    surface the reason inline (via makeFailureMessage), drop the dead jobs so
//    they don't also linger in the banner, and re-enable the form.
//  - `retrying` lets a screen show "still trying" while a transient failure is
//    in backoff, instead of a bare spinner.

import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { useQueue } from './QueueProvider';
import { useWatchQueueJobs } from './useWatchQueueJobs';

export type QueuedSubmit = {
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
  /** Call after enqueuing this submit's jobs, with their ids. */
  finish: (ids: string[]) => void;
  /** Online and at least one queued job failed once and is retrying. */
  retrying: boolean;
};

/**
 * @param makeFailureMessage builds the inline error when one or more jobs
 *   dead-letter: (failedCount, totalCount, firstReason) => message. Pass a
 *   STABLE reference (module-scope fn or useCallback) so the settle effect
 *   doesn't re-run every render.
 */
export function useQueuedSubmit(
  makeFailureMessage: (failed: number, total: number, firstReason: string) => string,
): QueuedSubmit {
  const { snapshot, drainNow, drop } = useQueue();
  const [watchIds, setWatchIds] = useState<string[] | null>(null);
  const watch = useWatchQueueJobs(watchIds);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const finish = useCallback(
    (ids: string[]) => {
      if (!snapshot.online) {
        router.back();
        return;
      }
      setWatchIds(ids);
      void drainNow();
    },
    [snapshot.online, drainNow],
  );

  useEffect(() => {
    if (!watchIds || !watch.settled) return;
    if (watch.failed.length === 0) {
      router.back();
      return;
    }
    const firstReason = watch.failed[0]?.lastError ?? 'Operation failed';
    setError(makeFailureMessage(watch.failed.length, watchIds.length, firstReason));
    setSubmitting(false);
    void drop(watch.failed.map((j) => j.id));
    setWatchIds(null);
  }, [watch, watchIds, drop, makeFailureMessage]);

  return {
    submitting,
    setSubmitting,
    error,
    setError,
    finish,
    retrying: watch.retrying > 0,
  };
}
