import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/** Server jobs that sign in as a real user still pass the app compatibility
 * gate. This declaration does not change their role or bypass financial guards. */
export function createSystemClient(url: string, anonKey: string) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-reda-payment-contract': '1' } },
  });
}
