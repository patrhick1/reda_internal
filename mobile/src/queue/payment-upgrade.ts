import type { Job } from './types';

/** An older app can exhaust retries while waiting for its update. Only replay
 * jobs rejected by the contract gate, which runs before any business mutation. */
export function recoverPaymentUpgradeJobs(jobs: Job[], now: number): Job[] {
  let changed = false;
  const recovered = jobs.map((job) => {
    if (
      (job.status === 'dead_letter' || job.status === 'failed_retrying') &&
      job.lastError === 'Update REDA before continuing. Rider payment rules have changed.'
    ) {
      changed = true;
      return {
        ...job,
        status: 'pending' as const,
        attempts: 0,
        lastError: null,
        nextAttemptAt: now,
      };
    }
    return job;
  });
  return changed ? recovered : jobs;
}
