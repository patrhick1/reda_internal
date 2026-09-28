// Actual exported stock screen with synthetic API data; no production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, 'index.mjs')).href
    : 'playwright'
);
const dist = path.resolve(process.env.EOD_UI_DIST || 'mobile/dist');
const server = createServer((req, res) => {
  const requested = path.resolve(
    dist,
    '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
  );
  if (!requested.startsWith(dist + path.sep) && requested !== dist)
    return res.writeHead(403).end();
  const file = existsSync(requested) && path.extname(requested)
    ? requested
    : path.join(dist, 'index.html');
  res.setHeader('Content-Type', {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.ttf': 'font/ttf',
  }[path.extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(55453, '127.0.0.1', resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EOD_UI_BROWSER_CHANNEL ? { channel: process.env.EOD_UI_BROWSER_CHANNEL } : {}),
});
const admin = {
  id: '22222222-2222-4222-8222-222222222222', email: 'test@example.invalid',
  display_name: 'TEST admin', role: 'admin', is_active: true,
};
const holder = {
  ...admin, id: '33333333-3333-4333-8333-333333333333', display_name: 'TEST agent', role: 'agent',
};
const descriptions = [
  'Received from Shomolu warehouse · by Martha',
  'Transferred from Another warehouse with a longer name · by Greg Uzo',
];
try {
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((session) => {
      localStorage.setItem('sb-api-auth-token', JSON.stringify(session));
    }, {
      access_token: 'isolated-ui-test', refresh_token: 'isolated-ui-test',
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: admin,
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const name = url.pathname.split('/').at(-1);
      if (url.hostname === '127.0.0.1') return route.continue();
      if (url.hostname !== 'api.redalogisticss.com') return route.abort();
      let data = [];
      if (name === 'users') {
        data = url.searchParams.has('id')
          ? (url.searchParams.get('id').includes(holder.id) ? holder : admin)
          : [admin, holder];
      }
      if (name === 'user') data = admin;
      if (name === 'get_same_customer_config') data = { discovery_enabled: false };
      if (name === 'get_blacklist_notice_summary') {
        data = { count: 0, latest_id: null, latest_inbound_id: null };
      }
      if (/^count_/.test(name)) data = 0;
      if (name === 'list_stock_movements') {
        data = [0, 1].map((i) => ({
          source: 'adjustment', event_id: `55555555-5555-4555-8555-55555555555${i}`,
          event_at: new Date().toISOString(), event_kind: i ? 'transfer' : 'warehouse_issue',
          product_catalog_id: '66666666-6666-4666-8666-666666666666',
          product_name: i ? 'Pureflow Water Filter' : 'Stand Again Oil',
          quantity_delta: i ? 30 : 1, quantity_ordered: null, notes: null,
          actor_id: admin.id, actor_name: i ? 'Greg Uzo' : 'Martha',
          counterparty_holder_id: admin.id,
          counterparty_holder_name: i ? 'Another warehouse with a longer name' : 'Shomolu warehouse',
          balance_after: null,
        }));
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto(`http://127.0.0.1:55453/(admin)/stock/movements/${holder.id}`);
    for (const description of descriptions) {
      const node = page.getByText(description, { exact: true });
      await node.waitFor();
      const measured = await node.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const amount = element.parentElement.nextElementSibling.getBoundingClientRect();
        return {
          height: rect.height, lineHeight: parseFloat(style.lineHeight),
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
          right: rect.right, amountLeft: amount.left,
        };
      });
      assert(measured.scrollWidth <= measured.clientWidth + 1, 'Full description fits its column');
      assert(measured.right <= measured.amountLeft, 'Description does not overlap quantity');
      if (width < 400) assert(measured.height > measured.lineHeight, 'Description wraps on phone');
    }
    assert.deepEqual(errors, []);
    console.log('PASS full stock movement descriptions wrap without quantity overlap', width);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
