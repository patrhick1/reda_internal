import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import * as coord from '@/lib/calls/coordinator';
import { type Call } from '@/services/calls';

// App-wide subscription to the calls table, filtered to rows where I'm the
// callee. Mounts at the root layout via AuthGate — one channel per session,
// not per screen.
//
// Insert with status='ringing'  → coord.presentIncoming(...)
// Update where status flips off 'ringing' (without us accepting first) → coord.externallyDismissed(...)
export function useIncomingCallSubscription(userId: string | null): void {
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`incoming-calls:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee_id=eq.${userId}` },
        async (payload) => {
          const row = payload.new as Call;
          if (row.status !== 'ringing') return;
          // Staleness short-circuit (ringing_until already past).
          if (new Date(row.ringing_until).getTime() < Date.now()) return;
          const callerName = await fetchCallerName(row.caller_id);
          coord.presentIncoming(row, callerName);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls', filter: `callee_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as Call;
          // We CANNOT read payload.old.status reliably — the calls table has
          // REPLICA IDENTITY default, so the OLD payload only contains the
          // primary key. Instead, check against the coordinator's own
          // tracked-incoming state. If we're currently showing this call's
          // ring UI and the row is no longer 'ringing', dismiss.
          if (row.status !== 'ringing' && coord.getIncomingCallId() === row.id) {
            coord.externallyDismissed(row.id);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);
}

async function fetchCallerName(callerId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('users')
      .select('display_name')
      .eq('id', callerId)
      .maybeSingle();
    return (data?.display_name as string | undefined) ?? 'Reda team';
  } catch {
    return 'Reda team';
  }
}
