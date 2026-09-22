import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const psql = process.env.EOD_TEST_PSQL || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql');
const args = ['-X','-h','127.0.0.1','-p','55449','-U','reda_test','-d','reda_eod_test','-v','ON_ERROR_STOP=1','-At'];
const actor="select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);";
function sql(input) { return execFileSync(psql,args,{input,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']}).trim(); }
if(sql("select current_database()='reda_eod_test' and current_user='reda_test' and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users)")!=='t') throw new Error('Empty isolated database required');
function expand(file) { return readFileSync(file,'utf8').replace(/^\\ir (.+)$/gm,(_,r)=>expand(path.resolve(path.dirname(file),r.trim()))); }
let fixture=expand(path.join(root,'tools/same-customer-pay-test-fixtures.sql'))
  .replace("current_database()<>'reda_same_customer_test' or inet_server_port()<>55439 or inet_server_addr()<>'127.0.0.1'::inet", "current_database()<>'reda_eod_test' or current_user<>'reda_test'")
  .replace("('rolled_over','terminal','Rolled over');", "('rolled_over','terminal','Rolled over') on conflict(status) do nothing;")
  .replace("values('pending','delivered');", "values('pending','delivered') on conflict do nothing;");
function session(input) {
  const child=spawn(psql,args,{stdio:['pipe','pipe','pipe']}); let out='',err='',readyResolve;
  const ready=new Promise(r=>{readyResolve=r;});
  child.stdout.on('data',b=>{out+=b; if(out.includes('LOCK_READY')) readyResolve();});
  child.stderr.on('data',b=>{err+=b;});
  const done=new Promise(resolve=>child.on('close',code=>{ readyResolve(); resolve({code,out,err}); }));
  child.stdin.end(input); return {ready,done};
}
const order="md5('same-customer-order-2')::uuid";
function command(id,revision,amount=0) { return `select public.correct_delivery_charge_v2('${id}',${order},'${revision}',0,${amount},'TEST concurrent waiver',true);`; }
try {
  sql(fixture+"\nupdate public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date,inactive_from=null; select public.change_delivery_status(p_client_uuid:='race-fee-'||n,p_delivery_id:=md5('same-customer-order-'||n)::uuid,p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=now()) from generate_series(1,2)n; COMMIT;");
  const revision=sql(`BEGIN; ${actor} select public.preview_delivery_charge_correction(${order})->>'revision'; COMMIT;`).split(/\r?\n/).at(-2);
  const a=session(`BEGIN; ${actor} ${command('88888888-1111-4111-8111-111111111111',revision)} select 'LOCK_READY'; select pg_sleep(1); COMMIT;`);
  await a.ready;
  const b=session(`BEGIN; ${actor} ${command('88888888-1111-4111-8111-111111111111',revision)} COMMIT;`);
  const c=session(`BEGIN; ${actor} ${command('88888888-2222-4222-8222-222222222222',revision,1000)} COMMIT;`);
  const results=await Promise.all([a.done,b.done,c.done]);
  assert.equal(results[0].code,0,results[0].err); assert.equal(results[1].code,0,results[1].err);
  assert.notEqual(results[2].code,0); assert.match(results[2].err,/changed/);
  assert.equal(sql('select count(*) from public.delivery_charge_correction_requests'),'1');
  assert.equal(sql('select count(*) from public.same_customer_fee_decisions'),'1');
  assert.equal(sql(`select final_amount from public.same_customer_earnings where delivery_id=${order}`),'0.00');
  const v2=sql(`BEGIN; ${actor} select public.preview_delivery_charge_correction(${order})->>'revision'; COMMIT;`).split(/\r?\n/).at(-2);
  const handover=session(`BEGIN; ${actor} select public.settle_period('agent',md5('same-customer-user-agent')::uuid,'2030-01-02','TEST race handover'); select 'LOCK_READY'; select pg_sleep(1); COMMIT;`);
  await handover.ready;
  const edit=session(`BEGIN; ${actor} ${command('88888888-3333-4333-8333-333333333333',v2,1000)} COMMIT;`);
  const [h,e]=await Promise.all([handover.done,edit.done]);
  assert.equal(h.code,0,h.err); assert.notEqual(e.code,0); assert.match(e.err,/settled|concurrently/);
  assert.throws(() => sql('BEGIN; '+actor+command('88888888-3333-4333-8333-333333333333',v2,1000)+' COMMIT;'), err => /settled/.test(err.stderr?.toString() || ''));
  assert.equal(sql("select expected_amount from public.settlements where subject_type='agent' and voided_at is null"),'17000.00');
  console.log('PASS real concurrent saves: one waiver decision for duplicate retries, stale competing edit rejected, concurrent settled handover preserved.');
} finally {
  // Only this runner's committed synthetic records, in the fixed local test DB.
  sql("BEGIN; DO $$ BEGIN IF current_database()<>'reda_eod_test' OR current_user<>'reda_test' THEN RAISE EXCEPTION 'Wrong test DB'; END IF; END $$; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations CASCADE; COMMIT;");
}
