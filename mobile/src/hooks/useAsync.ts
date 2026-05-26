import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '@/lib/errors';

/** Minimal fetch-and-cache hook. Returns data/loading/error + a manual reload(). */
export function useAsync<T>(fn: () => Promise<T>, deps: ReadonlyArray<unknown> = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const tick = useRef(0);

  const run = useCallback(async () => {
    const myTick = ++tick.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (myTick !== tick.current) return; // a newer call superseded us
      setData(result);
    } catch (e) {
      if (myTick !== tick.current) return;
      setError(errorMessage(e));
    } finally {
      if (myTick === tick.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
  }, [run]);

  return { data, error, loading, reload: run };
}
