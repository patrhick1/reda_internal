import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const mode = process.argv[2];
assert(['preflight', 'deploy', 'verify'].includes(mode));
const release = 'C:/Users/ebube/.codex/worktrees/to-work-on-release/Reda-dev';
const evidence = 'C:/Users/ebube/Documents/Reda-dev/.codex-to-work-on/deployment';
const backup = '/root/reda-release-backups/to-work-on-20261016';
const base = '/root/supabase/volumes/functions';
const ssh = (command, input) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', 'root@178.104.73.186', command], { input, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
const sql = input => ssh('docker exec -i supabase-db psql -X -qAt -U postgres -d postgres -v ON_ERROR_STOP=1', input);
const normalize = value => value.replace(/\r/g, '').trim().replace(/;$/, '');
const sha = value => createHash('sha256').update(value).digest('hex');
const functions = [
  ['rollover', 'public.rollover_delivery(text,uuid,date,text,boolean)', 'rollover_delivery'],
  ['classify', 'reda_maintenance.classify(date,uuid[])', 'maintenance_classify'],
];
const state = () => JSON.parse(sql(`BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
SELECT json_object_agg(k,json_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'securityDefiner',p.prosecdef))
FROM (VALUES ${functions.map(([key, sig]) => `('${key}','${sig}'::regprocedure)`).join(',')}) f(k,id) JOIN pg_proc p ON p.oid=f.id; ROLLBACK;`));
const migration = readFileSync(release + '/supabase/migrations/20261016190000_rollover_attempt_count.sql', 'utf8');
const oldParserSha = '33b105d812465adbe3bbe858034ed551431e3370c9e0a9bba8d6db06d33e3b79';
const files = ['_shared/bowan-quantity.ts', 'bot-parse-message/index.ts'];
// This checks writes in this migration transaction only, without scanning or
// locking customer records and without confusing concurrent app activity.
const noDataWrites = `DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN('public','reda_maintenance','auth') AND c.relkind IN('r','p')
 AND (pg_stat_get_xact_tuples_inserted(c.oid)+pg_stat_get_xact_tuples_updated(c.oid)+pg_stat_get_xact_tuples_deleted(c.oid))<>0)
 THEN RAISE EXCEPTION 'Migration wrote application records'; END IF;
 IF public._rollover_is_strike('pending') OR public._rollover_is_strike('tomorrow') OR public._rollover_is_strike('no_product')
 OR NOT public._rollover_is_strike('not_answering') OR NOT public._rollover_is_strike('not_connecting')
 THEN RAISE EXCEPTION 'Attempt predicate mismatch'; END IF;
END $verify$;`;
const bounded = migration.replace('BEGIN;', "BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';");
function verifyDefinitions(before) {
  const after = state();
  for (const [key, , name] of functions) {
    for (const field of ['owner', 'acl', 'securityDefiner']) assert.equal(after[key][field], before[key][field], key + ' ' + field);
    const start = name === 'rollover_delivery' ? 'CREATE OR REPLACE FUNCTION public.rollover_delivery' : 'CREATE OR REPLACE FUNCTION reda_maintenance.classify';
    const expected = migration.slice(migration.indexOf(start)).split('$function$;')[0] + '$function$;';
    assert.equal(normalize(after[key].definition), normalize(expected), key + ' deployed definition');
  }
  assert.match(after.rollover.definition, /v_carry_cap constant int := 1;/);
  return after;
}
if (mode === 'preflight') {
  mkdirSync(evidence, { recursive: true });
  const live = state();
  for (const [key, , name] of functions) assert.equal(normalize(live[key].definition), normalize(readFileSync(release + '/tools/live-defs/' + name + '_before_attempt_fix_20261016.sql', 'utf8')), key + ' changed since investigation');
  const parser = ssh('cat ' + base + '/bot-parse-message/index.ts');
  assert.equal(sha(parser), oldParserSha, 'Live parser drift');
  ssh('test ! -e ' + base + '/_shared/bowan-quantity.ts');
  writeFileSync(evidence + '/before.json', JSON.stringify(live, null, 2));
  writeFileSync(evidence + '/parser-before.ts', parser);
  ssh(`umask 077; mkdir '${backup}' && docker exec supabase-db pg_dump -U postgres -d postgres --schema-only > '${backup}/schema-before.sql' && cp -a '${base}/bot-parse-message' '${backup}/' && cp -a '${base}/_shared' '${backup}/' && test -s '${backup}/schema-before.sql'`);
  sql(bounded.replace(/COMMIT;\s*$/i, noDataWrites + '\nROLLBACK;'));
  assert.deepEqual(state(), live, 'Dry run did not roll back');
  console.log('PASS live drift checks, private schema/parser backup, rollback rehearsal, zero application-row writes.');
} else if (mode === 'deploy') {
  const before = JSON.parse(readFileSync(evidence + '/before.json', 'utf8'));
  assert.deepEqual(state(), before, 'Live database drift; stop');
  assert.equal(sha(ssh('cat ' + base + '/bot-parse-message/index.ts')), oldParserSha, 'Live parser drift; stop');
  sql(bounded.replace(/COMMIT;\s*$/i, noDataWrites + "\nNOTIFY pgrst, 'reload schema'; COMMIT;"));
  writeFileSync(evidence + '/after.json', JSON.stringify(verifyDefinitions(before), null, 2));
  for (const file of files) ssh(`umask 077; cat > '${backup}/${file.replaceAll('/', '-')}.new'`, readFileSync(release + '/supabase/functions/' + file));
  let script = `set -eu\nbase='${base}'\nbackup='${backup}'\necho '${oldParserSha}  ${base}/bot-parse-message/index.ts' | sha256sum -c -\n`;
  for (const file of files) script += `echo '${sha(readFileSync(release + '/supabase/functions/' + file))}  ${backup}/${file.replaceAll('/', '-')}.new' | sha256sum -c -\n`;
  script += `rollback() { cp "$backup/bot-parse-message/index.ts" "$base/bot-parse-message/index.ts"; docker restart supabase-edge-functions >/dev/null; }\ntrap 'code=$?; if [ "$code" -ne 0 ]; then rollback; fi' EXIT\n`;
  for (const file of files) script += `cp '${backup}/${file.replaceAll('/', '-')}.new' '${base}/${file}'\n`;
  script += `docker restart supabase-edge-functions >/dev/null\nsleep 4\nip=$(docker inspect supabase-edge-functions --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')\nget=$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' "http://$ip:9000/bot-parse-message")\npost=$(curl --max-time 20 -sS -o /dev/null -w '%{http_code}' -X POST "http://$ip:9000/bot-parse-message")\ntest "$get" = 405\ntest "$post" = 401\necho "PASS parser runtime GET=$get unauthenticated_POST=$post"\n`;
  console.log(ssh('sh -s', script));
  console.log('PASS A/B deployed; two-attempt limit unchanged; migration wrote zero application rows.');
} else {
  const before = JSON.parse(readFileSync(evidence + '/before.json', 'utf8'));
  verifyDefinitions(before);
  for (const file of files) assert.equal(sha(ssh('cat ' + base + '/' + file)), sha(readFileSync(release + '/supabase/functions/' + file)), 'Deployed ' + file);
  const predicate = JSON.parse(sql(`BEGIN READ ONLY; SELECT json_object_agg(s,public._rollover_is_strike(s)) FROM unnest(ARRAY['pending','tomorrow','will_call_back','available','available_evening','no_product','not_answering','not_connecting','number_busy','switched_off']) s; ROLLBACK;`));
  for (const [name, value] of Object.entries(predicate)) assert.equal(value, ['not_answering', 'not_connecting', 'number_busy', 'switched_off'].includes(name));
  console.log('PASS production function definitions, owner/grants, cap, status predicate and parser/helper hashes.');
}
