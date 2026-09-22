import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const psql = process.env.EOD_TEST_PSQL || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql');
const args = ['-X','-h','127.0.0.1','-p','55449','-U','reda_test','-d','reda_eod_test','-v','ON_ERROR_STOP=1','-At'];
function sql(input) { return execFileSync(psql,args,{input,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']}).trim(); }
if (sql("select current_database()='reda_eod_test' and current_user='reda_test' and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users)") !== 't') throw new Error('Expected empty isolated test database');
function expand(file) {
  return readFileSync(file,'utf8').replace(/^\\ir (.+)$/gm,(_,relative)=>expand(path.resolve(path.dirname(file),relative.trim())));
}
let fixture=expand(path.join(root,'tools/same-customer-pay-test-fixtures.sql'));
// Same synthetic fixture, on the existing maintenance CI service. The TCP
// client remains pinned to localhost:55449; Docker sees its internal port.
fixture=fixture.replace("current_database()<>'reda_same_customer_test' or inet_server_port()<>55439 or inet_server_addr()<>'127.0.0.1'::inet", "current_database()<>'reda_eod_test' or current_user<>'reda_test'")
  .replace("('rolled_over','terminal','Rolled over');", "('rolled_over','terminal','Rolled over') on conflict(status) do nothing;")
  .replace("values('pending','delivered');", "values('pending','delivered') on conflict do nothing;");
try {
  sql(fixture+'\n'+readFileSync(path.join(root,'tools/manual-fee-waivers/test-waivers.sql'),'utf8'));
  console.log('PASS manual fee waiver integration: pre/post-completion, either order, zero/nonzero, automatic rates, stale previews, retries, third delivery, reversal, cash totals, individual/bulk handovers, settled and role guards, independent date review.');
} catch(e) { console.error(e.stderr?.toString() || e.message); process.exitCode=1; }
if(sql('select count(*) from public.deliveries')!=='0') throw new Error('Fixture rollback failed');
