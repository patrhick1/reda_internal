import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const psql = process.env.EOD_TEST_PSQL || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql');
const sql = input => execFileSync(psql,['-X','-qAt','-h','127.0.0.1','-p','55449','-U','reda_test','-d','reda_eod_test','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16e6,stdio:['pipe','pipe','pipe']}).trim();
const local = sql("select inet_server_addr()='127.0.0.1'::inet and inet_server_port()=55449") === 't';
const ci = process.env.GITHUB_ACTIONS === 'true' && sql("select inet_server_addr()<<'172.16.0.0/12'::inet and inet_server_port()=5432") === 't';
assert(local || ci, 'Only the dedicated isolated database is allowed');
assert.equal(sql("select current_database()='reda_eod_test' and current_user='reda_test' and not exists(select 1 from deliveries) and not exists(select 1 from users)"),'t');
function expand(file) { return readFileSync(file,'utf8').replace(/^\\ir (.+)$/gm,(_,r)=>expand(path.resolve(path.dirname(file),r.trim()))); }
const read = file => readFileSync(path.join(root,file),'utf8');
let fixture = expand(path.join(root,'tools/same-customer-pay-test-fixtures.sql'))
  .replace("current_database()<>'reda_same_customer_test' or inet_server_port()<>55439 or inet_server_addr()<>'127.0.0.1'::inet", "current_database()<>'reda_eod_test' or current_user<>'reda_test'")
  .replace("('rolled_over','terminal','Rolled over');", "('rolled_over','terminal','Rolled over') on conflict(status) do nothing;")
  .replace("values('pending','delivered');", "values('pending','delivered') on conflict do nothing;");
const migration = read('supabase/migrations/20261016200000_disable_delivered_notifications.sql').replace(/^begin;\s*/im,'').replace(/commit;\s*$/i,'');
const before = read('tools/live-defs/tg_notify_delivery_status_change_before_20261016.sql');
try {
  // Installing the captured definition avoids dependence on an older fixture's trigger.
  // --before deliberately exercises today's regression assertions against the old behavior.
  for (const attempt of [1,2]) {
    const changes = process.argv.includes('--before') ? before : before + '\n' + migration.repeat(attempt);
    sql(fixture + '\n' + changes + '\n' + read('tools/notification-policy-20261016/database-cases.sql'));
    console.log(`PASS database acceptance and trigger regression; migration applications=${attempt}`);
  }
} catch (e) { console.error(e.stderr?.toString() || e.message); process.exitCode=1; }
assert.equal(sql('select count(*) from deliveries'),'0','Tests must roll back');
