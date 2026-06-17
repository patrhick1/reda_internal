import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { newClientUuid } from '@/lib/uuid';
import { logError } from '@/lib/sentry';
import { errorMessage, TerminalError } from '@/lib/errors';
import { useAuth } from '@/hooks/useAuth';
import { loadJobs, saveJobs, migrateLegacyQueue, clearAllQueueStorageForTests } from './storage';
import { executeJob } from './executors';
import {
  BACKOFF_MS,
  MAX_ATTEMPTS,
  type EnqueueInput,
  type Job,
  type JobKind,
  type QueueSnapshot,
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
  /** True if any job is pending, in-flight, retrying, OR dead-lettered.
   *  Dead-lettered jobs are still "unsynced" — the user needs to review +
   *  discard them deliberately, not silently lose them on sign-out. */
  hasUnsynced: boolean;
};

const QueueContext = createContext<QueueContextValue | null>(null);

export function QueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [online, setOnline] = useState<boolean>(true);
  const [draining, setDraining] = useState<boolean>(false);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The drain loop runs at most once at a time; this ref guards re-entry.
  const drainingRef = useRef(false);

  // The current owner of the in-memory queue. Set after a successful load
  // of that user's persisted jobs; cleared on sign-out / before a swap.
  // Enqueue + persist + drain all gate on it, so jobs never leak across
  // sessions even mid-render.
  const ownerRef = useRef<string | null>(null);

  const { account } = useAuth();
  // signed_out / loading have no userId; everything else (active,
  // incomplete, deactivated) does. We track the queue against whichever
  // user the session reports — even deactivated users keep ownership of
  // their unsynced work until they re-authenticate as someone else.
  const userId =
    account.kind === 'signed_out' || account.kind === 'loading' ? null : account.userId;

  // Boot / user-swap. On every userId change we wipe the in-memory queue
  // first (and clear ownerRef so the persist + drain effects below are
  // disabled during the gap), then load the new user's persisted queue
  // and re-arm ownership. Persist effect is keyed off ownerRef.current ===
  // userId so the gap between userId changing and the async load
  // resolving cannot accidentally clobber either user's storage.
  const lastSavedRef = useRef<Job[]>([]);
  useEffect(() => {
    let cancelled = false;
    ownerRef.current = null;
    lastSavedRef.current = [];
    setJobs([]);
    if (!userId) return;
    (async () => {
      const migrated = await migrateLegacyQueue(userId);
      if (migrated > 0) {
        logError(
          'queue.migrate',
          new Error(`migrated ${migrated} legacy queue jobs to per-user key`),
        );
      }
      const loaded = await loadJobs(userId);
      if (cancelled) return;
      // Reconcile orphaned in-flight jobs. A job persisted as `in_flight`
      // means the app died between marking it in-flight and the RPC
      // resolving (reboot, OS kill, crash, force-close). Nothing in the
      // drain loop or re-schedule effect picks `in_flight` back up, so left
      // alone these jobs are stuck forever — counted by the banner as
      // "Syncing N…" but never drained, retried, or surfaced in the
      // dead-letter screen. Reset them to `pending` so the drain replays
      // them. Safe: every RPC is idempotent on `clientUuid`, so a job that
      // actually landed server-side before the kill replays as a no-op.
      const hasOrphaned = loaded.some((j) => j.status === 'in_flight');
      const reconciled = hasOrphaned
        ? loaded.map((j) =>
            j.status === 'in_flight'
              ? { ...j, status: 'pending' as const, nextAttemptAt: Date.now() }
              : j,
          )
        : loaded;
      // When nothing was reconciled, keep jobs === lastSavedRef so the
      // persist effect skips a redundant write. When we did reconcile, leave
      // them mismatched so the effect flushes the repaired state to disk.
      lastSavedRef.current = loaded;
      setJobs(reconciled);
      ownerRef.current = userId;
    })().catch((err) => logError('queue.boot', err));
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Persist whenever jobs change. Gated on ownerRef matching userId so the
  // load-in-flight window can't write to the wrong key.
  useEffect(() => {
    if (jobs === lastSavedRef.current) return;
    const owner = ownerRef.current;
    if (!owner || owner !== userId) return;
    lastSavedRef.current = jobs;
    saveJobs(owner, jobs).catch((err) => logError('queue.persist', err));
  }, [jobs, userId]);

  // Subscribe to NetInfo. We treat `isInternetReachable === false` as offline,
  // but null/undefined as "assume online" so we don't ping uselessly when the
  // probe hasn't run yet on a fresh launch.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const reachable = state.isInternetReachable;
      setOnline(reachable !== false);
    });
    NetInfo.fetch().then((state) => setOnline(state.isInternetReachable !== false));
    return () => {
      unsub();
    };
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
        const next = await new Promise<Job | null>((resolve) => {
          setJobs((curr) => {
            const now = Date.now();
            const eligible = curr.find(
              (j) =>
                (j.status === 'pending' || j.status === 'failed_retrying') &&
                j.nextAttemptAt <= now,
            );
            resolve(eligible ?? null);
            return curr;
          });
        });
        if (!next) break;

        // Defense in depth: never fire an RPC for a job that a different
        // user enqueued. Per-user storage keying already prevents this in
        // the happy path; this guard catches any future bug crossing that
        // boundary (e.g. a misconfigured migration or a shared-instance
        // race) without letting it manifest as a server-side permission
        // denial.
        if (next.enqueuedByUserId !== ownerRef.current) {
          setJobs((curr) =>
            curr.map((j) =>
              j.id === next.id
                ? {
                    ...j,
                    status: 'dead_letter' as const,
                    lastError: 'enqueued by a different user',
                    nextAttemptAt: Date.now(),
                  }
                : j,
            ),
          );
          continue;
        }

        // Mark in-flight.
        setJobs((curr) =>
          curr.map((j) => (j.id === next.id ? { ...j, status: 'in_flight' as const } : j)),
        );

        try {
          await executeJob(next);
          setJobs((curr) => curr.filter((j) => j.id !== next.id));
        } catch (e) {
          const msg = errorMessage(e);
          const isTerminal = e instanceof TerminalError;
          const nextAttempts = next.attempts + 1;
          // Terminal errors (insufficient_stock, RLS deny, constraint
          // violation) won't succeed on retry — skip backoff and surface
          // the message via the banner immediately.
          const dead = isTerminal || nextAttempts >= MAX_ATTEMPTS;
          const wait = BACKOFF_MS[Math.min(nextAttempts - 1, BACKOFF_MS.length - 1)] ?? 600_000;
          logError('queue.executor', e, {
            kind: next.kind,
            attempts: nextAttempts,
            dead,
            terminal: isTerminal,
          });
          setJobs((curr) =>
            curr.map((j) =>
              j.id === next.id
                ? {
                    ...j,
                    status: dead ? ('dead_letter' as const) : ('failed_retrying' as const),
                    attempts: nextAttempts,
                    lastError: msg,
                    nextAttemptAt: Date.now() + (dead ? 0 : wait),
                  }
                : j,
            ),
          );
        }
      }
    } finally {
      drainingRef.current = false;
      setDraining(false);
    }
  }, []);

  // Schedule the next drain attempt at the earliest job's nextAttemptAt.
  const schedule = useCallback(
    (minDelayMs: number = 0) => {
      if (drainTimerRef.current) {
        clearTimeout(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      drainTimerRef.current = setTimeout(
        () => {
          drainTimerRef.current = null;
          if (online) drain();
        },
        Math.max(0, minDelayMs),
      );
    },
    [drain, online],
  );

  // Re-schedule whenever jobs/online changes.
  useEffect(() => {
    if (!online) return;
    const now = Date.now();
    const eligibleNow = jobs.find(
      (j) => (j.status === 'pending' || j.status === 'failed_retrying') && j.nextAttemptAt <= now,
    );
    if (eligibleNow) {
      schedule(0);
      return;
    }
    const nextWaiting = jobs
      .filter((j) => j.status === 'pending' || j.status === 'failed_retrying')
      .reduce<
        number | null
      >((earliest, j) => (earliest == null || j.nextAttemptAt < earliest ? j.nextAttemptAt : earliest), null);
    if (nextWaiting != null) {
      schedule(nextWaiting - Date.now());
    }
  }, [jobs, online, schedule]);

  // App returns to foreground → try to drain immediately. Useful after a phone
  // sat sleeping with mutations queued.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && online) drain();
    });
    return () => {
      sub.remove();
    };
  }, [drain, online]);

  const enqueue = useCallback<QueueContextValue['enqueue']>(
    async (input) => {
      const owner = ownerRef.current;
      if (!owner) {
        throw new Error('cannot enqueue: not signed in');
      }
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
        enqueuedByUserId: owner,
      };
      setJobs((curr) => [...curr, job]);
      if (online) schedule(0);
      return id;
    },
    [online, schedule],
  );

  const retry = useCallback(
    async (ids: string[]) => {
      const set = new Set(ids);
      setJobs((curr) =>
        curr.map((j) =>
          set.has(j.id)
            ? {
                ...j,
                status: 'pending' as const,
                attempts: 0,
                lastError: null,
                nextAttemptAt: Date.now(),
              }
            : j,
        ),
      );
      if (online) schedule(0);
    },
    [online, schedule],
  );

  const drop = useCallback(async (ids: string[]) => {
    const set = new Set(ids);
    setJobs((curr) => curr.filter((j) => !set.has(j.id)));
  }, []);

  const drainNow = useCallback(async () => {
    // Bring forward every retry's nextAttemptAt to now so the drain picks them up.
    setJobs((curr) =>
      curr.map((j) => (j.status === 'failed_retrying' ? { ...j, nextAttemptAt: Date.now() } : j)),
    );
    await drain({ forceImmediate: true });
  }, [drain]);

  const hasUnsynced = useMemo(
    () =>
      jobs.some(
        (j) =>
          j.status === 'pending' ||
          j.status === 'in_flight' ||
          j.status === 'failed_retrying' ||
          j.status === 'dead_letter',
      ),
    [jobs],
  );

  const value = useMemo<QueueContextValue>(
    () => ({
      snapshot: { jobs, online, draining },
      enqueue,
      retry,
      drop,
      drainNow,
      hasUnsynced,
    }),
    [jobs, online, draining, enqueue, retry, drop, drainNow, hasUnsynced],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueContextValue {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue must be used inside <QueueProvider>');
  return ctx;
}

/** Test-only helper to wipe every per-user queue + the legacy key.
 *  Never call from production code. */
export async function __clearQueueForTests(): Promise<void> {
  await clearAllQueueStorageForTests();
}
