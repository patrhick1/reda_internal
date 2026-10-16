// Execute the actual Edge handler and HTTP client. All I/O is synthetic;
// this verifies creation payloads/review outcomes, not production persistence.
import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

let handler: (req: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((fn: typeof handler) => {
  handler = fn;
}) as typeof Deno.serve;
try {
  await import('../../supabase/functions/bot-parse-message/index.ts');
} finally {
  Deno.serve = serve;
}

const client = '11111111-1111-4111-8111-111111111111';
const situp = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
type Options = { quantity?: number; old?: boolean; multi?: boolean; otherTemplate?: boolean };

async function scenario(
  { quantity = 1, old = false, multi = false, otherTemplate = false }: Options = {},
) {
  const total = quantity * 39500 + (multi ? 12000 : 0);
  const rawProduct = old
    ? `3 - SUCTION SITUP-BAR + FREE SKIPPING ROPE | ${quantity} | 39500 | ${quantity * 39500}`
    : `- 3 - SUCTION SITUP-BAR + FREE SKIPPING ROPE x${quantity} · NGN${
      (quantity * 39500).toLocaleString('en-US')
    }`;
  const products = [
    {
      product_name: 'Suction Situp Bar',
      quantity: 3,
      customer_price: quantity * 39500,
      free: false,
    },
    ...(multi
      ? [{ product_name: 'Water Filter', quantity: 9, customer_price: 12000, free: false }]
      : []),
    { product_name: 'Skipping Rope', quantity: 1, customer_price: 0, free: true },
  ];
  const row = {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'queued',
    raw_text: `${
      otherTemplate ? 'Reference:' : 'Order number:'
    } Bowan Stores Ltd-CRM-test\nName: Test Recipient\nPhone: 08000000001\nAddress: Test road, Yaba\nDetails of products:\n${rawProduct}${
      multi ? '\n- Water Filter x2 · NGN12,000' : ''
    }\nTotal: NGN${total}\n${old ? 'Closer:' : 'Closer name:'} TEST`,
    raw_payload: {
      parsed: {
        customer_name: 'Test Recipient',
        customer_phone: '08000000001',
        raw_address: 'Test road, Yaba',
        product_name: 'Suction Situp Bar',
        quantity: 3,
        customer_price: total,
      },
    },
  };
  const env = {
    SUPABASE_URL: 'http://127.0.0.1:55480',
    SUPABASE_SERVICE_ROLE_KEY: 'isolated-test-key',
    INTERNAL_FUNCTION_SECRET: 'isolated-test-secret',
    OPENROUTER_API_KEY: 'isolated-test-key',
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  Object.entries(env).forEach(([k, v]) => Deno.env.set(k, v));
  const calls: Array<{ name: string; body: Record<string, any> }> = [];
  const realFetch = globalThis.fetch, realSetInterval = globalThis.setInterval;
  const intervals: number[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = realSetInterval(...args);
    intervals.push(id);
    return id;
  }) as typeof setInterval;
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    const body = req.method === 'GET' ? {} : await req.json();
    const name = url.pathname.split('/').at(-1)!;
    calls.push({ name, body });
    if (url.hostname === 'openrouter.ai' && name === 'completions') {
      return json({
        choices: [{
          message: {
            content: JSON.stringify({
              customer_name: 'Test Recipient',
              customer_phone: '08000000001',
              customer_phone_alt: null,
              raw_address: 'Test road, Yaba',
              instructions: null,
              client_rep: null,
              total_amount: total,
              products,
            }),
          },
        }],
      });
    }
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected external request: ${url.origin}`);
    if (name === 'bot_inbound_messages') return json(row);
    if (name === 'get_flag') return json({ enabled: body.p_key === 'enable_bot_pipeline' });
    if (name === 'match_products_by_text') {
      const id = /situp/i.test(body.p_text)
        ? situp
        : /water filter/i.test(body.p_text)
        ? second
        : null;
      return json(
        id
          ? [{
            id,
            client_id: client,
            client_name: 'Bowan Stores Ltd',
            product_name: body.p_text,
            score: 1,
          }]
          : [],
      );
    }
    if (name === 'normalize-address') {
      return json({
        matched_location_id: '55555555-5555-4555-8555-555555555555',
        confidence: 'high',
        match_log_id: null,
      });
    }
    if (name === 'customer_blacklist') return json(null);
    if (name === 'bot_create_delivery') return json('66666666-6666-4666-8666-666666666666');
    if (name === 'mark_inbound_processed') {
      row.status = body.p_status;
      return json(null);
    }
    throw new Error(`Unexpected request: ${name}`);
  };
  try {
    const request = () =>
      new Request('http://127.0.0.1/parser', {
        method: 'POST',
        headers: { 'x-internal-secret': env.INTERNAL_FUNCTION_SECRET },
        body: JSON.stringify({ inbound_message_id: row.id }),
      });
    const response = await handler(request());
    assertEquals(response.status, 200);
    await response.text();
    assertEquals(row.status, 'created_delivery');
    const create = calls.find((c) => c.name === 'bot_create_delivery');
    assertExists(create);
    assertEquals(create.body.p_client_id, client);
    assertEquals(create.body.p_customer_price, total);
    assertEquals(create.body.p_items.map((x: any) => [x.product_catalog_id, x.quantity_ordered]), [[
      situp,
      otherTemplate ? 3 : quantity,
    ], ...(multi ? [[second, 2]] : [])]);
    const processed = calls.find((c) => c.name === 'mark_inbound_processed');
    assertEquals(processed?.body.p_parse.dropped_free_gifts.length, 1);
    const repeated = await handler(request());
    assertEquals(await repeated.text(), 'already processed: created_delivery');
    assertEquals(calls.filter((c) => c.name === 'bot_create_delivery').length, 1);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    intervals.forEach(clearInterval);
    for (const [k, v] of Object.entries(saved)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
}

for (const quantity of [1, 2, 3]) {
  Deno.test(`#256 current Bowan x${quantity}: correct items, price, gifts and retry`, () =>
    scenario({ quantity }));
}
Deno.test('#256 older pipe template remains compatible', () => scenario({ old: true }));
Deno.test('#256 multiple paid lines receive their own quantities', () => scenario({ multi: true }));
Deno.test('#256 unrelated template is not overridden', () => scenario({ otherTemplate: true }));
