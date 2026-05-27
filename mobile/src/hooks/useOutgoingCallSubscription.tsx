import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getCall, type Call } from '@/services/calls';

// Subscribes to a single calls row via Supabase Realtime. The caller mounts
// this with the call_id it just initiated; updates flow in as the callee
// accepts / declines / the cron expires the row.
//
// Returns the freshest snapshot of the call. Initial value is fetched via
// REST (so the consumer doesn't wait on the first Realtime event). Subsequent
// updates come from the postgres_changes channel.
export function useOutgoingCallSubscription(callId: string | null): Call | null {
  const [call, setCall] = useState<Call | null>(null);
  const lastCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!callId) {
      setCall(null);
      lastCallIdRef.current = null;
      return;
    }

    // If the same callId, don't re-subscribe.
    if (lastCallIdRef.current === callId) return;
    lastCallIdRef.current = callId;

    let cancelled = false;

    // Initial fetch — Realtime only emits CHANGES; without this the consumer
    // would have to wait for a status flip to see anything.
    getCall(callId)
      .then((row) => {
        if (cancelled) return;
        if (row) setCall(row);
      })
      .catch((err) => {
        console.warn('[outgoing-call] initial fetch failed', err);
      });

    const channel = supabase
      .channel(`outgoing-call:${callId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` },
        (payload) => {
          if (cancelled) return;
          setCall(payload.new as Call);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [callId]);

  return call;
}
