import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const psql = process.env.EOD_TEST_PSQL || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql');
const bench = process.argv.includes('--bench');
const manualBench = process.argv.includes('--manual');
const race = process.argv.includes('--race');
const db = bench ? 'reda_eod_bench' : race ? 'reda_eod_race' : 'reda_eod_test';
const args = ['-X', '-h', '127.0.0.1', '-p', '55449', '-U', 'reda_test', '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'];
function sql(text, database = db) {
  const a = [...args]; a[a.indexOf('-d')+1] = database;
  return execFileSync(psql, a, { input: text, encoding: 'utf8', maxBuffer: 64*1024*1024, stdio: ['pipe','pipe','pipe'] }).trim();
}
function file(name) { return readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''); }
function checkEmpty() {
  // The client is always pinned to localhost:55449. GitHub's service container
  // sees its private bridge address and internal port, not that published port.
  const local = sql("select inet_server_addr()='127.0.0.1'::inet and inet_server_port()=55449") === 't';
  const ciContainer = process.env.GITHUB_ACTIONS === 'true'
    && sql("select inet_server_addr()<<'172.16.0.0/12'::inet and inet_server_port()=5432") === 't';
  if (sql('select current_database()') !== db || sql('select current_user') !== 'reda_test'
    || (!local && !ciContainer)) throw new Error('Isolated database required');
}
checkEmpty();
if (process.argv.includes('--setup')) {
  if (sql("select to_regclass('public.deliveries') is null") !== 't') throw new Error('Setup requires a fresh database');
  sql(file('bootstrap.sql'));
  const baseline = gunzipSync(readFileSync(path.join(dir, 'fixtures/baseline.sql.gz')));
  const manifest = JSON.parse(file('fixtures/manifest.json'));
  if (createHash('sha256').update(baseline).digest('hex') !== manifest.uncompressed_sha256) throw new Error('Baseline checksum mismatch');
  sql(baseline.toString());
  sql(file('fixtures/status-config.sql'));
  for (const name of [
    '20260921140000_maintenance_queue.sql', '20260921141000_maintenance_business_operations.sql',
    '20260921142000_maintenance_runtime.sql', '20260921143000_maintenance_api.sql',
    '20260921144000_postponement_reschedule.sql',
    '20260921145000_maintenance_heartbeat.sql',
    '20260921224000_restore_manual_eod.sql',
  ]) sql(readFileSync(path.join(root, 'supabase/migrations', name), 'utf8').replace(/^\uFEFF/,''));
  sql("insert into public.same_customer_pay_policy(singleton,active_from) values(true,current_date) on conflict(singleton) do update set active_from=excluded.active_from; grant usage on schema public,auth to authenticated,anon; grant execute on function public.check_payment_client_contract() to authenticated;");
}
if (race) {
  if (sql('select count(*) from public.deliveries') !== '0') throw new Error('Race test requires an empty dedicated database');
  sql(file('fixture.sql').replaceAll("'reda_eod_test'","'reda_eod_race'")+'\nUPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day(); COMMIT;');
  if (manualBench) sql("BEGIN; select set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true); select public.request_manual_eod((public.prepare_manual_eod()->>'preview_id')::uuid); COMMIT; select reda_maintenance.dispatch();");
  else sql("select reda_maintenance.enqueue('release',reda_maintenance.business_day()); select reda_maintenance.dispatch();");
  function concurrent(text) {
    const child=spawn(psql,args,{stdio:['pipe','pipe','pipe']}); let out='',err='';
    let readyResolve; const ready=new Promise(r=>{readyResolve=r;});
    child.stdout.on('data',b=>{out+=b; if(out.includes('LOCK_READY')) readyResolve();});
    child.stderr.on('data',b=>{err+=b;});
    const done=new Promise((resolve,reject)=>child.on('close',code=>code===0?resolve(out):reject(new Error(err))));
    child.stdin.end(text); return {ready,done};
  }
  const agent=concurrent("BEGIN; select set_config('request.jwt.claim.sub',md5('eod-test-agent')::uuid::text,true); select public._same_customer_lock_orders(array[md5('eod-test-order-1')::uuid]); select 'LOCK_READY'; select pg_sleep(2); update deliveries set current_status='available',scheduled_date=public._ensure_workday(reda_maintenance.business_day()+10) where id=md5('eod-test-order-1')::uuid; COMMIT;");
  await agent.ready; sql('select reda_maintenance.work();'); await agent.done;
  if(sql("select count(*) from reda_maintenance.work where error_code='40001'")==='0') throw new Error('Financial contention did not retry');
  sql("update reda_maintenance.work set retry_at=now() where status='pending'; select reda_maintenance.dispatch(); select reda_maintenance.work();");
  if(sql("select current_status from deliveries where id=md5('eod-test-order-1')::uuid")!=='available') throw new Error('Worker overwrote accepted rider action');
  const worker=concurrent("BEGIN; select pg_advisory_xact_lock(hashtextextended('reda-maintenance-worker',0)); select 'LOCK_READY'; select reda_maintenance.work(); select pg_sleep(2); COMMIT;");
  await worker.ready;
  if(!sql('select reda_maintenance.work();').includes('"busy": true')) throw new Error('Overlapping worker entered');
  if (manualBench) sql("BEGIN; select set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true); DO $$ BEGIN BEGIN PERFORM public.run_eod_rollover_all_stuck(); RAISE EXCEPTION 'Legacy overlap accepted'; EXCEPTION WHEN lock_not_available THEN NULL; END; END $$; ROLLBACK;");
  await worker.done;
  if(sql("select count(*) from (select client_uuid from delivery_status_history group by client_uuid having count(*)>1)d")!=='0') throw new Error('Duplicate history after concurrent workers');
  console.log('PASS concurrent rider/worker conflict, preserved accepted change, overlapping worker excluded, unique effects');
  sql("BEGIN; DO $$ BEGIN IF current_database()<>'reda_eod_race' THEN RAISE EXCEPTION 'Wrong race DB'; END IF; END $$; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations CASCADE; COMMIT;");
} else if (!bench) {
  if (sql('select count(*) from public.deliveries') !== '0') throw new Error('Outcome tests require an empty database');
  for (const name of ['test-maintenance.sql','test-reschedule-failures.sql','test-groups-permissions.sql','test-manual-eod.sql','test-manual-eod-failures.sql','test-history-scaling.sql']) {
    for (const day of name==='test-manual-eod.sql' ? ['2026-09-21','2026-09-22','2026-09-26'] : [null]) {
      const clock = day ? ['-c',`SET test.requested_day='${day}'`] : [];
      const result = execFileSync(psql,[...args,...clock,'-f',path.join(dir,name)],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
      console.log(`PASS ${name}${day ? ' '+day : ''} (${result.trim().split('\n').at(-1)})`);
    }
  }
  if (sql('select count(*) from public.deliveries') !== '0') throw new Error('Tests failed to roll back');
} else {
  if (sql('select count(*) from public.deliveries') !== '0') throw new Error('Load test requires an empty dedicated benchmark database');
  const results=[];
  for (const scale of (manualBench ? [1,10] : [1,10,50])) {
    const n=419*scale;
    // Each benchmark uses its own committed transactions, like the cron jobs.
    let fixture=file('fixture.sql').replaceAll("'reda_eod_test'","'reda_eod_bench'");
    sql(fixture+`\nUPDATE reda_maintenance.settings SET enabled=true,activated_at=now(),reconciled_day=reda_maintenance.business_day();\nCOMMIT;`);
    sql(`BEGIN; select set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true); select set_config('reda.in_eod_rollover','true',true);
      INSERT INTO public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,current_status,rollover_count,created_by_user_id)
      SELECT md5('load-order-'||n)::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,'TEST load '||n,
       '090'||lpad(n::text,8,'0'),'TEST load address '||n,1,10000,3000,4000,md5('eod-test-agent')::uuid,
       reda_maintenance.business_day()-CASE WHEN n%4=0 THEN 0 ELSE 2 END,CASE WHEN n%4=0 THEN 'postponed' ELSE 'pending' END,0,'2d8d5895-d2a8-4900-b15e-7662b176a805'
      FROM generate_series(1,${n}) n; COMMIT; ANALYZE public.deliveries;`);
    const start=performance.now();
    if (manualBench) {
      sql("BEGIN; select set_config('request.jwt.claim.sub','2d8d5895-d2a8-4900-b15e-7662b176a805',true); select public.request_manual_eod((public.prepare_manual_eod()->>'preview_id')::uuid); COMMIT;");
      if (Number(sql("select sum(jsonb_array_length(snapshot)) from reda_maintenance.work w join reda_maintenance.runs r on r.id=w.run_id where r.kind='finish_day'")) < n) throw new Error('Manual review truncated full scope');
    } else sql("select reda_maintenance.enqueue('release',reda_maintenance.business_day()); select reda_maintenance.enqueue('close',reda_maintenance.business_day()-2);");
    const enqueueMs=performance.now()-start; let batches=0,maxBatchMs=0,maxDispatchMs=0;
    while (sql("select count(*) from reda_maintenance.work where status in('pending','claimed')") !== '0') {
      if (++batches>1000) throw new Error('Load backlog stalled');
      let t=performance.now(); sql('select reda_maintenance.dispatch();'); maxDispatchMs=Math.max(maxDispatchMs,performance.now()-t);
      t=performance.now(); sql('select reda_maintenance.work();'); maxBatchMs=Math.max(maxBatchMs,performance.now()-t);
    }
    const failed=sql("select count(*) from reda_maintenance.work where status='failed'");
    if (manualBench && sql("select count(*) from deliveries where created_via='rollover' and scheduled_date<>public._ensure_workday(reda_maintenance.business_day()+1)")!=='0') throw new Error('Manual destination changed during batches');
    const duplicates=sql("select count(*) from (select parent_delivery_id from deliveries where created_via='rollover' group by 1 having count(*)>1)d");
    if(failed!=='0'||duplicates!=='0') throw new Error(`Load correctness failure: failed=${failed},duplicates=${duplicates}`);
    results.push({scale,orders:n,batches,enqueueMs:Math.round(enqueueMs),maxDispatchMs:Math.round(maxDispatchMs),maxBatchMs:Math.round(maxBatchMs),totalMs:Math.round(performance.now()-start),failedGroups:Number(failed),duplicateChildren:Number(duplicates)});
    console.log(JSON.stringify(results.at(-1)));
    writeFileSync(path.join(dir,manualBench ? 'manual-load-results.json' : 'load-results.json'),JSON.stringify(results,null,2)+'\n');
    // Explicitly restricted to the dedicated local benchmark DB created by this task.
    sql("BEGIN; DO $$ BEGIN IF current_database()<>'reda_eod_bench' OR inet_server_addr()<>'127.0.0.1'::inet THEN RAISE EXCEPTION 'Wrong benchmark DB'; END IF; END $$; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations CASCADE; TRUNCATE reda_maintenance.outbox,reda_maintenance.alerts,reda_maintenance.previews; COMMIT;");
  }
  if(results.some(r=>r.maxBatchMs>15000)) throw new Error('15-second batch acceptance target missed');
}
