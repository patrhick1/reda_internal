import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.gen';
import { instrumentedFetch, instrumentRealtimeWebSocket } from '@/lib/egress-log';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Copy mobile/.env.example to mobile/.env.local and fill in.',
  );
}

// Dev-only Realtime (websocket) measurement — audit Phase 4's measurement gap.
// MUST run before createClient: realtime-js's WebSocketFactory resolves the
// native `globalThis.WebSocket` when it builds the socket, so the wrapper has to
// be installed first. No-op outside dev.
instrumentRealtimeWebSocket();

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  // Dev-only egress measurement (audit Phase 0). instrumentedFetch is a pass-
  // through in production — the real fetch is returned untouched — so this adds
  // no overhead to release builds.
  global: { fetch: instrumentedFetch(fetch) },
});

/** PostgREST error shape. `code` distinguishes a missing function (PGRST202, or
 *  Postgres' 42883 undefined_function) from a real failure, so callers can keep
 *  a fallback while an RPC is mid-rollout. */
export type RpcError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
};

/**
 * Calls a Postgres RPC that isn't in `database.gen.ts` yet — i.e. the SQL is
 * live but `npm run gen:types` hasn't run (deferred to the Feature A cutover).
 * Use this INSTEAD of hand-casting `supabase.rpc` at the call site. Once the
 * types are regenerated, delete this helper and call `supabase.rpc` directly;
 * every caller becomes a typed one-liner.
 *
 * WHY THIS EXISTS — a real bug, not tidiness (fixed 2026-07-15):
 * `SupabaseClient.rpc` is a PROTOTYPE method whose body is
 * `return this.rest.rpc(...)`. Four call sites had each hand-rolled the cast as
 *
 *     const rpc = supabase.rpc as unknown as (...)   // ← detached from `supabase`
 *     await rpc('some_fn', args)
 *
 * Assigning the method to a variable severs `this`, so the call threw
 * `TypeError: Cannot read properties of undefined (reading 'rest')`
 * SYNCHRONOUSLY, before issuing any request. Because it threw at the call rather
 * than returning `{ error }`, every `if (error) …fallback` below it was
 * unreachable, and no network request was ever made — invisible in the egress
 * log and silent on screen. It shipped broken in four places
 * (count_pending_location_changes, requeue_failed_inbound, preview_eod_rollover,
 * ops_unread_agent_counts).
 *
 * Subtlety worth knowing: casting IN PLACE — `(supabase.rpc as X)(fn, args)` —
 * is safe, because the cast erases and the member reference keeps `this`. Only
 * the variable assignment breaks it. That is why some sites worked and others
 * didn't, which is exactly the kind of inconsistency a single helper removes.
 * An eslint `no-restricted-syntax` rule now rejects the assignment form.
 *
 * @param fn   RPC name, e.g. 'ops_unread_agent_counts'.
 * @param args Named args, e.g. `{ p_exclude_not_my_route: true }`.
 * @returns The usual `{ data, error }`; `data` is asserted to `T` (unvalidated,
 *          same contract the hand-rolled casts had).
 */
export async function rpcUntyped<T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<{ data: T | null; error: RpcError | null }> {
  // .bind is the whole point of this helper — see above.
  const call = supabase.rpc.bind(supabase) as unknown as (
    f: string,
    a: Record<string, unknown>,
  ) => Promise<{ data: T | null; error: RpcError | null }>;
  return call(fn, args ?? {});
}
