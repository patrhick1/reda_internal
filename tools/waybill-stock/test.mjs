import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const local = process.argv.includes("--local");
const db = local ? "reda_urgent_test" : "reda_eod_test";
const port = local ? "55459" : "55449";
const user = local ? "reda_urgent_test" : "reda_test";
const bin =
  process.env.EOD_TEST_PSQL ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/17/bin/psql.exe"
    : "psql");
const args = [
  "-X",
  "-qAt",
  "-h",
  "127.0.0.1",
  "-p",
  port,
  "-U",
  user,
  "-d",
  db,
  "-v",
  "ON_ERROR_STOP=1",
];
function sql(q) {
  try {
    return execFileSync(bin, args, {
      input: q,
      encoding: "utf8",
      maxBuffer: 8e6,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    throw Error(e.stderr?.toString() || e.message);
  }
}
assert.equal(sql("select current_database()"), db);
assert.equal(
  sql("select count(*) from public.deliveries"),
  "0",
  "only an empty isolated database is allowed",
);
if (process.argv.includes("--apply"))
  sql(
    readFileSync(
      new URL(
        "../../supabase/migrations/20261012110000_waybill_stock_adjustment.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const auth =
  "select set_config('request.jwt.claim.sub',md5('waybill-test-admin')::uuid::text,true);";
const holder = "md5('waybill-test-agent')::uuid";
const product = "md5('waybill-test-product')::uuid";
const other = "md5('waybill-test-other')::uuid";
const adj = (key, n, reason = "waybill") =>
  `public.create_stock_adjustment('${key}',${holder},${product},${n},'${reason}','Test shipment')`;
const transfer = (key, from = holder, to = other, n = 3) =>
  `public.create_stock_transfer('${key}',${from},${to},${product},${n},'transfer','Test transfer')`;
const setup = `
insert into auth.users(id,email) values(md5('waybill-test-admin')::uuid,'admin@waybill-test.example.invalid'),(${holder},'agent@waybill-test.example.invalid'),(${other},'other@waybill-test.example.invalid'),(md5('waybill-test-warehouse')::uuid,'warehouse@waybill-test.example.invalid');
insert into public.users(id,email,display_name,role) select id,email,'Synthetic waybill test',case when email like 'admin%' then 'admin' when email like 'warehouse%' then 'warehouse' else 'agent' end from auth.users where email like '%@waybill-test.example.invalid';
insert into public.clients(id,name) values(md5('waybill-test-client')::uuid,'Synthetic waybill client');
insert into public.product_catalog(id,client_id,product_name) values(${product},md5('waybill-test-client')::uuid,'Synthetic waybill product');
${auth}
select ${adj("waybill-test-seed", 10, "bulk_intake")};`;
const ok = `create function pg_temp.ok(v boolean,m text) returns text language plpgsql as $$begin if v is distinct from true then raise exception 'FAIL: %',m;end if;return 'PASS: '||m;end$$;`;
const checks = `begin;set local statement_timeout='20s';${ok}${setup}
create temp table result as select ${adj("waybill-test-once", -5)} id;
select pg_temp.ok((select quantity_on_hand=5 from public.current_stock where agent_id=${holder} and product_catalog_id=${product}),'ten minus five leaves five');
select pg_temp.ok(${adj("waybill-test-once", -5)}=(select id from result),'exact retry returns original row');
select pg_temp.ok((select count(*)=1 from public.stock_adjustments where reason='waybill'),'retry deducts once');
select pg_temp.ok((select reason='waybill' and notes='Test shipment' and created_by_user_id=md5('waybill-test-admin')::uuid from public.stock_adjustments where id=(select id from result)),'history reason, actor and shipment note');
select pg_temp.ok((select count(*)=0 from public.deliveries),'no financial waybill or delivery created');
select pg_temp.ok((select count(*)=1 and min(quantity_delta)=-5 from public.list_stock_movements(md5('waybill-test-agent')::uuid,p_kinds=>array['waybill'])),'holder history filters waybill movements');
select pg_temp.ok((select count(*)=1 and min(qty)=-5 from public.stock_movement_summary(md5('waybill-test-product')::uuid,current_date-1,current_date+1) where reason='waybill'),'database summary includes waybill movement');
select pg_temp.ok((select count(*)=1 from public.audit_log where entity_id=(select id from result) and field_name='reason' and new_value='waybill'),'audited stock action');
do $$begin
begin perform ${adj("waybill-test-once", -4)};raise exception 'changed retry accepted';exception when invalid_parameter_value then null;end;
begin perform ${adj("waybill-test-positive", 1)};raise exception 'positive accepted';exception when check_violation then null;end;
begin perform ${adj("waybill-test-zero", 0)};raise exception 'zero accepted';exception when check_violation then null;end;
begin perform ${adj("waybill-test-too-many", -6)};raise exception 'overdraw accepted';exception when raise_exception then if sqlerrm not like 'insufficient_stock:%' then raise;end if;end;
end$$;
select 'PASS: changed retry, zero, positive and overdraw rejected';
select set_config('request.jwt.claim.sub',${holder}::text,true);
do $$begin begin perform ${adj("waybill-test-agent-denied", -1)};raise exception 'agent accepted';exception when insufficient_privilege then null;end;end$$;
select set_config('request.jwt.claim.sub',md5('waybill-test-warehouse')::uuid::text,true);
do $$begin begin perform ${adj("waybill-test-warehouse-denied", -1)};raise exception 'warehouse accepted';exception when insufficient_privilege then null;end;end$$;
${auth}
select 'PASS: agent and warehouse permissions enforced';
update public.product_catalog set is_active=false where id=${product};
select ${adj("waybill-test-retired", -1)};
select pg_temp.ok((select quantity_on_hand=4 from public.current_stock where agent_id=${holder} and product_catalog_id=${product}),'retired held product can leave stock');
select ${adj("waybill-test-correction", -8, "correction")};
select pg_temp.ok((select quantity_on_hand=-4 from public.current_stock where agent_id=${holder} and product_catalog_id=${product}),'intentional correction policy preserved');
select pg_temp.ok(not has_function_privilege('authenticated','public._lock_stock_product(uuid)','execute'),'internal lock helper not exposed');
rollback;`;
console.log(
  sql(checks)
    .split("\n")
    .filter((s) => s.startsWith("PASS:"))
    .join("\n"),
);

function concurrent(q) {
  const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    errors = "",
    readyResolve,
    readyReject;
  const ready = new Promise((r, j) => {
    readyResolve = r;
    readyReject = j;
  });
  const done = new Promise((resolve, reject) => {
    p.stdout.on("data", (b) => {
      output += b;
      if (output.includes("READY")) readyResolve();
    });
    p.stderr.on("data", (b) => (errors += b));
    p.on("error", (e) => {
      readyReject(e);
      reject(e);
    });
    p.on("close", (code) => {
      readyResolve();
      resolve({ code, output, errors });
    });
  });
  p.stdin.end(q);
  return { ready, done };
}
const balance = () =>
  Number(
    sql(
      `select coalesce(sum(quantity_delta),0) from public.stock_adjustments where agent_id=${holder} and product_catalog_id=${product}`,
    ),
  );
const reset = () =>
  sql(
    `begin;delete from public.stock_adjustments where product_catalog_id=${product};${auth}select ${adj("waybill-test-seed", 10, "bulk_intake")};commit;`,
  );
// Persistent fixtures are restricted to deterministic test UUIDs and removed in finally.
try {
  sql(`begin;${setup}commit;`);
  const race = async (first, second, expected, shouldFail = true) => {
    const a = concurrent(
      `begin;set local statement_timeout='8s';${auth}select ${first};select 'READY';select pg_sleep(0.6);commit;`,
    );
    await a.ready;
    const b = concurrent(
      `begin;set local statement_timeout='8s';${auth}select ${second};commit;`,
    );
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0, ra.errors);
    if (shouldFail) {
      assert.notEqual(rb.code, 0);
      assert.match(rb.errors, /insufficient_stock/);
    } else assert.equal(rb.code, 0, rb.errors);
    assert.equal(balance(), expected);
  };
  await race(adj("waybill-test-race1", -6), adj("waybill-test-race2", -6), 4);
  console.log("PASS: concurrent waybills cannot both spend the same stock");
  reset();
  await race(
    adj("waybill-test-retry", -6),
    adj("waybill-test-retry", -6),
    4,
    false,
  );
  console.log("PASS: concurrent same-request retries deduct once");
  reset();
  await race(
    adj("waybill-test-v-transfer", -8),
    transfer("waybill-test-transfer"),
    2,
  );
  reset();
  await race(
    transfer("waybill-test-transfer-first", holder, other, 8),
    adj("waybill-test-second", -3),
    2,
  );
  console.log("PASS: waybill versus transfer in both commit orders");
  reset();
  sql(
    `begin;${auth}select public.create_stock_adjustment('waybill-test-other-seed',${other},${product},10,'bulk_intake');commit;`,
  );
  await race(
    transfer("waybill-test-forward"),
    transfer("waybill-test-backward", other, holder),
    10,
    false,
  );
  console.log("PASS: opposite transfers complete without holder-lock deadlock");
  reset();
  // Actual delivered movements may reflect stock deficits; preserve that policy.
  // When one has committed first, a waiting waybill must see the lower balance.
  reset();
  // A CTE insert must be top-level, so run this ledger path separately.
  const a = concurrent(
    `begin;${auth}insert into public.stock_adjustments(agent_id,product_catalog_id,quantity_delta,reason,client_uuid,created_by_user_id) values(${holder},${product},-8,'delivered','waybill-test-delivered',md5('waybill-test-admin')::uuid);select 'READY';select pg_sleep(0.6);commit;`,
  );
  await a.ready;
  const b = concurrent(
    `begin;${auth}select ${adj("waybill-test-after-delivery", -3)};commit;`,
  );
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.errors);
  assert.notEqual(rb.code, 0);
  assert.match(rb.errors, /insufficient_stock/);
  assert.equal(balance(), 2);
  console.log(
    "PASS: waybill rechecks after a concurrent delivery-ledger deduction",
  );
} finally {
  sql(
    `begin;delete from public.audit_log where changed_by_user_id=md5('waybill-test-admin')::uuid;delete from public.stock_adjustments where product_catalog_id=${product};delete from public.product_catalog where id=${product};delete from public.clients where id=md5('waybill-test-client')::uuid;delete from public.users where email like '%@waybill-test.example.invalid';delete from auth.users where email like '%@waybill-test.example.invalid';commit;`,
  );
}
assert.equal(sql("select count(*) from public.deliveries"), "0");
console.log("PASS: isolated fixtures cleaned");
