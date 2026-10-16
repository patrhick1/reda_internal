// Exercise the actual handler and Supabase client; only external HTTP is faked.
// No production data, credentials, network permission or Expo requests are used.
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
let handler: (req: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((fn: typeof handler) => { handler = fn; }) as typeof Deno.serve;
try { await import('../../supabase/functions/send-notification/index.ts'); }
finally { Deno.serve = serve; }

const delivery = {
  id: 'test-delivery', customer_name: 'Test Customer', quantity_ordered: 2,
  quantity_delivered: 2, paid: 20000, product_catalog_id: 'product',
  assigned_agent_id: 'agent', location: { name: 'Test zone' },
  product: { product_name: 'Test product' }, agent: { display_name: 'Test Agent' },
  client: { name: 'Test vendor' }, items: [],
};
const users = [
  { id: 'admin-one', role: 'admin', is_active: true },
  { id: 'admin-two', role: 'admin', is_active: true },
  { id: 'inactive-admin', role: 'admin', is_active: false },
  ...['agent','dispatcher','rep','warehouse'].map(role => ({ id: role, role, is_active: true })),
];
const tokens = users.flatMap(u => [1,2].map(n => ({ user_id: u.id, token: `test-${u.id}-${n}` })));
type Message = { to: string; title: string; body: string; data: Record<string, unknown>; sound: string | null; priority: string; channelId: string };
async function scenario(body: Record<string, unknown>, options: { auth?: string; method?: string; repeat?: number; noConfig?: boolean } = {}) {
  const env = { SUPABASE_URL: 'http://isolated.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', INTERNAL_FUNCTION_SECRET: 'test-internal-secret' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, Deno.env.get(k)]));
  for (const [k,v] of Object.entries(env)) Deno.env.set(k,v);
  if (options.noConfig) Deno.env.delete('SUPABASE_URL');
  const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
  const intervals: number[] = [], requests: URL[] = [], messages: Message[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = originalInterval(...args); intervals.push(id); return id;
  }) as typeof setInterval;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    requests.push(url);
    if (url.href === 'https://exp.host/--/api/v2/push/send') {
      const batch = await req.json(); messages.push(...batch);
      return json({ data: batch.map(() => ({ status: 'ok', id: 'test-ticket' })) });
    }
    assertEquals(url.origin, env.SUPABASE_URL);
    assertEquals(req.method, 'GET');
    const table = url.pathname.split('/').at(-1);
    if (table === 'deliveries') return json(delivery);
    if (table === 'users') {
      assertEquals(url.searchParams.get('is_active'), 'eq.true');
      const role = url.searchParams.get('role')!;
      const roles = role.startsWith('eq.') ? [role.slice(3)] : role.slice(4,-1).split(',');
      return json(users.filter(u => u.is_active && roles.includes(u.role)));
    }
    if (table === 'push_tokens') {
      const ids = url.searchParams.get('user_id')!.slice(4,-1).split(',');
      return json(tokens.filter(t => ids.includes(t.user_id)));
    }
    if (table === 'current_stock') return json([]);
    if (table === 'calls') return json({ id: 'test-call', callee_id: 'admin-one', callee_audience: 'ops_team', agora_channel: 'test-channel', caller: { display_name: 'Test Caller' } });
    throw Error(`Unexpected HTTP request: ${url.pathname}`);
  };
  try {
    const responses = [];
    for (let i = 0; i < (options.repeat ?? 1); i++) {
      const method = options.method ?? 'POST';
      const response = await handler(new Request('http://isolated.invalid/send-notification', {
        method, headers: options.auth === 'bearer' ? { authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } : { 'x-internal-secret': options.auth === 'none' ? '' : env.INTERNAL_FUNCTION_SECRET },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }));
      responses.push({ status: response.status, body: await response.text() });
    }
    return { responses, requests, messages };
  } finally {
    globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval;
    for (const id of intervals) clearInterval(id);
    for (const [k,v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k,v);
  }
}

const status = (new_status: string) => ({ audience: 'status_change', delivery_id: delivery.id, new_status });
for (const auth of ['secret','bearer']) Deno.test(`Delivered: original and retried events produce no lookups or pushes (${auth})`, async () => {
  const r = await scenario(status('delivered'), { auth, repeat: 3 });
  assertEquals(r.responses.map(r => r.status), [200,200,200]);
  assertEquals(r.requests.length, 0); assertEquals(r.messages, []);
});
Deno.test('Delivered does not need delivery records or database configuration', async () => {
  const r = await scenario(status('delivered'), { noConfig: true });
  assertEquals(r.responses[0].status, 200); assertEquals(r.requests.length, 0);
});
for (const [state, title] of Object.entries({ failed_delivery: 'Failed delivery', cancelled: 'Delivery cancelled', unserious: 'Customer not serious', no_product: 'Out of stock' })) {
  Deno.test(`${state}: every active admin device still gets the audible alert`, async () => {
    const r = await scenario(status(state));
    assertEquals(r.responses[0].status, 200);
    assertEquals(r.messages.map(m => m.to), ['test-admin-one-1','test-admin-one-2','test-admin-two-1','test-admin-two-2']);
    for (const m of r.messages) {
      assertEquals(m.title,title); assertEquals(m.data,{ delivery_id: delivery.id });
      assertEquals([m.sound,m.priority,m.channelId], ['default','high','default']);
      assert(m.body.includes('Test Customer'));
    }
  });
}
for (const audience of ['user','admins','admins+dispatchers','reps','managers','assignment','warehouse_pickup','call_invite']) {
  Deno.test(`${audience}: other notification workflows remain audible`, async () => {
    const r = await scenario({ audience, user_id: 'admin-one', delivery_id: delivery.id, call_id: 'test-call', title: 'Delivered', body: 'Unrelated business alert' });
    assertEquals(r.responses[0].status,200); assert(r.messages.length > 0);
    for (const m of r.messages) assertEquals([m.sound,m.priority,m.channelId], ['default','high','default']);
  });
}
Deno.test('Blocked-order notifications retain their existing silent channel', async () => {
  const r = await scenario({ audience: 'admins', title: 'Blocked order', body: 'Test blocked order', data: { kind: 'blacklist_blocked' } });
  assertEquals(r.messages.length,4);
  for (const m of r.messages) assertEquals([m.sound,m.priority,m.channelId], [null,'normal','blocked-orders']);
});
Deno.test('Suppression preserves the internal authentication, method and payload checks', async () => {
  for (const [body,opts,code] of [
    [status('delivered'),{ auth: 'none' },401],
    [status('delivered'),{ method: 'GET' },405],
    [{ audience: 'status_change', new_status: 'delivered' },{},400],
  ] as const) {
    const r = await scenario(body,opts); assertEquals(r.responses[0].status,code); assertEquals(r.requests.length,0);
  }
});
