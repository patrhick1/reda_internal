// Exercise the real Expo screens. Every API response is synthetic and all
// other external traffic is blocked; these checks never write production data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, 'index.mjs')).href : 'playwright');
const dist = path.resolve(process.env.REQUEST_UI_DIST || 'mobile/dist/dispatcher-menu');
const output = path.resolve('.codex-to-work-on', path.basename(dist) + '-dispatcher-menu');
mkdirSync(output, { recursive: true });
const server = createServer((req, res) => {
  const requested = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!requested.startsWith(dist + path.sep) && requested !== dist) return res.writeHead(403).end();
  const file = existsSync(requested) && path.extname(requested) ? requested : path.join(dist, 'index.html');
  res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.REQUEST_UI_BROWSER ? { executablePath: process.env.REQUEST_UI_BROWSER } : {}) });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const uid = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const agent = (n, name, active = true) => ({ id: uid(n), email: `rider${n}@example.invalid`, display_name: name, role: 'agent', is_active: active });
const busy = agent(2, 'TEST Busy Rider'), idle = agent(3, 'TEST Idle Rider');
const inactive = agent(4, 'TEST Inactive Rider', false), other = agent(5, 'TEST Other Rider');
const delivery = (n, rider, status) => ({
  id: uid(100 + n), client_id: uid(10), customer_name: `TEST Customer ${n}`, customer_phone: `0800000000${n}`,
  raw_address: `TEST Address ${n}`, assigned_agent_id: rider.id, current_status: status,
  order_type: 'delivery', scheduled_date: today, created_date: today, created_at: `${today}T08:00:00Z`,
  updated_at: `${today}T09:00:00Z`, activity_at: `${today}T09:00:00Z`, latest_changed_at: `${today}T09:00:00Z`,
  sibling_group_key: uid(100 + n), product_catalog_id: uid(11), product_label: 'TEST Product ×1',
  quantity_ordered: 1, customer_price: 10000, agent_payment_snapshot: 1000, rollover_count: 0,
  client: { name: 'TEST Client', auto_cancel_soft_fails: false }, assigned_agent: { display_name: rider.display_name },
});
const rows = [delivery(1, busy, 'pending'), delivery(2, busy, 'available'), delivery(3, busy, 'delivered'), delivery(4, other, 'pending')];
const results = [];
async function fixture(role, width, empty = false) {
  const user = { id: uid(1), email: 'ops@example.invalid', display_name: 'TEST Operations', role, is_active: true };
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(s => localStorage.setItem('sb-api-auth-token', JSON.stringify(s)), {
    access_token: 'isolated-ui-test', refresh_token: 'isolated-ui-test', expires_at: Math.floor(Date.now() / 1000) + 86400, user,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [], writes = [], reads = { users: 0, deliveries: 0 };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'api.redalogisticss.com') return route.abort();
    const name = url.pathname.split('/').at(-1);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !url.pathname.includes('/rpc/')) writes.push(name);
    let data = [];
    if (name === 'users') {
      if (url.searchParams.has('id')) data = user;
      else {
        reads.users++;
        data = [user, ...(empty ? [] : [busy, idle, inactive, other])].filter(u => u.is_active);
      }
    }
    if (name === 'user') data = user;
    if (name === 'get_same_customer_config') data = { discovery_enabled: false };
    if (/^count_/.test(name)) data = 0;
    if (name === 'clients') data = [{ id: uid(10), name: 'TEST Client', is_active: true }];
    if (name === 'deliveries_admin' || name === 'deliveries_safe') {
      if (url.searchParams.get('scheduled_date') === `eq.${today}`) reads.deliveries++;
      data = empty ? [] : rows;
      if (url.searchParams.get('assigned_agent_id') === 'is.null' || url.searchParams.get('current_status') === 'eq.postponed') data = [];
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  const visible = text => page.getByText(text, { exact: true }).and(page.locator(':not([aria-hidden="true"] *)'));
  return { context, page, visible, errors, writes, reads };
}
async function check(name, role, width, run, empty = false) {
  const f = await fixture(role, width, empty);
  try {
    await run(f);
    assert.deepEqual(f.errors, [], 'No browser runtime errors');
    assert.deepEqual(f.writes, [], 'No application-record writes');
    results.push({ name, width, passed: true });
    console.log(`PASS ${width}px ${name}`);
  } catch (e) {
    results.push({ name, width, passed: false, error: String(e) });
    console.error(`FAIL ${width}px ${name}: ${e}`);
    writeFileSync(path.join(output, `${results.length}-failure.txt`), `${e}\n${await f.page.locator('body').innerText()}`);
    await f.page.screenshot({ path: path.join(output, `${results.length}-failure.png`), fullPage: true });
  } finally { await f.context.close(); }
}
try {
  for (const width of [390, 1280]) {
    await check('#297 dispatcher workload, counts and rider-filter navigation', 'dispatcher', width, async ({ page, visible, reads }) => {
      await page.goto(`${origin}/(dispatcher)`);
      await visible('Agent workload').waitFor();
      await visible(busy.display_name).waitFor();
      assert.equal(await visible('1/3 delivered · 1 available · 1 pending').count(), 1);
      assert.equal(await visible('0/0 delivered').count(), 1);
      assert.equal(await visible(inactive.display_name).count(), 0);
      assert.equal(await visible('TEST Operations').count(), 0, 'Dispatchers are not riders');
      assert.equal(reads.users, 1, 'Reuses the existing directory query');
      assert.equal(reads.deliveries, 1, 'Reuses the existing query scoped to today’s deliveries');
      assert((await visible(busy.display_name).boundingBox()).y < (await visible(idle.display_name).boundingBox()).y);
      await visible('Agent workload').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `workload-${width}.png`), fullPage: true });
      await visible(busy.display_name).click();
      await visible(`Agent: ${busy.display_name}`).waitFor();
      await visible('TEST Customer 1').waitFor();
      assert.equal(await visible('TEST Customer 4').count(), 0);
      assert.equal(new URL(page.url()).searchParams.get('agent'), busy.id);
      assert.equal(await page.getByRole('tab', { name: 'Dashboard', exact: true }).count(), 1, 'Remains in dispatcher navigation');
    });
    await check('#297 empty dispatcher workload preserves existing home actions', 'dispatcher', width, async ({ page, visible }) => {
      await page.goto(`${origin}/(dispatcher)`);
      await visible('No active agents yet.').waitFor();
      assert.equal(await visible('Available orders').count(), 1);
      await visible('New replacement').click();
      await page.waitForURL(/replacement-new/);
    }, true);
    await check('#293 pickup menu retains exactly its three relevant choices', 'admin', width, async ({ page, visible }) => {
      await page.goto(`${origin}/(admin)/waybill-new`);
      await visible('New pickup / waybill').waitFor();
      for (const [current, next] of [['Pickup', 'Waybill'], ['Waybill', 'Failed delivery'], ['Failed delivery', 'Pickup']]) {
        await page.getByRole('button', { name: current, exact: true }).click();
        await visible('Failed delivery').last().waitFor();
        assert.equal(await visible('Replacement').count(), 0, 'Replacement is absent from this menu');
        await visible(next).click();
        await page.getByRole('button', { name: next, exact: true }).waitFor();
        assert.match(page.url(), /waybill-new/);
      }
      await page.screenshot({ path: path.join(output, `pickup-menu-${width}.png`), fullPage: true });
    });
    await check('#293 admin homepage replacement still opens its existing form', 'admin', width, async ({ page, visible }) => {
      await page.goto(`${origin}/(admin)`);
      await visible('Replacement').click();
      await page.waitForURL(/replacement-new/);
    });
  }
} finally {
  writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
if (results.some(r => !r.passed)) process.exitCode = 1;
