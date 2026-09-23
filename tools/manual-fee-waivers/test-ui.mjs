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
const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos'}).format(new Date());
const admin={id:'22222222-2222-4222-8222-222222222222',email:'admin@example.invalid',display_name:'TEST Uzo',role:'admin',is_active:true};
const rider={...admin,id:'33333333-3333-4333-8333-333333333333',display_name:'TEST External',role:'agent',parent_agent_id:null};
const id='55555555-5555-4555-8555-555555555555', other='66666666-6666-4666-8666-666666666666';
const session={access_token:'isolated-ui-test',refresh_token:'isolated-ui-test',expires_at:Math.floor(Date.now()/1000)+3600,user:admin};
await page.addInitScript(s=>localStorage.setItem('sb-api-auth-token',JSON.stringify(s)),session);
let saved=false,handedOver=false,revision='version1',forcedConflict=false;
const calls=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));
const delivery=()=>({id,customer_name:'TEST waived delivery',customer_phone:'08000000000',raw_address:'TEST address',current_status:'delivered',scheduled_date:day,created_date:day,created_at:`${day}T10:00:00Z`,updated_at:`${day}T10:00:00Z`,assigned_agent_id:rider.id,order_type:'delivery',product_label:'TEST product',quantity_ordered:1,quantity_delivered:1,customer_price:50000,paid:50000,payment_method:'transfer',charged_snapshot:saved?0:7000,agent_payment_snapshot:saved?0:4000,margin:saved?0:3000,rollover_count:0,client:{name:'TEST client'},location:{name:'TEST zone'}});
await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.hostname==='127.0.0.1') return route.continue();
  if(url.hostname!=='api.redalogisticss.com') return route.abort();
  const rpc=url.pathname.split('/').at(-1),body=route.request().postDataJSON(); calls.push({rpc,body});
  let data=[];
  if(rpc==='users') data=url.searchParams.has('id')?admin:[admin,rider];
  if(/^count_/.test(rpc)) data=0;
  if(rpc==='get_same_customer_config') data={discovery_enabled:false,shadow_review_enabled:false};
  if(rpc==='deliveries_admin'||rpc==='deliveries_safe') data=url.searchParams.has('id')?delivery():[delivery()];
  if(rpc==='get_delivery_pay_state') data=[{delivery_id:id,mode:'final',state:saved?'ready':'pending',amount:saved?0:null,margin:saved?0:null,manual_exception:saved,review_reason:saved?null:'manual_review'}];
  if(rpc==='get_delivery_reda_charge') data=[{charged_snapshot:saved?0:7000,recommended_charge:7000,client_day_settled:false}];
  if(rpc==='preview_delivery_charge_correction') {
    const amount=body.p_apply_agent_override ? body.p_agent_payment : saved?0:4000;
    data={revision,charged:7000,agent_payment:saved?0:4000,proposed_charge:body.p_charged??7000,total:4000+amount,pending:false,settled:handedOver,
      orders:[{delivery_id:other,customer_name:'TEST paid delivery',amount:4000,reason:null,manual:false},{delivery_id:id,customer_name:'TEST waived delivery',amount,reason:null,manual:body.p_apply_agent_override||saved}]};
  }
  if(rpc==='correct_delivery_charge_v2') {
    assert.equal(body.p_agent_payment,0); assert.equal(body.p_charged,7000); assert.equal(body.p_apply_agent_override,true);
    assert.equal(body.p_reason,'Second fee waived — charge once');
    if(!forcedConflict) {
      forcedConflict=true; revision='version2';
      return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'40001',message:'These orders changed. Refresh the amounts before saving.'})});
    }
    assert.equal(body.p_revision,'version2'); saved=true;
    data={revision:'version3',charged:7000,agent_payment:0,total:4000,pending:false,settled:false,orders:[]};
    revision='version3';
  }
  if(rpc==='agent_earnings_summary_v2') data=[{agent_id:rider.id,agent_name:rider.display_name,deliveries_count:2,total_quantity:2,total_collected:100000,total_earnings:saved?4000:null,known_earnings:4000,total_remit:saved?96000:null,pending_pay_count:saved?0:1}];
  if(rpc==='list_agent_pay_issues') data={orders:saved?[]:[{delivery_id:id,customer_name:'TEST waived delivery',final_state:'pending',final_review_reason:'manual_review',final_amount:null,manual_amount:null,manual_reason:null,manual_actor:null}],next_cursor:null};
  if(rpc==='settle_period') { assert(saved); assert.equal(body.p_subject_id,rider.id); handedOver=true; data='77777777-7777-4777-8777-777777777777'; }
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
});
try {
  await page.goto('http://127.0.0.1:55453/(admin)/reconcile');
  await page.getByText('By agent',{exact:true}).click();
  assert.equal(await page.getByText(/^Pay review/).count(),0,'No review filter');
  await page.getByText('TEST External',{exact:true}).click();
  await page.getByText(/Delivery details changed after this fee was set/).waitFor();
  await page.screenshot({path:path.join(dist,`reconcile-issue-${page.viewportSize().width}.png`),fullPage:true});
  await page.getByRole('button',{name:'Change rider fee',exact:true}).click();
  await page.getByRole('textbox',{name:'Rider pay for this delivery',exact:true}).fill('0');
  assert.equal(await page.getByRole('textbox',{name:'Reda charge to client',exact:true}).count(),0,'Rider-only change does not ask for client charge');
  await page.getByRole('textbox',{name:'Adjustment reason',exact:true}).fill('Second fee waived — charge once');
  await page.getByText('Combined rider pay: ₦4,000',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Save rider fee',exact:true}).click();
  await page.getByText('These orders changed. Refresh the amounts before saving.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Refresh amounts',exact:true}).click();
  await page.getByText('Combined rider pay: ₦4,000',{exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Rider pay for this delivery',exact:true}).inputValue(),'0');
  await page.getByRole('button',{name:'Save rider fee',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert(saved);
  await page.goto('http://127.0.0.1:55453/(admin)/reconcile');
  await page.getByText('By agent',{exact:true}).click();
  await page.getByText('TEST External',{exact:true}).click();
  await page.getByRole('button',{name:'Mark handed over',exact:true}).waitFor();
  assert.equal(await page.getByText('Known rider earnings',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Change rider fee',exact:true}).count(),0,'Approved waiver needs no review');
  await page.screenshot({path:path.join(dist,`reconcile-simple-${page.viewportSize().width}.png`),fullPage:true});
  page.once('dialog',async d=>{assert(d.message().includes('₦96,000'));await d.accept();});
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/settle_period')),page.getByRole('button',{name:'Mark handed over',exact:true}).click()]);
  assert(handedOver); assert.deepEqual(errors,[]);
  console.log('PASS exported UI: issue in Outstanding, direct rider fee edit, zero allowed, client charge preserved, stale-save recovery, no unnecessary review, exact handover.');
} catch(e) {
  writeFileSync(path.join(rootDir(),'ui-failure.txt'),`${e}\n${errors.join('\n')}\n${await page.locator('body').innerText()}\n${JSON.stringify(calls.slice(-20))}`);
  throw e;
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
function rootDir() { return path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1')); }
