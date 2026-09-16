import assert from 'node:assert/strict';

const origin = 'https://app.redalogisticss.com';
const page = await fetch(origin, { cache: 'no-store' });
assert.equal(page.status, 200);
const html = await page.text();
const script = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)]
  .map((match) => match[1])
  .find((src) => src.includes('/_expo/static/js/web/entry-'));
assert(script, 'Expo application bundle missing');
const response = await fetch(new URL(script, origin), { cache: 'no-store' });
assert.equal(response.status, 200);
const bundle = await response.text();
const discovery = ['list_same_customer_orders', 'assign_same_customer_orders',
  'correct_delivery_customer_match'].every((value) => bundle.includes(value));
const financialEngine = ['correct_same_customer_normal_fee', 'get_same_customer_shadow_pay',
  'agent_earnings_summary_v2'].some((value) => bundle.includes(value));
assert(discovery, 'Discovery trial bundle not yet served');
assert(bundle.includes('Confirm customer match'), 'Updated match action missing');
assert(bundle.includes('assignment review'), 'Assignment attention UI missing');
assert(bundle.includes('id,current_status,assigned_agent_id'), 'Web-only assignment summary missing');
assert(financialEngine, 'Payment-compatible readers missing');
assert(bundle.includes('x-reda-payment-contract'), 'Payment client contract header missing');
assert(bundle.includes('get_delivery_pay_state'), 'Canonical delivery payment metadata missing');
assert(bundle.includes('https://api.redalogisticss.com'), 'Live API URL missing');
console.log(JSON.stringify({ origin, pageStatus: page.status, bundleStatus: response.status,
  script, discoveryTrial: discovery, financialEngineIncluded: financialEngine }));
