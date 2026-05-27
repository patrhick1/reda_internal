import { useEffect } from 'react';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import * as coord from '@/lib/calls/coordinator';
import { type Call } from '@/services/calls';
import type { Role } from '@/lib/permissions';

// App-wide subscription to the calls table. Two shapes:
//
//   1) 1:1 calls — `callee_id = me`. Every signed-in non-web user gets this.
//   2) Team calls — `callee_audience = ops_team` and still ringing. Only
//      ops users (admin/dispatcher/rep) subscribe; they're the audience.
//      `accept_call` atomically assigns callee_id on the first accepter,
//      so the same UPDATE-filter sub catches the dismissal-side cleanup
//      for everyone else (their RLS-visible row has flipped off ringing).
//
// Mounted at the root layout via AuthGate — one (or two) channels per
// session, not per screen.
//
// Skipped entirely on web — the callee can't accept (no Agora bridge, no
// CallKeep ring UI). Subscribing would burn a Realtime channel and leave
// coordinator state set to 'incoming' for every call that arrives while the
// browser tab is open, even though the user can't act on it. The call still
// rings on their phone (where the subscription IS active).
export function useIncomingCallSubscription(
  userId: string | null,
  role: Role | null,
): void {
  useEffect(() => {
    if (!userId) return;
    if (Platform.OS === 'web') return;

    const opsRoles: ReadonlyArray<Role> = ['admin', 'dispatcher', 'rep'];
    const isOps = role !== null && opsRoles.includes(role);

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

    // Second channel for ops users: ring rows with audience='ops_team' that
    // are still in the ringing state. The first accepter's UPDATE flips
    // callee_audience to 'user' and sets callee_id, so peers see the row
    // leave this filter on UPDATE and the dismissal handler fires.
    let opsChannel: ReturnType<typeof supabase.channel> | null = null;
    if (isOps) {
      opsChannel = supabase
        .channel(`incoming-team-calls:${userId}`)
        .on(
          'postgres_changes',
          {
            event:  'INSERT',
            schema: 'public',
            table:  'calls',
            filter: 'callee_audience=eq.ops_team',
          },
          async (payload) => {
            const row = payload.new as Call;
            if (row.status !== 'ringing') return;
            // Don't ring yourself if you initiated the team call from another
            // device in this same session.
            if (row.caller_id === userId) return;
            if (new Date(row.ringing_until).getTime() < Date.now()) return;
            const callerName = await fetchCallerName(row.caller_id);
            coord.presentIncoming(row, callerName);
          },
        )
        .on(
          'postgres_changes',
          {
            event:  'UPDATE',
            schema: 'public',
            table:  'calls',
            // After accept, callee_audience flips off ops_team. The losing
            // accepters need to see THAT update, not just rows still in
            // ops_team. Drop the filter so we catch the transition; the
            // body still narrows to our currently-tracked incoming call.
          },
          (payload) => {
            const row = payload.new as Call;
            if (coord.getIncomingCallId() !== row.id) return;
            if (row.status === 'ringing' && row.callee_audience === 'ops_team') return;
            coord.externallyDismissed(row.id);
          },
        )
        .subscribe();
    }

    return () => {
      supabase.removeChannel(channel);
      if (opsChannel) supabase.removeChannel(opsChannel);
    };
  }, [userId, role]);
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
