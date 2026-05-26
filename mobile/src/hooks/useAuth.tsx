import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { PUSH_TOKEN_STORAGE_KEY } from '@/hooks/usePushTokenRegistration';
import { isRole, type Role } from '@/lib/permissions';

export type AccountState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'incomplete'; userId: string; email: string | null } // auth user exists but no public.users row
  | { kind: 'deactivated'; userId: string; email: string }
  | { kind: 'active'; userId: string; email: string; role: Role; displayName: string };

type AuthContextValue = {
  account: AccountState;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [account, setAccount] = useState<AccountState>({ kind: 'loading' });

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
      setAuthUserId((prev) => (prev === (s?.user.id ?? null) ? prev : s?.user.id ?? null));
      setAuthEmail((prev) => (prev === (s?.user.email ?? null) ? prev : s?.user.email ?? null));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Resolve the public.users row when the auth user id changes.
  useEffect(() => {
    if (!bootstrapped) return;

    if (!authUserId) {
      setAccount({ kind: 'signed_out' });
      return;
    }

    let cancelled = false;
    setAccount({ kind: 'loading' });

    (async () => {
      const { data, error } = await supabase
        .from('users')
        .select('id, email, display_name, role, is_active')
        .eq('id', authUserId)
        .maybeSingle();

      if (cancelled) return;

      if (error || !data) {
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
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [authUserId, authEmail, bootstrapped]);

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
      },
    }),
    [account],
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
