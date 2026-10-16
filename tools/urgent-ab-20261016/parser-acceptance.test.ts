// Runs the REAL Edge handler and Supabase HTTP client. Only external services
// (catalog/database, address lookup and model response) are deterministic fakes.
// No production credentials, customer data or network calls are used.
import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

let handler: (req: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((fn: typeof handler) => { handler = fn; }) as typeof Deno.serve;
try {
  await import('../../supabase/functions/bot-parse-message/index.ts');
} finally {
  Deno.serve = serve;
}

const jq = '36396d8a-3042-45e0-994a-a68e85def8ce';
const dentora = 'bf10eeca-fa09-47db-9596-a78ffba455fb';
const capsule = '1420fd7e-3482-419c-952e-a381ae2ee796';
const spray = '20a8bcbb-5f3f-45d1-b73f-f50d29b9c4ce';
const oratox = '9245d648-6733-4e3f-9fe1-804f5d1d170b';
const candidate = (id: string, client_id: string, product_name: string, score: number) =>
  ({ id, client_id, client_name: client_id === jq ? 'JQ' : 'Dentora', product_name, score });

async function scenario(opts: { plural?: boolean; quantity?: number; hint?: string; mixed?: boolean; sharedName?: boolean; ambiguousSku?: boolean }) {
  const quantity = opts.quantity ?? 1;
  const total = quantity === 2 ? 42000 : 26000;
  const names = opts.mixed ? ['Oratox Capsule', 'Oralis Spray'] :
    opts.plural ? ['Oralis Capsules', 'Oralis Sprays'] : ['Oralis Capsule', 'Oralis Spray'];
  const products = names.map((product_name, i) => ({ product_name, quantity, customer_price: i ? null : total, free: false }));
  products.push({ product_name: 'eBook', quantity: 1, customer_price: 0, free: true });
  const row = {
    id: '11111111-1111-4111-8111-111111111111', status: 'queued',
    raw_text: `Name: Test Recipient\nPhone: 08000000001\nAddress: Test road, Yaba\n${quantity} ${names[0]} + ${quantity} ${names[1]} + FREE eBook\nTotal: ${total}`,
    raw_payload: { client_hint: opts.hint ?? 'Dentora', parsed: {
      customer_name: 'Test Recipient', customer_phone: '08000000001',
      raw_address: 'Test road, Yaba', product_name: names[0], quantity, customer_price: total,
    } },
  };
  const env = {
    SUPABASE_URL: 'http://127.0.0.1:55480', SUPABASE_SERVICE_ROLE_KEY: 'isolated-test-key',
    INTERNAL_FUNCTION_SECRET: 'isolated-test-secret', OPENROUTER_API_KEY: 'isolated-test-key',
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  let parse: Record<string, any> | undefined;
  const realFetch = globalThis.fetch;
  // Each real Supabase client starts an auth refresh timer. The Edge runtime
  // owns it in production; this harness owns and clears it after each request.
  const realSetInterval = globalThis.setInterval;
  const intervals: number[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = realSetInterval(...args);
    intervals.push(id);
    return id;
  }) as typeof setInterval;
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const body = req.method === 'GET' ? {} : await req.json();
    const name = url.pathname.split('/').at(-1)!;
    calls.push({ name, body });
    if (url.hostname === 'openrouter.ai' && name === 'completions') {
      return json({ choices: [{ message: { content: JSON.stringify({
        customer_name: 'Test Recipient', customer_phone: '08000000001', customer_phone_alt: null,
        raw_address: 'Test road, Yaba', instructions: null, client_rep: null, total_amount: total, products,
      }) } }] });
    }
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`);
    if (name === 'bot_inbound_messages') return json(row);
    if (name === 'get_flag') return json({ enabled: body.p_key === 'enable_bot_pipeline' });
    if (name === 'match_products_by_text') {
      if (body.p_text === 'Oratox Capsule') return json([candidate(oratox, dentora, 'Oratox Capsule', 1)]);
      if (/Oralis Capsules?/.test(body.p_text) && opts.ambiguousSku) return json([
        candidate(oratox, dentora, 'Shared Capsule', 1),
        candidate(capsule, jq, 'Shared Capsule', 1),
        candidate('44444444-4444-4444-8444-444444444444', jq, 'Shared Capsule variant', 0.98),
      ]);
      if (/Oralis Capsules?/.test(body.p_text)) return json([
        candidate(capsule, jq, 'Oralis Capsule', opts.plural ? 0.823529 : 1),
        candidate(oratox, dentora, 'Oratox Capsule', opts.sharedName ? 1 : opts.plural ? 0.47619 : 0.578947),
      ]);
      if (/Oralis Sprays?/.test(body.p_text)) return json([candidate(spray, jq, 'Oralis Spray', opts.plural ? 0.8 : 1)]);
      return json([]);
    }
    if (name === 'normalize-address') return json({ match_log_id: null, matched_location_id: '22222222-2222-4222-8222-222222222222', confidence: 'high' });
    if (name === 'customer_blacklist') return json(null);
    if (name === 'bot_create_delivery') return json('33333333-3333-4333-8333-333333333333');
    if (name === 'mark_inbound_processed') { row.status = body.p_status; parse = body.p_parse; return json(null); }
    throw new Error(`Unexpected request: ${name}`);
  };
  try {
    const request = () => new Request('http://127.0.0.1/parser', {
      method: 'POST', headers: { 'x-internal-secret': env.INTERNAL_FUNCTION_SECRET },
      body: JSON.stringify({ inbound_message_id: row.id }),
    });
    const response = await handler(request());
    assertEquals(response.status, 200);
    await response.text();
    assertEquals(row.status, opts.mixed || opts.ambiguousSku ? 'needs_review' : 'created_delivery');
    assertExists(parse);
    assertEquals(parse.client_id_conflict, !!opts.mixed);
    const creates = calls.filter(c => c.name === 'bot_create_delivery');
    if (opts.mixed || opts.ambiguousSku) {
      assertEquals(creates.length, 0);
    } else {
      assertEquals(creates.length, 1);
      assertEquals(creates[0].body.p_client_id, jq);
      assertEquals(creates[0].body.p_customer_price, total);
      assertEquals((creates[0].body.p_items as any[]).map(x => [x.product_catalog_id, x.quantity_ordered]), [[capsule, quantity], [spray, quantity]]);
      assertEquals(parse.unmatched_count, 0);
      assertEquals(parse.dropped_free_gifts.length, 1);
    }
    const repeated = await handler(request());
    assertEquals(await repeated.text(), `already processed: ${row.status}`);
    assertEquals(calls.filter(c => c.name === 'bot_create_delivery').length, creates.length);
    assertEquals(calls.filter(c => c.name === 'completions').length, 1, 'No extra model call for a clear match');
    return parse;
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    intervals.forEach(clearInterval);
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test('JQ acceptance: contradictory Dentora hint does not replace either SKU', async () => {
  const parse = await scenario({});
  assertEquals(parse.product_hint_decisions[0].outcome, 'ignored_clear_match');
  assertEquals(parse.product_matches[0].candidates.length, 2, 'Keep original evidence in the audit');
});
Deno.test('JQ acceptance: plural names, two units each, and total survive the wrong hint', () => scenario({ plural: true, quantity: 2 }).then(() => {}));
Deno.test('JQ acceptance: correct hint and repeated webhook remain compatible', () => scenario({ hint: 'JQ' }).then(() => {}));
Deno.test('JQ acceptance: unrelated hint does not prevent a clear match', () => scenario({ hint: 'Sonic Wellness' }).then(() => {}));
Deno.test('JQ acceptance: a genuinely mixed-vendor bundle still requires review', () => scenario({ mixed: true }).then(() => {}));
Deno.test('JQ acceptance: a missing hint uses clear catalog matches', () => scenario({ hint: '' }).then(() => {}));
Deno.test('JQ acceptance: a genuine vendor tie still honors the hint without another model call', async () => {
  const parse = await scenario({hint:'JQ',sharedName:true});
  assertEquals(parse.product_hint_decisions[0].outcome, 'resolved_vendor_tie');
});
Deno.test('JQ acceptance: a hinted vendor with ambiguous SKUs stays in review without classifier override', async () => {
  const parse = await scenario({hint:'JQ',ambiguousSku:true});
  assertEquals(parse.product_hint_decisions[0].outcome, 'ambiguous_hinted_products');
  assertEquals(parse.unmatched_count, 1);
});
