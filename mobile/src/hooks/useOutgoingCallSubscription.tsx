import { useEffect, useState } from 'react';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
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

  // Initial REST fetch — Realtime only emits CHANGES; without this the
  // consumer would have to wait for a status flip to see anything. The
  // `cancelled` flag guards against stale-state writes if callId changes
  // (or unmounts) while the fetch is in flight.
  useEffect(() => {
    if (!callId) {
      setCall(null);
      return;
    }
    let cancelled = false;
    getCall(callId)
      .then((row) => {
        if (cancelled) return;
        if (row) setCall(row);
      })
      .catch((err) => {
        console.warn('[outgoing-call] initial fetch failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [callId]);

  // Realtime updates for this specific call row.
  useSupabaseChannel(
    callId ? `outgoing-call:${callId}` : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` },
        (payload) => {
          setCall(payload.new as Call);
        },
      ),
    [callId],
  );

  return call;
}
