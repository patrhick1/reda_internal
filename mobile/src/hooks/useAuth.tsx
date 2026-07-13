import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { queryClient } from '@/lib/query';
import { PUSH_TOKEN_STORAGE_KEY } from '@/hooks/usePushTokenRegistration';
import { isRole, type Role } from '@/lib/permissions';

export type AccountState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'incomplete'; userId: string; email: string | null } // auth user exists but no public.users row
  // Sign-in succeeded but we couldn't fetch the profile because the backend was
  // unreachable (network drop, or a Supabase 5xx/503 outage). NOT an account
  // problem — retried automatically with backoff. Distinct from 'incomplete' so
  // an outage doesn't tell every agent to "contact your admin".
  | { kind: 'unreachable'; userId: string; email: string | null }
  | { kind: 'deactivated'; userId: string; email: string }
  | {
      kind: 'active';
      userId: string;
      email: string;
      role: Role;
      displayName: string;
      /** For role='warehouse' STAFF, the place (warehouse holder) they act on.
       *  NULL for everyone else AND for a warehouse user that IS a place.
       *  Warehouse-scope stock screens use `warehouseId ?? userId` as the holder. */
      warehouseId: string | null;
    };

type AuthContextValue = {
  account: AccountState;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** Force an immediate re-fetch of the profile (used by the "Try again" button
   *  on the unreachable screen). Also resets the auto-retry backoff. */
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [account, setAccount] = useState<AccountState>({ kind: 'loading' });
  // Bumping this re-runs the profile-resolve effect (auto-retry + manual retry).
  const [resolveTick, setResolveTick] = useState(0);
  const retryAttempt = useRef(0); // consecutive transient failures, for backoff
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Subscribe to auth events. We deliberately key downstream effects off the
  // user id (a stable string) rather than the session object, since
  // onAuthStateChange fires for many events (INITIAL_SESSION, TOKEN_REFRESHED,
  // SIGNED_IN, …) each producing a fresh Session reference. Keying off the
  // object reference here caused a fetch loop on public.users.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthUserId(data.session?.user.id ?? null);
      setAuthEmail(data.session?.user.email ?? null);
      setBootstrapped(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setAuthUserId((prev) => (prev === (s?.user.id ?? null) ? prev : (s?.user.id ?? null)));
      setAuthEmail((prev) => (prev === (s?.user.email ?? null) ? prev : (s?.user.email ?? null)));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Resolve the public.users row when the auth user id changes (or a retry is
  // requested via resolveTick). A query ERROR (network drop, timeout, or a
  // Supabase 5xx/503 outage) is NOT the same as a genuine "no profile row":
  // maybeSingle() returns { data: null, error: null } for a real 0-row result,
  // so only an error-present case is transient. Transient failures go to the
  // 'unreachable' state and auto-retry with backoff; only a real missing row
  // (or bad role) is the true 'incomplete'. Conflating the two told every agent
  // to "contact your admin" during a backend outage (2026-06-19).
  useEffect(() => {
    if (!bootstrapped) return;

    if (!authUserId) {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryAttempt.current = 0;
      setAccount({ kind: 'signed_out' });
      return;
    }

    let cancelled = false;
    // Keep the unreachable screen up across background retries instead of
    // flickering back to a spinner on every attempt.
    setAccount((prev) => (prev.kind === 'unreachable' ? prev : { kind: 'loading' }));

    (async () => {
      const { data, error } = await supabase
        .from('users')
        // select('*') so warehouse_id comes back even before it lands in
        // database.gen.ts (after scripts/warehouse-staff.sql + gen:types);
        // it's read via a cast below until then.
        .select('*')
        .eq('id', authUserId)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        // Backend unreachable — retry with exponential backoff (1s → 30s cap).
        retryAttempt.current += 1;
        const delay = Math.min(1000 * 2 ** (retryAttempt.current - 1), 30000);
        setAccount({ kind: 'unreachable', userId: authUserId, email: authEmail });
        retryTimer.current = setTimeout(() => setResolveTick((t) => t + 1), delay);
        return;
      }

      retryAttempt.current = 0;

      if (!data) {
        setAccount({ kind: 'incomplete', userId: authUserId, email: authEmail });
        return;
      }

      if (!data.is_active) {
        setAccount({ kind: 'deactivated', userId: data.id, email: data.email });
        return;
      }

      if (!isRole(data.role)) {
        setAccount({ kind: 'incomplete', userId: data.id, email: data.email });
        return;
      }

      setAccount({
        kind: 'active',
        userId: data.id,
        email: data.email,
        role: data.role,
        displayName: data.display_name,
        warehouseId: (data as { warehouse_id?: string | null }).warehouse_id ?? null,
      });
    })();

    return () => {
      cancelled = true;
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [authUserId, authEmail, bootstrapped, resolveTick]);

  const retry = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retryAttempt.current = 0;
    setResolveTick((t) => t + 1);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      account,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error?.message ?? null };
      },
      async signOut() {
        // Best-effort: tell the server to drop this device's push token so
        // notifications don't keep arriving on a signed-out phone.
        try {
          const tok = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
          if (tok) {
            await supabase.rpc('release_my_expo_push_token', { p_token: tok });
            await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
          }
        } catch (e) {
          console.warn('release push token on sign-out failed', e);
        }
        await supabase.auth.signOut();
        // Wipe every cached query so the next account never sees this one's
        // deliveries/stock/reference data.
        queryClient.clear();
      },
      retry,
    }),
    [account, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience hook: throws if account is not active.
 * Use inside screens that are guarded by the (role)/ layout. */
export function useCurrentUser(): Extract<AccountState, { kind: 'active' }> {
  const { account } = useAuth();
  if (account.kind !== 'active') {
    throw new Error(`useCurrentUser called when account.kind = ${account.kind}`);
  }
  return account;
}
