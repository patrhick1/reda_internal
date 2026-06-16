// Watch a set of just-enqueued jobs until they settle, so a screen can keep
// the user present with a clear pending/failed state instead of firing
// `router.back()` the instant a job is queued (which hides a later
// dead-letter behind the global QueueBanner — the "it just spins, nothing
// happened" complaint). Mirrors the single-job watch in deliveries/Detail.tsx:
// a job removed from the queue = succeeded; a job still present with
// status='dead_letter' = permanently failed.

import { useMemo } from 'react';
import { useQueue } from './QueueProvider';
import type { Job } from './types';

export type WatchedJobsState = {
  /** Watched jobs still working (pending / in_flight / failed_retrying). */
  pending: number;
  /** Subset of `pending` that has already failed at least once and is in
   *  backoff. Lets a caller show "still trying" instead of a bare spinner. */
  retrying: number;
  /** Watched jobs that hit the retry cap or a terminal error. */
  failed: Job[];
  /** True once every watched id is gone (succeeded) or dead-lettered. False
   *  when there's nothing to watch, so callers can gate on it safely. */
  settled: boolean;
};

export function useWatchQueueJobs(ids: readonly string[] | null): WatchedJobsState {
  const { snapshot } = useQueue();
  return useMemo(() => {
    if (!ids || ids.length === 0) return { pending: 0, retrying: 0, failed: [], settled: false };
    const byId = new Map(snapshot.jobs.map((j) => [j.id, j] as const));
    let pending = 0;
    let retrying = 0;
    const failed: Job[] = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (!job) continue; // removed from queue → succeeded
      if (job.status === 'dead_letter') {
        failed.push(job);
      } else {
        pending += 1;
        if (job.status === 'failed_retrying') retrying += 1;
      }
    }
    return { pending, retrying, failed, settled: pending === 0 };
  }, [ids, snapshot.jobs]);
}
