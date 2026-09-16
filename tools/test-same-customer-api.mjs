import assert from 'node:assert/strict';
import { createHmac,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const base='http://127.0.0.1:55441';
const md5=s=>createHash('md5').update(s).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
const jwt=(role)=>{const parts=[{alg:'HS256',typ:'JWT'},{role:'authenticated',sub:md5('same-customer-user-'+role),exp:Math.floor(Date.now()/1000)+600}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');return parts+'.'+createHmac('sha256','isolated-reda-api-test-secret-at-least-32-characters').update(parts).digest('base64url')};
async function req(path,body,modern=true,role='admin') {const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+jwt(role),'Content-Type':'application/json',...(modern?{'x-reda-payment-contract':'1'}:{})},...(body?{body:JSON.stringify(body)}:{})}); const t=await r.text();return {status:r.status,data:t?JSON.parse(t):null};}
const sql=s=>execFileSync('C:/Program Files/PostgreSQL/17/bin/psql.exe',['-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','reda_same_customer_test','-v','ON_ERROR_STOP=1','-At','-c',s],{encoding:'utf8'});
for(let i=0;i<40;i++){try {const r=await req('/rpc/get_same_customer_config',{},false);if(r.status===200)break;await new Promise(r=>setTimeout(r,250));}catch{await new Promise(r=>setTimeout(r,250));}}
assert.equal((await req('/rpc/get_same_customer_config',{},false)).status,200);
sql("update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date;");
assert.equal((await req('/deliveries_safe?select=id,agent_payment_snapshot',null,false,'agent')).status,426);
assert.equal((await req('/users?select=id',null,false)).status,200);
const completion=n=>({p_client_uuid:'api-completion-'+n,p_delivery_id:md5('same-customer-order-'+n),p_to_status:'delivered',p_quantity_delivered:1,p_paid:10000,p_payment_method:'transfer',p_effective_at:new Date().toISOString()});
assert.equal((await req('/rpc/change_delivery_status',completion(1),false)).status,426);
assert.equal(sql("select count(*) from public.deliveries where current_status='delivered'").trim(),'0');
for(const n of [1,2]) {const r=await req('/rpc/change_delivery_status',completion(n)); assert.equal(r.status,204,JSON.stringify(r));}
let r=await req('/rpc/agent_earnings_summary_v2',{p_from:'2000-01-01',p_to:'2100-01-01'}); assert.equal(r.status,200,JSON.stringify(r));assert.equal(Number(r.data[0].total_earnings),4500);
r=await req('/rpc/correct_delivery_charge',{p_delivery_id:md5('same-customer-order-1'),p_charged:4000,p_agent_payment:2500,p_reason:'TEST API pending payment'});assert.equal(r.status,204,JSON.stringify(r));
r=await req('/rpc/agent_earnings_summary_v2',{p_from:'2000-01-01',p_to:'2100-01-01'});assert.equal(r.data[0].pending_pay_count,2);assert.equal(r.data[0].total_earnings,null);
r=await req('/rpc/get_delivery_pay_state',{p_delivery_ids:[md5('same-customer-order-1'),md5('same-customer-order-2')]},true,'agent');assert.equal(r.status,200,JSON.stringify(r));assert(r.data.every(x=>x.state==='pending'&&x.amount===null));
assert.equal((await req('/deliveries_safe?select=id,agent_payment_snapshot',null,false,'agent')).status,426);
console.log('PASS: real PostgREST 14.12 API; legacy reads/writes blocked before execution, profile retained, modern completions, full/half earnings, pending correction and rider metadata.');
