import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const psql = process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql';
const database = 'reda_blacklist_notice_test';
const base = ['-X','-h','127.0.0.1','-p','55461','-U','reda_call_test','-v','ON_ERROR_STOP=1','-At'];
const sql = (input, db=database) => execFileSync(psql,[...base,'-d',db],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const file = (name) => readFileSync(new URL(name,import.meta.url),'utf8');
assert.equal(sql("select current_user||'|'||host(inet_server_addr())||'|'||inet_server_port()",'postgres'),'reda_call_test|127.0.0.1|55461');
if(process.argv.includes('--setup')) {
  sql(`create database ${database}`,'postgres');
  sql(file('./bootstrap.sql'));
  sql(file('../../supabase/migrations/20260928140000_blacklist_notices.sql'));
}
assert.equal(sql('select current_database()'),database);
assert.equal(sql('select count(*) from public.blacklist_order_notices'),'0','test database must have no notices');
sql(file('./cases.sql'));
console.log('PASS durable notices, deduplication, cooldown, independent acknowledgment, permissions, transport failure');
function parallel(input) {
  const child=spawn(psql,[...base,'-d',database],{stdio:['pipe','pipe','pipe']});
  let error='';
  child.stderr.on('data',x=>error+=x);
  child.stdout.resume();
  const done=new Promise((ok,fail)=>{ child.on('error',fail); child.on('close',code=>code===0?ok():fail(new Error(error))); });
  child.stdin.end(input); return done;
}
await Promise.all(['parallel-one','parallel-two'].map(name=>parallel(`begin;insert into public.bot_inbound_messages values(md5('${name}')::uuid,'blocked','{}');select pg_sleep(0.5);commit;`)));
assert.equal(sql('select count(*) from public.blacklist_order_notices'),'2');
assert.equal(sql('select count(*) from public.test_pushes'),'1');
sql("delete from public.bot_inbound_messages where id in (md5('parallel-one')::uuid,md5('parallel-two')::uuid);truncate public.test_pushes;update public.blacklist_notice_push_state set last_sent_at=null;");
console.log('PASS concurrent refusals retain both notices but schedule one push');
