import { useEffect, useId, type DependencyList } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

/**
 * Realtime subscription with built-in protection against the supabase-js
 * singleton race. The `supabase` client persists across HMR / Fast Refresh
 * and React's effect double-invoke cycle; channels are keyed globally by
 * topic name, and `supabase.removeChannel` only evicts from the registry
 * after the server acks the LEAVE. If a re-mount happens before that ack,
 * `supabase.channel(name)` returns the still-subscribed channel and the
 * next `.on(...)` throws "cannot add postgres_changes callbacks after
 * subscribe()". Suffixing every topic with a per-mount unique id makes
 * the collision impossible.
 *
 * @param topic   Base channel name. Pass null to skip subscribing (use for
 *                conditional subs like web-only or ops-only). Interpolate
 *                any varying identifiers (delivery id, user id, etc.) into
 *                this string so topic equality drives effect re-runs.
 * @param setup   Configures the channel with `.on(...)` listeners. Called
 *                with a freshly-created channel; must return it (the
 *                `.on()` chain does this naturally). `.subscribe()` is
 *                invoked by the hook AFTER `setup` returns, so listeners
 *                are always added before subscribe — the v2 contract.
 * @param deps    Additional deps that should retrigger the subscription.
 *                `topic` is always included implicitly; put any extra
 *                state the `setup` closure reads here.
 */
export function useSupabaseChannel(
  topic: string | null,
  setup: (channel: RealtimeChannel) => RealtimeChannel,
  deps: DependencyList,
): void {
  const instanceId = useId();
  useEffect(() => {
    if (!topic) return;
    const channel = setup(supabase.channel(`${topic}:${instanceId}`));
    channel.subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // setup is intentionally excluded — callers pass fresh closures every
    // render and the deps array names what actually matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, instanceId, ...deps]);
}
