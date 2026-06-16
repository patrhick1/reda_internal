// Live unread-message awareness for agents. When an admin/dispatcher replies in
// a delivery thread, a push fires — but pushes are transient and ~1/3 of agents
// have no token, so a missed push left the message invisible. This gives a
// DURABLE in-app signal: a per-delivery unread map that drives the Today row dot
// and the bottom-tab badge.
//
// Refresh strategy mirrors useNeedsReviewCount (poll 30s + AppState 'active')
// PLUS a realtime subscription to delivery_messages — so a reply appears the
// moment it lands, and the badge clears the moment the agent opens the thread
// (mark_messages_read flips read_at → UPDATE event → refetch). RLS scopes the
// read to the agent's own deliveries (see agentUnreadCounts). Pairs with
// scripts/agent-message-unread-realtime.sql.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { agentUnreadCounts } from '@/services/delivery-messages';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';

const POLL_MS = 30_000;

export type AgentUnread = {
  /** delivery_id → number of unread ops messages. */
  byDelivery: ReadonlyMap<string, number>;
  /** Total unread ops messages across all the agent's deliveries. */
  total: number;
};

const EMPTY: AgentUnread = { byDelivery: new Map(), total: 0 };

/** Data hook — call ONCE (in the agent layout) and share via the provider below
 *  so the tab badge and the Today row dots read one subscription. */
export function useAgentUnreadMessagesData(enabled: boolean = true): AgentUnread {
  const [byDelivery, setByDelivery] = useState<ReadonlyMap<string, number>>(() => new Map());

  const refresh = useCallback(async () => {
    try {
      setByDelivery(await agentUnreadCounts());
    } catch {
      // Best-effort: a transient failure leaves the last value until next poll.
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setByDelivery(new Map());
      return;
    }
    let cancelled = false;
    const run = () => {
      if (!cancelled) void refresh();
    };
    run();
    const timer = setInterval(run, POLL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      sub.remove();
    };
  }, [enabled, refresh]);

  // Realtime: any delivery_messages change the agent can see (a new ops reply,
  // or read_at flipping when they open a thread) → refetch the map.
  useSupabaseChannel(
    enabled ? 'agent-unread-messages' : null,
    (ch) =>
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'delivery_messages' },
        () => {
          void refresh();
        },
      ),
    [enabled, refresh],
  );

  return useMemo(() => {
    let total = 0;
    for (const n of byDelivery.values()) total += n;
    return { byDelivery, total };
  }, [byDelivery]);
}

const AgentUnreadContext = createContext<AgentUnread>(EMPTY);

export function AgentUnreadProvider({
  value,
  children,
}: {
  value: AgentUnread;
  children: React.ReactNode;
}) {
  return <AgentUnreadContext.Provider value={value}>{children}</AgentUnreadContext.Provider>;
}

/** Consume the shared unread state inside any agent screen. */
export function useAgentUnread(): AgentUnread {
  return useContext(AgentUnreadContext);
}
