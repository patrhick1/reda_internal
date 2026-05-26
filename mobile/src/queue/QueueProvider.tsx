import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { newClientUuid } from '@/lib/uuid';
import { logError } from '@/lib/sentry';
import { errorMessage } from '@/lib/errors';
import { loadJobs, saveJobs, clearJobs } from './storage';
import { executeJob } from './executors';
import {
  BACKOFF_MS, MAX_ATTEMPTS,
  type EnqueueInput, type Job, type JobKind, type QueueSnapshot,
} from './types';

type DrainOpts = { forceImmediate?: boolean };

type QueueContextValue = {
  snapshot: QueueSnapshot;
  enqueue: <K extends JobKind>(input: EnqueueInput<K>) => Promise<string>;
  /** Move dead-letter jobs back to pending with attempts=0. Used by the
   *  dead-letter review screen. */
  retry: (jobIds: string[]) => Promise<void>;
  /** Drop dead-letter jobs the user has decided to abandon. */
  drop: (jobIds: string[]) => Promise<void>;
  /** Force a drain pass now, ignoring backoff. Returns once the pass finishes. */
  drainNow: () => Promise<void>;
  /** True if any job is pending or in-flight (used to block logout). */
  hasUnsynced: boolean;
};

const QueueContext = createContext<QueueContextValue | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [online, setOnline] = useState<boolean>(true);
  const [draining, setDraining] = useState<boolean>(false);
  const bootedRef = useRef(false);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The drain loop runs at most once at a time; this ref guards re-entry.
  const drainingRef = useRef(false);

  // Boot — load persisted jobs once.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    loadJobs().then(setJobs);
  }, []);

  // Persist whenever jobs change. Skip the first render's empty-state write.
  const lastSavedRef = useRef<Job[]>([]);
  useEffect(() => {
    if (jobs === lastSavedRef.current) return;
    lastSavedRef.current = jobs;
    saveJobs(jobs).catch(err => logError('queue.persist', err));
  }, [jobs]);

  // Subscribe to NetInfo. We treat `isInternetReachable === false` as offline,
  // but null/undefined as "assume online" so we don't ping uselessly when the
  // probe hasn't run yet on a fresh launch.
  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      const reachable = state.isInternetReachable;
      setOnline(reachable !== false);
    });
    NetInfo.fetch().then(state => setOnline(state.isInternetReachable !== false));
    return () => { unsub(); };
  }, []);

  const drain = useCallback(async (_opts: DrainOpts = {}) => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setDraining(true);
    try {
      // Drain until no job is eligible right now. The jobs/online useEffect
      // below handles re-scheduling for backoff-pending retries — we don't
      // schedule from inside this loop to avoid a circular dep with schedule().
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = await new Promise<Job | null>(resolve => {
          setJobs(curr => {
            const now = Date.now();
            const eligible = curr.find(
              j => (j.status === 'pending' || j.status === 'failed_retrying') && j.nextAttemptAt <= now,
            );
            resolve(eligible ?? null);
            return curr;
          });
        });
        if (!next) break;

        // Mark in-flight.
        setJobs(curr => curr.map(j => (j.id === next.id ? { ...j, status: 'in_flight' as const } : j)));

        try {
          await executeJob(next);
          setJobs(curr => curr.filter(j => j.id !== next.id));
        } catch (e) {
          const msg = errorMessage(e);
          const nextAttempts = next.attempts + 1;
          const dead = nextAttempts >= MAX_ATTEMPTS;
          const wait = BACKOFF_MS[Math.min(nextAttempts - 1, BACKOFF_MS.length - 1)] ?? 600_000;
          logError('queue.executor', e, { kind: next.kind, attempts: nextAttempts, dead });
          setJobs(curr => curr.map(j => (j.id === next.id ? {
            ...j,
            status: dead ? ('dead_letter' as const) : ('failed_retrying' as const),
            attempts: nextAttempts,
            lastError: msg,
            nextAttemptAt: Date.now() + wait,
          } : j)));
        }
      }
    } finally {
      drainingRef.current = false;
      setDraining(false);
    }
  }, []);

  // Schedule the next drain attempt at the earliest job's nextAttemptAt.
  const schedule = useCallback((minDelayMs: number = 0) => {
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    drainTimerRef.current = setTimeout(() => {
      drainTimerRef.current = null;
      if (online) drain();
    }, Math.max(0, minDelayMs));
  }, [drain, online]);

  // Re-schedule whenever jobs/online changes.
  useEffect(() => {
    if (!online) return;
    const now = Date.now();
    const eligibleNow = jobs.find(
      j => (j.status === 'pending' || j.status === 'failed_retrying') && j.nextAttemptAt <= now,
    );
    if (eligibleNow) {
      schedule(0);
      return;
    }
    const nextWaiting = jobs
      .filter(j => j.status === 'pending' || j.status === 'failed_retrying')
      .reduce<number | null>((earliest, j) =>
        earliest == null || j.nextAttemptAt < earliest ? j.nextAttemptAt : earliest, null);
    if (nextWaiting != null) {
      schedule(nextWaiting - Date.now());
    }
  }, [jobs, online, schedule]);

  // App returns to foreground → try to drain immediately. Useful after a phone
  // sat sleeping with mutations queued.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && online) drain();
    });
    return () => { sub.remove(); };
  }, [drain, online]);

  const enqueue = useCallback<QueueContextValue['enqueue']>(async (input) => {
    const id = newClientUuid();
    const job: Job = {
      id,
      clientUuid: newClientUuid(),
      kind: input.kind,
      args: input.args,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      label: input.label,
    };
    setJobs(curr => [...curr, job]);
    if (online) schedule(0);
    return id;
  }, [online, schedule]);

  const retry = useCallback(async (ids: string[]) => {
    const set = new Set(ids);
    setJobs(curr => curr.map(j => set.has(j.id) ? {
      ...j, status: 'pending' as const, attempts: 0, lastError: null, nextAttemptAt: Date.now(),
    } : j));
    if (online) schedule(0);
  }, [online, schedule]);

  const drop = useCallback(async (ids: string[]) => {
    const set = new Set(ids);
    setJobs(curr => curr.filter(j => !set.has(j.id)));
  }, []);

  const drainNow = useCallback(async () => {
    // Bring forward every retry's nextAttemptAt to now so the drain picks them up.
    setJobs(curr => curr.map(j => j.status === 'failed_retrying' ? { ...j, nextAttemptAt: Date.now() } : j));
    await drain({ forceImmediate: true });
  }, [drain]);

  const hasUnsynced = useMemo(
    () => jobs.some(j => j.status === 'pending' || j.status === 'in_flight' || j.status === 'failed_retrying'),
    [jobs],
  );

  const value = useMemo<QueueContextValue>(() => ({
    snapshot: { jobs, online, draining },
    enqueue, retry, drop, drainNow, hasUnsynced,
  }), [jobs, online, draining, enqueue, retry, drop, drainNow, hasUnsynced]);

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue must be used inside <QueueProvider>');
  return ctx;
}

/** Test-only helper to wipe persistence. Never call from production code. */
export async function __clearQueueForTests(): Promise<void> {
  await clearJobs();
}
