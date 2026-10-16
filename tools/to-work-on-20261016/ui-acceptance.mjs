// Actual Expo web export, navigation and React Query. Synthetic HTTP responses
// only; all other external traffic is blocked. No production credentials/data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, 'index.mjs')).href : 'playwright');
const dist = path.resolve(process.env.REQUEST_UI_DIST || 'mobile/dist/to-work-on-after');
const output = path.resolve('.codex-to-work-on', path.basename(dist));
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
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(6000);
const admin = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid', display_name: 'TEST Admin', role: 'admin', is_active: true };
const rider = { ...admin, id: '22222222-2222-4222-8222-222222222222', email: 'rider@example.invalid', display_name: 'TEST Rider One', role: 'agent' };
const other = { ...rider, id: '33333333-3333-4333-8333-333333333333', display_name: 'TEST Rider Two' };
const session = { access_token: 'isolated-ui-test', refresh_token: 'isolated-ui-test', expires_at: Math.floor(Date.now() / 1000) + 86400, user: admin };
await page.addInitScript(s => localStorage.setItem('sb-api-auth-token', JSON.stringify(s)), session);
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const offsetDay = n => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const row = (n, name, hour, status = 'pending', day = today, agent = rider) => ({
  id: `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`, client_id: '55555555-5555-4555-8555-555555555555',
  customer_name: name, customer_phone: `0800000000${n}`, raw_address: `TEST address ${n}`, current_status: status,
  scheduled_date: day, created_date: today, created_at: `${today}T07:00:00Z`, updated_at: `${today}T${hour}:00:00Z`,
  activity_at: `${today}T${hour}:00:00Z`, latest_changed_at: `${today}T${hour}:00:00Z`, assigned_agent_id: agent.id,
  order_type: 'delivery', product_catalog_id: '66666666-6666-4666-8666-666666666666', product_label: 'TEST product ×1',
  quantity_ordered: 1, customer_price: 10000, agent_payment_snapshot: 1000, rollover_count: 0,
  client: { name: 'TEST Vendor', auto_cancel_soft_fails: false }, location: { name: 'TEST zone' }, assigned_agent: { display_name: agent.display_name },
});
const older = row(1, 'TEST Older order', '08');
const recent = row(2, 'TEST Recent postponed', '10', 'postponed', offsetDay(3));
const due = row(3, 'TEST Due today', '11', 'postponed');
const excluded = row(4, 'TEST Other agent', '12', 'postponed', offsetDay(2), other);
const rows = [older, recent, due, excluded];
let left = true, departureCalls = 0;
const errors = [], writes = [], results = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin === origin) return route.continue();
  if (url.hostname !== 'api.redalogisticss.com') return route.abort();
  const name = url.pathname.split('/').at(-1);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !url.pathname.includes('/rpc/')) writes.push(name);
  let data = [];
  if (name === 'users') data = url.searchParams.has('id') ? admin : [admin, rider, other];
  if (name === 'user') data = admin;
  if (name === 'get_same_customer_config') data = { discovery_enabled: false };
  if (/^count_/.test(name)) data = 0;
  if (name === 'agent_departures') {
    departureCalls++;
    assert.equal(url.searchParams.get('depart_date'), `eq.${today}`, 'Departure query is scoped to today in Lagos');
    const records = [
      ...(left ? [{ agent_id: rider.id, departed_at: `${today}T09:44:00Z`, depart_date: today }] : []),
      { agent_id: other.id, departed_at: `${offsetDay(-1)}T09:00:00Z`, depart_date: offsetDay(-1) },
    ];
    data = records.filter(r => r.depart_date === today);
  }
  if (name === 'deliveries_admin' || name === 'deliveries_safe') {
    data = rows;
    if (url.searchParams.get('assigned_agent_id') === 'is.null') data = [];
    else if (url.searchParams.get('current_status') === 'eq.postponed') data = rows.filter(r => r.current_status === 'postponed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
    else if (url.searchParams.get('scheduled_date')?.startsWith('eq.')) data = rows.filter(r => r.scheduled_date === url.searchParams.get('scheduled_date').slice(3));
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
});
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (e) {
    results.push({ name, passed: false, error: String(e) }); console.error(`FAIL ${name}: ${e}`);
    writeFileSync(path.join(output, `${results.length}-failure.txt`), `${e}\n${await page.locator('body').innerText()}`);
    await page.screenshot({ path: path.join(output, `${results.length}-failure.png`), fullPage: true });
  }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(predicate) { for (let n = 0; n < 50; n++) { if (await predicate()) return; await pause(); } throw new Error('Expected UI state did not arrive'); }
const chip = page.getByText(/On the road ·/).and(page.locator(':not([aria-hidden="true"] *)'));
const customerText = name => page.getByText(name, { exact: true }).and(page.locator(':not([aria-hidden="true"] *)'));
try {
  await page.goto(`${origin}/(admin)`);
  await page.getByText('Agent workload', { exact: true }).waitFor();
  await check('#294 admin sees today’s departure, time and correct rider only', async () => {
    await until(async () => await chip.count() === 1);
    assert.match(await chip.innerText(), /10:44/);
    assert.equal(await customerText(rider.display_name).last().locator('..').getByText(/On the road/).count(), 1);
    assert.equal(await customerText(other.display_name).last().locator('..').getByText(/On the road/).count(), 0);
    assert.equal(departureCalls, 1, 'One initial departure query');
    await chip.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'admin-departure.png'), fullPage: true });
  });
  await page.getByText('TEST Rider One', { exact: true }).last().click();
  await page.getByText('Agent: TEST Rider One', { exact: true }).waitFor();
  await customerText(recent.customer_name).waitFor();
  await check('#283 workload navigation retains agent filter and normal activity ordering', async () => {
    const recentBox = await customerText(recent.customer_name).boundingBox();
    const olderBox = await customerText(older.customer_name).boundingBox();
    const dueBox = await customerText(due.customer_name).boundingBox();
    assert(dueBox.y < recentBox.y && recentBox.y < olderBox.y, 'Due 11:00 -> postponed 10:00 -> older 08:00');
    assert.equal(await customerText(excluded.customer_name).count(), 0);
    assert.equal(await customerText(due.customer_name).count(), 1, 'Due row is deduplicated');
    await page.screenshot({ path: path.join(output, 'postponed-ordering.png'), fullPage: true });
  });
  await check('#283 search and postponed view retain date semantics', async () => {
    const search = page.getByPlaceholder('Search name or phone (all dates)');
    await search.fill('Recent postponed');
    await until(async () => await customerText(older.customer_name).count() === 0);
    assert.equal(await customerText(recent.customer_name).count(), 1);
    await search.fill('');
    await until(async () => await customerText(older.customer_name).count() === 1);
    await customerText('Postponed').first().click();
    await until(async () => await customerText(older.customer_name).count() === 0);
    assert((await customerText(due.customer_name).boundingBox()).y < (await customerText(recent.customer_name).boundingBox()).y);
  });
  await check('#294 returning Home refreshes a changed departure', async () => {
    left = false;
    const before = departureCalls;
    await page.getByText('Home', { exact: true }).click();
    await until(async () => departureCalls > before);
    await until(async () => await chip.count() === 0);
    assert.equal(departureCalls, before + 1, 'One reload on focus');
  });
  assert.deepEqual(errors, [], 'No UI runtime errors');
  assert.deepEqual(writes, [], 'No data mutations');
} finally {
  writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, errors, writes }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
if (results.some(r => !r.passed)) process.exitCode = 1;
