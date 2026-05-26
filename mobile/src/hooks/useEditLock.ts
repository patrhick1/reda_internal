import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acquireEditLock,
  heartbeatEditLock,
  releaseEditLock,
  type EditLockEntity,
} from '@/services/editLocks';

const HEARTBEAT_MS = 60_000;

export type EditLockState =
  | { kind: 'loading' }
  | { kind: 'held' }
  | { kind: 'held_by_other'; userId: string; holderName: string; acquiredAt: string }
  | { kind: 'error'; message: string };

export type UseEditLock = {
  state: EditLockState;
  /** Forcibly claim a held lock (audited server-side). */
  takeOver: () => Promise<void>;
  /** Release the lock immediately. Called automatically on unmount, but
   *  consumers can call it explicitly right after a successful save / discard
   *  to avoid the brief window between save and unmount. */
  release: () => Promise<void>;
};

/** Acquires an edit lock for the given entity on mount, heartbeats every
 *  60 seconds, and releases on unmount. Returns one of four states the UI
 *  can render against.
 *
 *  Pass `null` for entityId to skip the lock lifecycle entirely (useful while
 *  a parent screen is still loading the id). */
export function useEditLock(
  entityType: EditLockEntity,
  entityId: string | null,
): UseEditLock {
  const [state, setState] = useState<EditLockState>({ kind: 'loading' });
  const mountedRef = useRef(true);

  const tryAcquire = useCallback(async (takeover: boolean) => {
    if (!entityId) return;
    try {
      const r = await acquireEditLock(entityType, entityId, takeover);
      if (!mountedRef.current) return;
      if (r.isSelf) {
        setState({ kind: 'held' });
      } else {
        setState({
          kind:        'held_by_other',
          userId:      r.heldBy,
          holderName:  r.holderName,
          acquiredAt:  r.acquiredAt,
        });
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [entityType, entityId]);

  // Acquire on mount / when id changes.
  useEffect(() => {
    mountedRef.current = true;
    if (!entityId) {
      setState({ kind: 'loading' });
      return;
    }
    setState({ kind: 'loading' });
    void tryAcquire(false);
    return () => {
      mountedRef.current = false;
      // Fire-and-forget; the next acquire after the 5-min TTL doesn't need
      // this release, but it makes the queue feel responsive.
      if (entityId) {
        releaseEditLock(entityType, entityId).catch(() => { /* swallow */ });
      }
    };
  }, [entityType, entityId, tryAcquire]);

  // Heartbeat while we hold the lock.
  useEffect(() => {
    if (state.kind !== 'held' || !entityId) return;
    const tick = setInterval(() => {
      heartbeatEditLock(entityType, entityId).catch((e) => {
        console.warn('heartbeat_edit_lock failed', e);
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(tick);
  }, [state.kind, entityType, entityId]);

  const takeOver = useCallback(async () => {
    setState({ kind: 'loading' });
    await tryAcquire(true);
  }, [tryAcquire]);

  const release = useCallback(async () => {
    if (!entityId) return;
    await releaseEditLock(entityType, entityId);
  }, [entityType, entityId]);

  return { state, takeOver, release };
}
