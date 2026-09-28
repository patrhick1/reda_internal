// Exercises the actual exported app with synthetic data; all external HTTP and
// WebSocket traffic is intercepted. No real account, order, or push is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.BLACKLIST_WEB_BUILD ?? `${process.env.TEMP}/reda-blacklist-notices-final`);
const env = readFileSync(new URL('../../mobile/.env.local',import.meta.url),'utf8');
const api = new URL(env.match(/^EXPO_PUBLIC_SUPABASE_URL=["']?([^\r\n"']+)/m)[1]);
const { chromium } = (await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE ?? 'C:/Users/ebube/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js').href)).default;
const uid='11111111-1111-4111-8111-111111111111';
const inbound='22222222-2222-4222-8222-222222222222';
let count=2,ackFail=false,acks=[],creates=0;
const row={id:inbound,status:'blocked',received_at:new Date().toISOString(),raw_text:'Synthetic blocked order',delivery_id:null,error_text:'Blocked: customer number is blacklisted — Repeated failed deliveries',extracted:{customer_name:'Test Customer',customer_phone:'08030000001',raw_address:'Test address'},product:{product_name:'Test Cream',client_name:'Test Vendor'}};
const server=createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://local').pathname);
  let path=resolve(root,`.${pathname}`);
  if(!path.startsWith(root)) {res.writeHead(403);res.end();return;}
  if(!existsSync(path)||!extname(path)) path=resolve(root,'index.html');
  const mime={'.js':'application/javascript','.html':'text/html','.ttf':'font/ttf','.png':'image/png','.ico':'image/x-icon'};
  res.writeHead(200,{'Content-Type':mime[extname(path)]??'application/octet-stream'});res.end(readFileSync(path));
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
await page.routeWebSocket(/.*/,ws=>ws.close());
await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===origin) return route.continue();
  if(u.origin!==api.origin) return route.abort();
  let body=[];const name=u.pathname.split('/').at(-1);
  const profile={id:uid,email:'test@example.invalid',is_active:true,role:'admin',display_name:'Test Operator'};
  if(name==='users') body=[profile];
  if(name==='clients') body=[{id:'33333333-3333-4333-8333-333333333333',name:'Test Vendor',is_active:true}];
  if(name==='locations') body=[{id:'44444444-4444-4444-8444-444444444444',name:'Test Area',is_active:true}];
  if(name==='product_catalog') body=[{id:'55555555-5555-4555-8555-555555555555',client_id:'33333333-3333-4333-8333-333333333333',product_name:'Test Cream',is_active:true}];
  if(name==='preview_delivery_charge') body=null;
  if(name==='get_blacklist_notice_summary') body={count,through_id:count?'2':null,inbound_id:count?inbound:null};
  if(name==='acknowledge_blacklist_notices') {
    if(ackFail) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic offline'})});
    acks.push(route.request().postDataJSON());count=0;body=null;
  }
  if(name==='bot_inbound_messages') body=u.searchParams.has('id') || u.searchParams.get('status')==='eq.blocked'
    ? [{...row,parse_result:{extracted:row.extracted,product:row.product}}] : [];
  if(name==='check_customer_blacklist') body=null;
  if(name==='create_delivery') {
    creates++;
    return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:'P0001',message:'Customer number is blacklisted',hint:JSON.stringify({kind:'blacklisted',phone:'08030000001',reason:'Repeated failed deliveries'})})});
  }
  await route.fulfill({status:200,contentType:'application/json',headers:{'content-range':'0-0/0'},body:JSON.stringify(body)});
});
await page.addInitScript(({key,uid})=>{
  const user={id:uid,email:'test@example.invalid',aud:'authenticated',role:'authenticated'};
  const token=[btoa(JSON.stringify({alg:'none'})),btoa(JSON.stringify({sub:uid,exp:Math.floor(Date.now()/1000)+3600})), 'synthetic'].join('.');
  localStorage.setItem(key,JSON.stringify({access_token:token,refresh_token:'synthetic',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}));
},{key:`sb-${api.hostname.split('.')[0]}-auth-token`,uid});
try {
  await page.goto(`${origin}/(admin)/needs-review?tab=blocked&inboundId=${inbound}`);
  await page.getByText('2 new orders blocked by blacklist',{exact:true}).waitFor();
  await page.getByText('No delivery created',{exact:true}).waitFor();
  await page.getByText('From notification',{exact:true}).waitFor();
  assert.equal(await page.getByText('Test Customer',{exact:true}).count(),1);
  await page.screenshot({path:resolve(process.env.TEMP,'reda-blacklist-mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  ackFail=true;
  await page.getByRole('button',{name:'Mark seen',exact:true}).click();
  await page.getByText(/Could not mark seen/).waitFor();
  ackFail=false;
  await page.getByRole('button',{name:'Mark seen',exact:true}).click();
  await page.getByText('2 new orders blocked by blacklist',{exact:true}).waitFor({state:'hidden'});
  assert.deepEqual(acks,[{p_through_id:'2'}]);
  await page.reload();
  await page.getByText('Test Customer',{exact:true}).waitFor();
  assert.equal(await page.getByText('2 new orders blocked by blacklist',{exact:true}).count(),0);
  count=2;
  await page.setViewportSize({width:1365,height:900});
  await page.reload();
  await page.getByText('2 new orders blocked by blacklist',{exact:true}).waitFor();
  await page.getByRole('button',{name:'View blocked orders',exact:true}).click();
  assert.match(page.url(),/tab=blocked/);
  await page.getByText('Errors',{exact:true}).filter({visible:true}).click();
  await page.getByText('Test Customer',{exact:true}).filter({visible:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'View blocked orders',exact:true}).click();
  await page.getByText('Test Customer',{exact:true}).filter({visible:true}).waitFor();
  assert.match(page.url(),/tab=blocked/);
  await page.screenshot({path:resolve(process.env.TEMP,'reda-blacklist-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}/(admin)/deliveries/new`);
  await page.getByPlaceholder('Akoro Edidi').fill('Manual Customer');
  assert.equal(await page.getByText('2 new orders blocked by blacklist',{exact:true}).count(),0,'unrelated bot notice stays quiet during manual entry');
  await page.getByPlaceholder('+234 805…').fill('08030000001');
  await page.getByPlaceholder('17 Admiralty Way, Lekki').fill('Test address');
  await page.getByText('Test Vendor',{exact:true}).click();
  await page.getByText('Select product',{exact:true}).click();
  await page.getByText('Test Cream',{exact:true}).click();
  await page.getByText('Test Cream',{exact:true}).nth(1).waitFor({state:'hidden'});
  await page.locator('input[inputmode="numeric"]').first().fill('1');
  await page.locator('input[inputmode="numeric"]').nth(1).fill('19500');
  await page.getByText('Match to the delivery area',{exact:true}).click();
  await page.getByText('Test Area',{exact:true}).click();
  await page.getByText('Test Area',{exact:true}).nth(1).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Create delivery',exact:true}).click();
  const refusal=page.getByRole('alert').filter({hasText:'Order not created:'});
  await refusal.waitFor();
  assert.match(await refusal.innerText(),/Repeated failed deliveries/);
  assert.equal(await page.getByPlaceholder('Akoro Edidi').inputValue(),'Manual Customer');
  assert.match(page.url(),/deliveries\/new/);
  assert.equal(creates,1);
  const bounds=await refusal.boundingBox();
  assert(bounds.y>=0 && bounds.y+bounds.height<=844,'refusal is visible without scrolling to find it');
  await page.screenshot({path:resolve(process.env.TEMP,'reda-blacklist-manual.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS actual web app: grouped notice, blocked deep link, retained record, failed acknowledgment, per-user seen persistence, mobile/desktop layout, inline manual rejection with preserved form');
} catch(error) {
  console.log((await page.locator('body').innerText()).slice(0,2500));
  console.log('Browser errors',errors);
  throw error;
} finally { await browser.close();await new Promise(ok=>server.close(ok)); }
