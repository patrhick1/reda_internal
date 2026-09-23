// Runs the exported production UI against synthetic API responses. The SQL
// suites independently verify those responses against the real database.
// EOD_UI_DIST points at the export; PLAYWRIGHT_MODULE_PATH is optional.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, 'index.mjs')).href : 'playwright');
const dist = path.resolve(process.env.EOD_UI_DIST || 'mobile/dist');
const server = createServer((req, res) => {
  const requested = path.resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!requested.startsWith(dist + path.sep) && requested !== dist) { res.writeHead(403).end(); return; }
  const file = existsSync(requested) && path.extname(requested) ? requested : path.join(dist, 'index.html');
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream';
  res.setHeader('Content-Type', mime); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(55453, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.EOD_UI_BROWSER_CHANNEL ? {channel:process.env.EOD_UI_BROWSER_CHANNEL} : {}) });
const page = await browser.newPage({ viewport: { width: Number(process.env.EOD_UI_WIDTH || 1280), height: 1000 } });
const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos'}).format(new Date());
const nextDay = new Date(today+'T00:00:00Z'); nextDay.setUTCDate(nextDay.getUTCDate()+1); if(nextDay.getUTCDay()===0)nextDay.setUTCDate(nextDay.getUTCDate()+1); const target=nextDay.toISOString().slice(0,10);
const admin = { id: '22222222-2222-4222-8222-222222222222', email: 'admin@example.invalid', display_name: 'TEST dispatcher', role: 'admin', is_active: true };
const agent = { ...admin, id: '33333333-3333-4333-8333-333333333333', display_name: 'TEST Agent', role: 'agent', parent_agent_id: null };
const session = { access_token: 'isolated-ui-test', refresh_token: 'isolated-ui-test', expires_at: Math.floor(Date.now()/1000)+3600, user: admin };
await page.addInitScript(session => localStorage.setItem('sb-api-auth-token', JSON.stringify(session)), session);
let submitted = false, completed = false, assigned = false;
let statusInterrupted = false, statusOverride = null;
const calls = [], errors = [];
const preview = { preview_id: '44444444-4444-4444-8444-444444444444', kind: 'finish_day', date: today, target_date: target, total_orders: 101, oversized_groups: 0, summary: { roll: 100, cap_unserious: 1 }, rows: Array.from({length:100}, (_, i) => ({ id: `row-${i}`, customer_name: `TEST review ${i}`, status: 'pending', date: today, agent: 'TEST Agent', carry: 0, action: 'roll', target_date: target, product_name:'TEST product',quantity:1,customer_price:10000 })) };
const delivery = (id, name, date) => ({ id, customer_name: name, customer_phone: '08000000000', raw_address: 'TEST address', current_status: 'pending', scheduled_date: date, created_date: today, created_at: `${today}T20:00:00Z`, updated_at: `${today}T20:00:00Z`, assigned_agent_id: null, order_type: 'delivery', product_label: 'TEST product', quantity_ordered: 1, customer_price: 10000, agent_payment_snapshot: 1000, rollover_count: 1, client: {name:'TEST client'}, location:{name:'TEST zone'} });
const prepared = delivery('55555555-5555-4555-8555-555555555555','TEST prepared recipient',target);
const unrelated = delivery('66666666-6666-4666-8666-666666666666','TEST earlier recipient',today);
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname === '127.0.0.1') return route.continue();
  // No test request may reach a real backend or external service.
  if (url.hostname !== 'api.redalogisticss.com') return route.abort();
  const rpc = url.pathname.split('/').at(-1), body = route.request().postDataJSON();
  calls.push({ rpc, body });
  let data = [];
  if (rpc === 'users') data = url.searchParams.has('id') ? admin : [admin, agent];
  if (rpc === 'maintenance_health') data = { enabled: true, today, close_through: '2026-09-20', release_through: today, worker_at: `${today}T21:00:00Z`, alerts:[], holds:[], failures:[], notification_failures:0, runs: submitted ? [{ id: 'run-test', kind:'finish_day', business_date:today, target_date:target, status:completed?'succeeded':'running', remaining_groups:completed?0:1, failed_groups:0, changed_groups:0, outcomes:completed?{rolled:100,capped:1}:{} }] : [] };
  if (rpc === 'prepare_manual_eod') { assert.deepEqual(body,{p_for_date:today}); data=preview; }
  if (rpc === 'manual_eod_preview_page') { assert.equal(body.p_offset,100); data=[{...preview.rows[0],id:'row-last',customer_name:'TEST carry limit',carry:1,action:'cap_unserious',target_date:null}]; }
  if (rpc === 'request_manual_eod') { assert.equal(body.p_preview_id,preview.preview_id); submitted=true; data='run-test'; }
  if (rpc === 'manual_eod_status') {
    assert.equal(body.p_preview_id,preview.preview_id);
    if (!statusInterrupted) { statusInterrupted=true; return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'TEST temporary connection failure'})}); }
    data=statusOverride??{complete:completed,needs_attention:false,target_date:target,outcomes:completed?{rolled:100,capped:1}:{},problems:[]};
  }
  if (rpc === 'get_same_customer_config') data={discovery_enabled:false};
  if (rpc === 'deliveries_admin' || rpc === 'deliveries_safe') data = [prepared,unrelated].filter(d=>!assigned || d.id!==prepared.id);
  if (rpc === 'bulk_assign_deliveries') { assert.deepEqual(body,{p_delivery_ids:[prepared.id],p_agent_id:agent.id,p_expected_dates:{[prepared.id]:target}}); assigned=true;data=1; }
  if (/^count_/.test(rpc)) data=0;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
