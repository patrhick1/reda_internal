import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';

/** Minimal fetch-and-cache hook. Returns data/loading/error + a manual reload().
 *
 * `fn` is handed an AbortSignal. A read service that forwards it to Supabase's
 * `.abortSignal()` gets its in-flight request CANCELLED the moment deps change,
 * the component unmounts, or reload() supersedes it — so a fast-changing search
 * or filter stops draining egress on responses nobody will render. Services that
 * ignore the signal are unaffected: the stale result is still discarded by the
 * tick guard, it just isn't cancelled on the wire. Existing `() => …` callers
 * keep working — they simply don't receive the argument. */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const myTick = ++tick.current;
    // Cancel a request still in flight from a previous run (rapid dep change or
    // a manual reload) before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await fn(controller.signal);
      if (myTick !== tick.current) return; // a newer call superseded us
      setData(result);
    } catch (e) {
      if (myTick !== tick.current) return;
      if (controller.signal.aborted) return; // intentional cancel, not an error
      setError(errorMessage(e));
    } finally {
      if (myTick === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // Abort on unmount / before the next run when deps change.
    return () => abortRef.current?.abort();
  }, [run]);

  return { data, error, loading, reload: run };
}
