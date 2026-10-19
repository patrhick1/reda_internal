import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const psql = process.env.EOD_TEST_PSQL || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin/psql.exe' : 'psql');
const sql = input => execFileSync(psql,['-X','-qAt','-h','127.0.0.1','-p','55449','-U','reda_test','-d','reda_eod_test','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',maxBuffer:16e6,stdio:['pipe','pipe','pipe']}).trim();
const read = file => readFileSync(new URL(file,import.meta.url),'utf8');
const local = sql("select inet_server_addr()='127.0.0.1'::inet and inet_server_port()=55449") === 't';
const ci = process.env.GITHUB_ACTIONS === 'true' && sql("select inet_server_addr()<<'172.16.0.0/12'::inet and inet_server_port()=5432") === 't';
assert(local || ci,'Dedicated isolated database required');
assert.equal(sql("select current_database()='reda_eod_test' and current_user='reda_test' and not exists(select 1 from deliveries) and not exists(select 1 from users) and not exists(select 1 from product_catalog)"),'t');
const before = process.argv.includes('--before');
const migration = before ? '' : read('../../supabase/migrations/20261019120000_perfume_product_aliases.sql').replace(/^begin;\s*/im,'').replace(/commit;\s*$/i,'');
try {
  for (const attempt of before ? [0] : [1,2]) {
    sql(read('./database-fixture.sql')+'\n'+migration.repeat(attempt)+'\n'+read('./database-cases.sql'));
    console.log(`PASS real catalog matching and order acceptance; alias migration applications=${attempt}`);
  }
  if(!before) for(const drift of ["is_active=false", "client_id=md5('perfume-other-vendor')::uuid"]){
    const fixture=read('./database-fixture.sql');
    let rejected=false;
    try{sql(fixture+`\nupdate product_catalog set ${drift} where id='67f486ef-d7c5-4934-8f54-4916abda42df';\n`+migration+'\nrollback;');}
    catch(e){rejected=/Perfume product identity\/active state changed/.test(e.stderr?.toString()||'');}
    assert(rejected,'Catalog drift must be rejected: '+drift);
    console.log(`PASS alias migration rejects catalog drift: ${drift}`);
  }
} catch(e) { console.error(e.stderr?.toString()||e.message);process.exitCode=1; }
assert.equal(sql('select count(*) from deliveries'),'0','Acceptance fixtures must roll back');
