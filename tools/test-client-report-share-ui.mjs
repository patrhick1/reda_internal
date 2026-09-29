// Actual exported app, synthetic accounts/reports, intercepted shares and APIs.
// No messages, emails or production mutations are sent by this test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dist=path.resolve(process.env.SHARE_UI_DIST||'mobile/dist');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH?pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH,'index.mjs')).href:'playwright');
const server=createServer((req,res)=>{
 const requested=path.resolve(dist,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
 if(!requested.startsWith(dist+path.sep))return res.writeHead(403).end();
 const file=existsSync(requested)&&path.extname(requested)?requested:path.join(dist,'index.html');
 res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.ttf':'font/ttf','.png':'image/png','.ico':'image/x-icon'})[path.extname(file)]||'application/octet-stream');res.end(readFileSync(file));
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,...(process.env.EOD_UI_BROWSER_CHANNEL?{channel:process.env.EOD_UI_BROWSER_CHANNEL}:{})});
const cid='bf10eeca-fa09-47db-9596-a78ffba455fb';
const row=(i)=>({delivery_id:'order-'+i,order_type:'delivery',scheduled_date:'2026-09-28',customer_name:'Synthetic customer '+i,customer_phone:'08000000000',client_rep:'REF-'+i,product_name:'Toothpaste',products:[{product_name:'Toothpaste',quantity_ordered:2,quantity_delivered:2}],quantity_ordered:2,quantity_delivered:2,customer_price:25000,paid:25000,payment_method:'transfer',reda_fee:5000,cash_pos_fee:0,remit:20000,outstanding:0,agent_name:'Test rider',location_name:'Test area',note:null});
try{
 for(const role of ['admin','rep']) for(const width of [320,390,1280]){
  let count=70; let accountFail=false;
  const user={id:'22222222-2222-4222-8222-222222222222',email:'test@example.invalid',role,is_active:true,display_name:'Test operator'};
  const page=await browser.newPage({viewport:{width,height:850}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.routeWebSocket(/.*/,ws=>ws.close());
  await page.addInitScript(user=>{
   localStorage.setItem('sb-api-auth-token',JSON.stringify({access_token:'isolated-ui-test',refresh_token:'isolated-ui-test',expires_at:Math.floor(Date.now()/1000)+3600,user}));
   window.shareCalls=[];window.shareMode='success';window.copied=[];window.copyFail=false;
   Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.shareCalls.push(data.text);if(window.shareMode==='cancel')throw new DOMException('cancel','AbortError');if(window.shareMode==='fail')throw new Error('test unavailable');if(window.shareMode==='pending')await new Promise(ok=>window.finishShare=ok);}});
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(window.copyFail)throw new Error('clipboard unavailable');window.copied.push(text);}}});
   document.execCommand=()=>{throw new Error('clipboard unavailable');};
  },user);
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin===origin)return route.continue();
   if(url.hostname!=='api.redalogisticss.com')return route.abort();
   const name=url.pathname.split('/').at(-1);let data=[];
   if(name==='client_account_balances'&&accountFail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic unavailable balance'})});
   if(name==='users')data=url.searchParams.has('id')?user:[user];
   if(name==='user')data=user;
   if(name==='client_remit_detail'||name==='client_remit_detail_rep')data=Array.from({length:count},(_,i)=>row(i));
   if(name==='get_same_customer_config')data={discovery_enabled:false};
   if(name==='get_blacklist_notice_summary')data={count:0,through_id:null,inbound_id:null};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  const url=origin+'/('+role+')/reconcile/client/'+cid+'?name=Test%20vendor&from=2026-09-28&to=2026-09-28';
  await page.goto(url);await page.getByRole('button',{name:'Share with client',exact:true}).click();
  await page.getByText('Share delivery update',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>shareCalls.length),0,'long report waits for an explicit share');
  const subtitle=await page.getByText(/This update needs \d+ messages/).innerText();const n=Number(subtitle.match(/needs (\d+)/)[1]);assert(n>1);
  const shared=[];
  for(let i=1;i<=n;i++){
   const button=page.getByRole('button',{name:'Share part '+i,exact:true});await button.waitFor();
   await page.waitForFunction(label=>{const e=document.querySelector('[aria-label="'+label+'"]');if(!e)return false;for(let p=e;p;p=p.parentElement){if(Number(getComputedStyle(p).opacity)<0.999)return false;}const nav=document.querySelector('[aria-label="Next part"]')||document.querySelector('[aria-label="Done"]');const r=e.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight&&r.x>=0&&r.right<=innerWidth&&nav&&nav.getBoundingClientRect().bottom<=innerHeight;},'Share part '+i);
   if(process.env.SHARE_UI_SCREENSHOTS&&i===1)await page.screenshot({path:path.join(process.env.SHARE_UI_SCREENSHOTS,'share-first-'+role+'-'+width+'.png')});
   if(i===1){
    await page.evaluate(()=>shareMode='cancel');await button.click();await page.getByRole('button',{name:'Copy',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Share part 1',exact:true}).count(),1);
    await page.evaluate(()=>shareMode='fail');await button.click();await page.getByText('Could not open sharing. Try again, or copy the message below.',{exact:true}).waitFor();
    await page.evaluate(()=>{shareMode='pending';});await button.click();await page.waitForFunction(()=>!!window.finishShare);assert(await button.isDisabled());await page.evaluate(()=>{finishShare();shareMode='success';});await page.waitForFunction(()=>!document.querySelector('[aria-label="Copy"][aria-disabled="true"]'));
   }
   await page.evaluate(()=>shareMode='success');await button.click();
   shared.push(await page.evaluate(()=>shareCalls.at(-1)));
   await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByText('Copied. Paste it into the same WhatsApp chat.',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>copied.at(-1)),shared.at(-1));
   if(i===2){
    count=1; // A later refresh must not replace the parts already being shared.
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Continue sharing (2 of '+n+')',exact:true}).click();
    await page.getByRole('button',{name:'Previous',exact:true}).click();await page.getByRole('button',{name:'Share part 1',exact:true}).click();assert.equal(await page.evaluate(()=>shareCalls.at(-1)),shared[0]);
    await page.getByRole('button',{name:'Next part',exact:true}).click();
   }
   if(i<n)await page.getByRole('button',{name:'Next part',exact:true}).click();
  }
  for(const message of shared)assert(Buffer.byteLength(message,'utf8')<=3500);
  for(let i=0;i<70;i++)assert.equal(shared.join('\n').split('Name: Synthetic customer '+i+'\n').length-1,1);
  assert(shared.at(-1).includes('Total\n'));assert(shared.at(-1).includes('To Remit: ₦1,400,000'));
  if(process.env.SHARE_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SHARE_UI_SCREENSHOTS,'share-'+role+'-'+width+'.png')});
  await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Share with client',exact:true}).waitFor();
  await page.goto(url);await page.getByRole('button',{name:'Share with client',exact:true}).click();await page.waitForFunction(()=>shareCalls.length===1);
  assert.equal(await page.getByText('Share delivery update',{exact:true}).count(),0,'short report shares directly');
  await page.evaluate(()=>shareMode='fail');await page.getByRole('button',{name:'Share with client',exact:true}).click();await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByText('Copied. Paste it into the same WhatsApp chat.',{exact:true}).waitFor();
  await page.evaluate(()=>copyFail=true);await page.getByRole('button',{name:'Copy',exact:true}).click();await page.getByText('Could not copy. Try again or use Share.',{exact:true}).waitFor();
  accountFail=true;await page.goto(url);await page.getByText('Could not load the complete update. Retry before sharing.',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'Share with client',exact:true}).isDisabled());accountFail=false;await page.getByRole('button',{name:'Retry',exact:true}).click();await page.getByRole('button',{name:'Share with client',exact:true}).click();await page.waitForFunction(()=>shareCalls.length===1);
  assert.deepEqual(errors,[]);await page.close();console.log('PASS',role,width,'bytes, complete orders/totals, cancel/error/retry, copy, explicit next, close/resume, frozen snapshot, short direct share');
 }
}finally{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
