// Actual parser + Supabase HTTP client. Fake only external services; no network
// permission, production credentials or customer details. Catalog responses are
// based on the product-only incident trace; SQL tests verify real alias matching.
import { assert, assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
let handler: (req: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((fn: typeof handler) => { handler = fn; }) as typeof Deno.serve;
try { await import('../../supabase/functions/bot-parse-message/index.ts'); } finally { Deno.serve = serve; }
const vendor = '2740824b-4f65-4901-abd5-6635aec0f044';
const oud = '67f486ef-d7c5-4934-8f54-4916abda42df';
const pacific = 'd36c6537-3d12-40ac-b14d-aaf46c805932';
type Options = { full?: boolean; oldName?: boolean; pacific?: boolean; free?: boolean; paidOil?: boolean;
  wrongVariant?: boolean; invalidGiftQuantity?: boolean; foreign?: boolean; standalone?: boolean; duplicate?: boolean; contractorArray?: boolean };
async function scenario(opts: Options = {}) {
  const mainName = opts.pacific ? opts.oldName ? 'Pacific Blue Perfume' : 'Maison Alhambra Pacific Blue EDP'
    : opts.oldName ? 'Oud Al Layl Perfume' : opts.full ? 'Arabiyat Oud Al Layl EDP 100ml Perfume For Men and Women' : 'Arabiyat Oud Al Layl EDP Perfume';
  const oilName = opts.full ? 'Touch Concentrated Perfume Oil 5ml Alcohol Free' : 'Touch Concentrated Perfume Oil Alcohol Free';
  const products = [
    ...(!opts.standalone ? [{ product_name: mainName, quantity: 1, customer_price: null, free: false }] : []),
    { product_name: oilName, quantity: opts.invalidGiftQuantity ? null : 2, customer_price: opts.paidOil ? 1500 : null, free: opts.free ?? false },
  ];
  const row = {
    id: '11111111-1111-4111-8111-111111111111', status: 'queued',
    raw_text: `${opts.standalone ? 'OIL' : opts.pacific ? 'PACIFIC BLUE' : 'OUD AL LAYL'} — #411\nName: Test Recipient\nPhone: 08000000001\nWhatsApp: 08000000002\nAddress: Test road, Lagos\nMain offer\n${opts.standalone ? '' : `${mainName} × 1\n`}${oilName} × 2\nAmount: ₦32,500\nTotal: ₦32,500`,
    raw_payload: { client_hint: opts.foreign ? '' : 'Zael NG', parsed: {
      customer_name: 'Test Recipient', customer_phone: '08000000001', customer_phone_alt: '08000000002',
      raw_address: 'Test road, Lagos', customer_price: 32500, product_name: opts.standalone ? oilName : mainName, quantity: opts.standalone ? 2 : 1,
      ...(opts.contractorArray ? { products } : {}),
    } },
  };
  const env = { SUPABASE_URL: 'http://isolated.invalid', SUPABASE_SERVICE_ROLE_KEY: 'isolated-key',
    INTERNAL_FUNCTION_SECRET: 'isolated-secret', OPENROUTER_API_KEY: 'isolated-model-key' };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k,Deno.env.get(k)]));
  for (const [k,v] of Object.entries(env)) Deno.env.set(k,v);
  const realFetch = globalThis.fetch, realInterval = globalThis.setInterval;
  const intervals: number[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { const id=realInterval(...args);intervals.push(id);return id; }) as typeof setInterval;
  const calls: Array<{ name: string; body: any }> = [];
  let parse: any, persistedDelivery: any;
  const json = (v: unknown, status=200) => new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    const body = req.method === 'GET' ? {} : await req.json();
    const name = url.pathname.split('/').at(-1)!; calls.push({name,body});
    if (url.origin === 'https://openrouter.ai' && name === 'completions') {
      return json({ choices: [{ message: { content: JSON.stringify({ customer_name: 'Test Recipient',
        customer_phone: '08000000001',customer_phone_alt:'08000000002',raw_address:'Test road, Lagos',
        instructions:null,client_rep:'411',total_amount:32500,products }) } }] });
    }
    assertEquals(url.origin,env.SUPABASE_URL);
    if (name === 'bot_inbound_messages') return json(row);
    if (name === 'get_flag') return json({ enabled: body.p_key === 'enable_bot_pipeline' });
    if (name === 'match_products_by_text') return json(body.p_text === mainName && !opts.standalone ? [{
      id: opts.wrongVariant ? '5bd093a5-fbf8-4c8c-b6ac-7b5fff32fcb5' : opts.pacific ? pacific : oud,
      client_id: opts.foreign ? 'other-vendor' : vendor, client_name: opts.foreign ? 'Other vendor' : 'Zael NG',
      product_name: opts.wrongVariant ? 'Oud Al Layl Aswad' : opts.pacific ? 'Maison Alhambra Pacific Blue EDP' : 'Arabiyat Oud Al Layl EDP',
      score: opts.oldName || opts.pacific ? 1 : opts.full ? .45283 : .75,
    }] : []);
    if (name === 'normalize-address') return json({ match_log_id:null,matched_location_id:'22222222-2222-4222-8222-222222222222',confidence:'high' });
    if (name === 'customer_blacklist') return json(null);
    if (name === 'bot_create_delivery_with_gifts') {
      if (opts.duplicate) return json({code:'P0001',message:'Check the existing order',hint:JSON.stringify({kind:'gift_duplicate_review',existing_delivery_id:'33333333-3333-4333-8333-333333333333'})},400);
      persistedDelivery = body; return json('33333333-3333-4333-8333-333333333333');
    }
    if (name === 'mark_inbound_processed') { row.status=body.p_status;parse=body.p_parse;return json(null); }
    throw Error(`Unexpected service call: ${name}`);
  };
  try {
    const request = () => new Request('http://isolated.invalid/parser',{method:'POST',headers:{'x-internal-secret':env.INTERNAL_FUNCTION_SECRET},body:JSON.stringify({inbound_message_id:row.id})});
    const response = await handler(request()); assertEquals(response.status,200); await response.text();
    const review = !!(opts.paidOil || opts.wrongVariant || opts.invalidGiftQuantity || opts.foreign || opts.standalone || opts.duplicate);
    assertEquals(row.status,review ? 'needs_review' : 'created_delivery'); assertExists(parse);
    assertEquals(parse.extracted.total_amount,32500);
    if (!review) {
      assertExists(persistedDelivery);
      assertEquals(persistedDelivery.p_customer_price,32500);
      assertEquals(persistedDelivery.p_customer_phone,'08000000001'); assertEquals(persistedDelivery.p_customer_phone_alt,'08000000002');
      assertEquals(persistedDelivery.p_items.map((i: any)=>[i.product_catalog_id,i.quantity_ordered]),[[opts.pacific ? pacific : oud,1]]);
      assertEquals(persistedDelivery.p_delivery_instructions,'Included gifts: Perfume Oil ×2.');
      assertEquals(parse.gift_policy.ignored,[{product_name:'Perfume Oil',quantity:2}]);
      assertEquals(parse.unmatched_count,0); assertEquals(parse.product_matches_before_gift_policy.length,2);
    } else {
      assertEquals(persistedDelivery,undefined);
      if(opts.duplicate)assertExists(parse.duplicate_review?.existing_delivery_id);
    }
    const creates=calls.filter(c=>c.name==='bot_create_delivery_with_gifts').length;
    assertEquals(creates,!review || opts.duplicate ? 1 : 0);
    const repeated = await handler(request()); assertEquals(repeated.status,200); await repeated.text();
    assertEquals(calls.filter(c=>c.name==='bot_create_delivery_with_gifts').length,creates);
    assertEquals(calls.filter(c=>c.name==='completions').length,opts.contractorArray ? 0 : 1);
    assert(!calls.some(c=>c.name==='bot_create_delivery'),'Gift bundles must retain the duplicate-aware creation path');
  } finally {
    globalThis.fetch=realFetch;globalThis.setInterval=realInterval;intervals.forEach(clearInterval);
    for(const [k,v] of Object.entries(saved))v===undefined ? Deno.env.delete(k) : Deno.env.set(k,v);
  }
}
const cases: Array<[string,Options]> = [
  ['stored October 17 extraction, implicit gift',{}],
  ['full #411 product wording',{full:true}],
  ['explicit free gift',{free:true}],
  ['contractor products array',{full:true,contractorArray:true}],
  ['legacy Oud name after rename',{oldName:true}],
  ['renamed Pacific Blue',{pacific:true}],
  ['legacy Pacific Blue name',{pacific:true,oldName:true}],
  ['separately priced oil requires review',{paidOil:true}],
  ['positive price overrides contradictory free flag',{paidOil:true,free:true}],
  ['wrong perfume variant requires review',{wrongVariant:true}],
  ['missing gift quantity requires review',{invalidGiftQuantity:true}],
  ['unrelated vendor retains review',{foreign:true}],
  ['standalone oil remains reviewable',{standalone:true}],
  ['existing order is sent to review without another delivery',{duplicate:true}],
];
for(const [name,opts] of cases)Deno.test(`Perfume acceptance: ${name}`,()=>scenario(opts));