try {
  await page.goto('http://127.0.0.1:55453/(admin)/eod');
  await page.getByText('Roll forward · 100',{exact:true}).waitFor();
  assert.equal(await page.getByText('Recent runs',{exact:true}).count(),0);
  page.once('dialog', async dialog => { await dialog.dismiss(); });
  await page.getByRole('button',{name:'Run end of day',exact:true}).click();
  assert(!submitted,'Cancelling does not start work');
  await page.getByRole('button',{name:'Show more orders',exact:true}).click();
  await page.getByText('TEST carry limit',{exact:true}).waitFor();
  page.once('dialog', async dialog => { assert(dialog.message().includes('all 101 orders')); assert(dialog.message().includes(target)); await dialog.accept(); });
  await page.getByRole('button',{name:'Run end of day',exact:true}).click();
  await page.getByText('Working…',{exact:true}).waitFor();
  await page.getByText('Waiting for a connection to confirm the result. You do not need to run it again.',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('Working…',{exact:true}).waitFor();
  assert.equal(calls.filter(c=>c.rpc==='request_manual_eod').length,2,'Reload resumes the same request');
  assert.equal(await page.getByRole('button',{name:'View prepared orders',exact:true}).count(),0,'No completion navigation while work remains');
  completed=true;
  await page.getByRole('button',{name:'View prepared orders',exact:true}).click({timeout:15000});
  await page.getByText(`Prepared for ${target}. Only unassigned orders on this date are shown.`,{exact:true}).waitFor();
  await page.getByText('TEST prepared recipient',{exact:true}).waitFor();
  assert.equal(await page.getByText('TEST earlier recipient',{exact:true}).count(),0,'Prepared view excludes other dates');
  await page.getByRole('button',{name:'Select all 1 visible',exact:true}).click();
  await page.getByRole('button',{name:'Assign 1 selected',exact:true}).click();
  await page.getByText(`Assignment keeps each order’s scheduled date. 1 for ${target}`,{exact:true}).waitFor();
  await page.getByText('TEST Agent',{exact:true}).click();
  await page.getByRole('button',{name:'Show all Unassigned',exact:true}).click();
  await page.getByText('TEST earlier recipient',{exact:true}).waitFor();
  for (const tab of ['By client','By agent','Summary']) {
    await page.goto('http://127.0.0.1:55453/(admin)/reconcile');
    await page.getByText(tab,{exact:true}).click();
    await page.getByRole('button',{name:'Run end of day',exact:true}).click();
    await page.getByRole('button',{name:'Run end of day',exact:true}).waitFor();
  }
  preview.rows=[...preview.rows.slice(0,3),{...preview.rows[0],id:'row-last',customer_name:'TEST carry limit',carry:1,action:'cap_unserious',target_date:null}];
  preview.total_orders=4; preview.summary={roll:3,cap_unserious:1};
  await page.reload();
  await page.getByText('Close out · 1',{exact:true}).waitFor();
  await page.screenshot({path:path.join(dist,`eod-simple-${page.viewportSize().width}.png`),fullPage:true});
  statusOverride={complete:true,needs_attention:true,target_date:target,outcomes:{rolled:2},problems:[{id:'row-last',customer_name:'TEST changed order',message:'This order changed while end of day was running. Check it before trying again.'}]};
  page.once('dialog', async dialog => dialog.accept());
  await page.getByRole('button',{name:'Run end of day',exact:true}).click();
  await page.getByText('TEST changed order',{exact:true}).waitFor();
  assert.equal(await page.getByText(/End of day complete/).count(),0,'Partial failure is not success');
  await page.getByRole('button',{name:'Check remaining orders',exact:true}).click();
  await page.getByRole('button',{name:'Run end of day',exact:true}).waitFor();
  assert(assigned,'Assignment action reached guarded RPC');
  assert(!calls.some(c=>c.rpc==='run_eod_rollover_all_stuck'),'All updated entrypoints use reviewed manual flow');
  assert.deepEqual(errors,[],'No UI runtime errors');
  console.log('PASS actual exported UI: early manual preview, pagination, explicit confirmation, wait for completion, prepared-date list, guarded assignment, normal all-date queue, all 3 Reconciliation entrypoints');
} catch (e) {
  writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1')), 'manual-ui-failure.txt'), `${e}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);
  throw e;
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
