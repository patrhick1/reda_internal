// Actual exported Expo UI + real query cache/navigation, synthetic HTTP only.
// STOCK_UI_DIST selects the baseline or fixed export. No production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, 'index.mjs')).href : 'playwright');
const dist = path.resolve(process.env.STOCK_UI_DIST || 'mobile/dist/urgent-ab-after');
const server = createServer((req, res) => {
  const requested = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!requested.startsWith(dist + path.sep) && requested !== dist) { res.writeHead(403).end(); return; }
  const file = existsSync(requested) && path.extname(requested) ? requested : path.join(dist, 'index.html');
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.STOCK_UI_BROWSER ? {executablePath:process.env.STOCK_UI_BROWSER} : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
const agent = { id: '33333333-3333-4333-8333-333333333333', email: 'agent@example.invalid', display_name: 'TEST Agent', role: 'agent', is_active: true, parent_agent_id: null };
const session = { access_token: 'isolated-ui-test', refresh_token: 'isolated-ui-test', expires_at: Math.floor(Date.now()/1000)+86400, user: agent };
await page.addInitScript(session => localStorage.setItem('sb-api-auth-token', JSON.stringify(session)), session);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const pid = '44444444-4444-4444-8444-444444444444';
const delivery = { id: '55555555-5555-4555-8555-555555555555', customer_name: 'TEST stock recipient', customer_phone: '08000000000', raw_address: 'TEST address', current_status: 'pending', scheduled_date: today, created_date: today, created_at: `${today}T08:00:00Z`, updated_at: `${today}T08:00:00Z`, assigned_agent_id: agent.id, order_type: 'delivery', product_catalog_id: pid, product_label: 'TEST product ×3', product_name: 'TEST product', quantity_ordered: 3, customer_price: 10000, agent_payment_snapshot: 1000, rollover_count: 0, location: {name: 'TEST zone'} };
let coverage = { product_catalog_id: pid, product_name: 'TEST product', orders_open: 3, qty_open: 9, qty_committed: 0, on_hand_total: 7, on_hand_warehouse: 7, my_on_hand: 0 };
let coverageCalls = 0, failCoverage = false;
const errors = [], writes = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin === origin) return route.continue();
  if (url.hostname !== 'api.redalogisticss.com') return route.abort();
  const rpc = url.pathname.split('/').at(-1);
  if (req.method() !== 'GET' && !url.pathname.includes('/rpc/')) writes.push(rpc);
  let data = [];
  if (rpc === 'users') data = url.searchParams.has('id') ? agent : [agent];
  if (rpc === 'user') data = agent;
  if (rpc === 'stock_coverage_today') {
    coverageCalls++;
    if (failCoverage) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic outage'})});
    data = [coverage];
  }
  if (rpc === 'deliveries_safe' || rpc === 'deliveries_admin') data = url.searchParams.get('current_status')?.includes('postponed') ? [] : [delivery];
  if (rpc === 'get_same_customer_config') data = {discovery_enabled:false};
  if (rpc === 'delivery_statuses') data = [{code:'pending',label:'Pending',is_terminal:false,sort_order:1}];
  if (/^count_/.test(rpc)) data = 0;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
const warning = page.getByText('Out of stock — check before calling', {exact:true});
const out = page.getByText('Out of stock — hold off calling', {exact:true});
const settle = () => new Promise(resolve => setTimeout(resolve, 200));
const tick = async ms => { await page.clock.fastForward(ms); await settle(); };
const visibility = async state => {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', {configurable:true,get:()=>state});
    window.dispatchEvent(new Event('visibilitychange'));
  }, state);
  await settle();
};
try {
  await page.clock.install();
  await page.goto(`${origin}/(agent)/today`);
  await page.getByText(delivery.customer_name, {exact:true}).waitFor();
  await settle();
  assert.equal(coverageCalls,1,'Initial coverage fetch is shared');
  assert.equal(await warning.count(),0);
  // Another user's confirmation changes only the server; no local invalidation.
  coverage = {...coverage,qty_committed:5};
  await tick(20_100);
  assert.equal(coverageCalls,2,'Focused screen refreshes coverage after 20 seconds');
  assert.equal(await warning.count(),1,'Remote confirmation updates the visible badge');
  console.log('PASS remote commitment appears within the 20-second refresh');

  coverage = {...coverage,on_hand_total:0};
  await tick(20_100);
  assert.equal(await out.count(),1,'Fleet exhaustion updates the badge');
  coverage = {...coverage,on_hand_total:7,my_on_hand:3,qty_committed:8};
  await tick(20_100);
  assert.equal(await warning.count(),0,'Personal stock still overrides fleet commitments');
  assert.equal(await out.count(),0);
  console.log('PASS fleet exhaustion and unchanged personal-stock override');

  await visibility('hidden');
  const beforeHidden = coverageCalls;
  coverage = {...coverage,my_on_hand:0,qty_committed:5};
  await tick(40_100);
  assert.equal(coverageCalls,beforeHidden,'No background polling');
  await visibility('visible');
  assert.equal(coverageCalls,beforeHidden+1,'Resume revalidates stale coverage');
  assert.equal(await warning.count(),1);
  console.log('PASS background pause and foreground recovery');

  await page.getByText('Profile',{exact:true}).click();
  await settle();
  const beforeBlur = coverageCalls;
  await tick(40_100);
  assert.equal(coverageCalls,beforeBlur,'Mounted but blurred Today does not poll');
  coverage = {...coverage,qty_committed:0};
  await page.getByText('Today',{exact:true}).click();
  await settle();
  assert.equal(coverageCalls,beforeBlur+1,'Return to Today refreshes stale coverage once');
  assert.equal(await warning.count(),0);
  console.log('PASS screen blur stops polling and return refreshes once');

  await context.setOffline(true);
  // NetInfo subscribes to NetworkInformation.change when Chromium exposes it.
  // Playwright's emulation toggles navigator.onLine but does not emit that event.
  await page.evaluate(() => navigator.connection?.dispatchEvent(new Event('change')));
  await settle();
  const beforeOffline = coverageCalls;
  coverage = {...coverage,qty_committed:5};
  await tick(40_100);
  assert.equal(coverageCalls,beforeOffline,'Offline polling pauses');
  await context.setOffline(false);
  await page.evaluate(() => navigator.connection?.dispatchEvent(new Event('change')));
  await settle();
  assert.equal(coverageCalls,beforeOffline+1,'Reconnect refreshes once');
  assert.equal(await warning.count(),1);
  console.log('PASS offline pause and reconnect recovery');

  failCoverage = true;
  await tick(20_100);
  assert.equal(await warning.count(),1,'Failed refresh retains last good data');
  failCoverage = false;
  coverage = {...coverage,qty_committed:0};
  await tick(20_100);
  assert.equal(await warning.count(),0,'A subsequent refresh recovers');
  assert.deepEqual(errors,[],'No UI runtime errors');
  assert.deepEqual(writes,[],'No data mutations');
  console.log('PASS failed refresh retains data and recovers');
} catch (error) {
  console.error({coverageCalls,errors,body:await page.locator('body').innerText()});
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
