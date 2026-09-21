// Requires the isolated PostgREST fixture on localhost:55451 with the real
// check_payment_client_contract pre-request hook and active payment policy.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { createSystemClient } from '../supabase/functions/_shared/system-client.ts';
import { denyIfNotInternal } from '../supabase/functions/_shared/internal-auth.ts';

const secret = 'isolated-reda-eod-test-secret-at-least-32-characters';
const encode = (value: string) => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
async function token() {
  const prefix = `${encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${encode(JSON.stringify({
    role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300,
  }))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(prefix)));
  return `${prefix}.${encode(String.fromCharCode(...bytes))}`;
}

Deno.test('real scheduled client passes active payment gate; old client stays blocked', async () => {
  // Routing proxy only: authorization and compatibility run in real PostgREST
  // and PostgreSQL. No RPC result or payment guard is mocked.
  const proxy = Deno.serve({ hostname: '127.0.0.1', port: 55452, onListen() {} }, (req) => {
    const path = new URL(req.url).pathname.replace(/^\/rest\/v1/, '');
    return fetch(`http://127.0.0.1:55451${path}`, {
      method: req.method, headers: req.headers, body: req.body,
    });
  });
  try {
    const jwt = await token();
    const old = createClient('http://127.0.0.1:55452', jwt, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rejected = await old.rpc('check_payment_client_contract');
    if (rejected.status !== 426 || rejected.error?.code !== 'PT426') {
      throw new Error(`Old client should be blocked: ${JSON.stringify(rejected)}`);
    }
    const current = createSystemClient('http://127.0.0.1:55452', jwt);
    const accepted = await current.rpc('check_payment_client_contract');
    if (accepted.error) throw new Error(`Scheduled client failed: ${JSON.stringify(accepted)}`);
    let deniedHealth = await current.rpc('maintenance_health');
    // PostgREST reloads its schema asynchronously after the fixture migration.
    for (let attempt=0; deniedHealth.error?.code==='PGRST202' && attempt<20; attempt++) {
      await new Promise(resolve=>setTimeout(resolve,200));
      deniedHealth = await current.rpc('maintenance_health');
    }
    if (deniedHealth.error?.code !== '42501') throw new Error(`Expected permission denial from operations health: ${deniedHealth.error?.code}: ${deniedHealth.error?.message}`);
    const deniedWorker = await current.schema('reda_maintenance').rpc('work');
    if (!deniedWorker.error) throw new Error('Private worker exposed through app API');
  } finally {
    await proxy.shutdown();
  }
});

Deno.test('scheduler endpoint rejects ordinary requests before signing in', () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'isolated-secret');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'isolated-service-key');
  if (denyIfNotInternal(new Request('http://localhost'))?.status !== 401) {
    throw new Error('Missing internal authorization accepted');
  }
  if (denyIfNotInternal(new Request('http://localhost', {
    headers: { 'x-internal-secret': 'isolated-secret' },
  })) !== null) throw new Error('Trusted scheduler rejected');
});
