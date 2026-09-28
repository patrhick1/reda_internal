// Actual HTTP requests, committed batches, real business functions. No RPC
// response is mocked. Always pinned to the isolated synthetic database/API.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const psql =
  process.env.EOD_TEST_PSQL ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/17/bin/psql.exe"
    : "psql");
const args = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  "55449",
  "-U",
  "reda_test",
  "-d",
  "reda_eod_test",
  "-At",
  "-v",
  "ON_ERROR_STOP=1",
];
const sql = (text) =>
  execFileSync(psql, args, {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
assert.equal(
  sql(
    "select current_database()='reda_eod_test' and current_user='reda_test' and (inet_server_addr()='127.0.0.1'::inet or (inet_server_addr()<<'172.16.0.0/12'::inet and inet_server_port()=5432))",
  ),
  "t",
);
assert.equal(
  sql("select count(*) from public.deliveries"),
  "0",
  "Only an empty isolated fixture is allowed",
);
assert.equal(
  sql("select count(*) from public.users"),
  "0",
  "No existing users may be cleared",
);
const admin = "2d8d5895-d2a8-4900-b15e-7662b176a805";
const agent = sql("select md5('eod-test-agent')::uuid");
const other = sql("select md5('eod-immediate-other')::uuid");
const secret = "isolated-reda-eod-test-secret-at-least-32-characters";
export function jwt(sub = admin) {
  const body = [
    { alg: "HS256", typ: "JWT" },
    { role: "authenticated", sub, exp: Math.floor(Date.now() / 1000) + 3600 },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
async function rpc(name, body = {}, sub = admin) {
  const res = await fetch("http://127.0.0.1:55451/rpc/" + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-reda-payment-contract": "1",
      ...(sub ? { Authorization: "Bearer " + jwt(sub) } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(`${name}: ${JSON.stringify(data)}`), {
      code: data.code,
      status: res.status,
    });
  return data;
}
function cleanup() {
  sql(
    "BEGIN; DO $$ BEGIN IF current_database()<>'reda_eod_test' OR current_user<>'reda_test' THEN RAISE EXCEPTION 'Wrong test database'; END IF; END $$; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations CASCADE; TRUNCATE reda_maintenance.previews,reda_maintenance.outbox,reda_maintenance.alerts; COMMIT;",
  );
}
function insertOrders(n, start = 1, history = false) {
  if (!n) return;
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${admin}',true); SELECT set_config('reda.in_eod_rollover','true',true);
   INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,current_status,rollover_count,created_by_user_id)
   SELECT md5('immediate-order-'||n)::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,'TEST immediate '||n,'090'||lpad(n::text,8,'0'),'TEST address '||n,1,10000,3000,4000,md5('eod-test-agent')::uuid,
    reda_maintenance.business_day()-CASE WHEN extract(isodow FROM reda_maintenance.business_day())=7 THEN 1 ELSE 0 END-${history ? 100 : 0},'${history ? "cancelled" : "pending"}',0,'${admin}' FROM generate_series(${start},${start + n - 1})n; COMMIT;`);
}
function reset(n, history = 0) {
  cleanup();
  sql(
    readFileSync(path.join(dir, "fixture.sql"), "utf8").replace(/^\uFEFF/, "") +
      `\nTRUNCATE public.deliveries CASCADE;
   INSERT INTO auth.users(id,email) VALUES('${other}','other@eod.example.invalid');
   INSERT INTO public.users(id,email,display_name,role) VALUES('${other}','other@eod.example.invalid','TEST other admin','admin');
   UPDATE reda_maintenance.settings SET enabled=true,batch_size=100,budget_seconds=12,reconciled_day=reda_maintenance.business_day(); COMMIT;`,
  );
  insertOrders(n);
  insertOrders(history, 100000, true);
  sql("ANALYZE public.deliveries;");
}
async function prepare(sub = admin) {
  // The app passes its Lagos date explicitly. Use the fixture's clock so
  // simulated midnight tests do not accidentally pass the real machine date.
  return rpc(
    "prepare_manual_eod",
    { p_for_date: sql("select reda_maintenance.business_day()") },
    sub,
  );
}
async function submit(p, sub = admin) {
  return rpc("request_manual_eod", { p_preview_id: p.preview_id }, sub);
}
async function advance(p, sub = admin) {
  return rpc("advance_manual_eod", { p_preview_id: p.preview_id }, sub);
}
async function drain(p, sub = admin) {
  const started = performance.now();
  let batches = 0,
    maxBatchMs = 0,
    last;
  do {
    const t = performance.now();
    last = await advance(p, sub);
    maxBatchMs = Math.max(maxBatchMs, performance.now() - t);
    batches++;
    assert(last.processed_groups <= 100, "Batch bound");
    if (!last.complete)
      assert.equal(
        last.retry_after_ms,
        0,
        "Ready work continues without scheduled waiting",
      );
    assert(batches < 100, "No stalled progress");
  } while (!last.complete);
  assert.equal(last.needs_attention, false);
  return {
    batches,
    maxBatchMs: Math.round(maxBatchMs),
    elapsedMs: Math.round(performance.now() - started),
    last,
  };
}
function checkEffects(n, targetDate) {
  if (targetDate) assert.match(targetDate, /^\d{4}-\d{2}-\d{2}$/);
  const target = targetDate
    ? `date '${targetDate}'`
    : "public._ensure_workday(reda_maintenance.business_day()+1)";
  assert.equal(
    sql("select count(*) from deliveries where created_via='rollover'"),
    String(n),
  );
  assert.equal(
    sql(
      `select count(*) from deliveries where created_via='rollover' and (scheduled_date<>${target} or assigned_agent_id is not null)`,
    ),
    "0",
  );
  assert.equal(
    sql(
      "select count(*) from (select parent_delivery_id from deliveries where created_via='rollover' group by 1 having count(*)>1)x",
    ),
    "0",
  );
  assert.equal(
    sql(
      "select count(*) from (select client_uuid from delivery_status_history where client_uuid is not null group by 1 having count(*)>1)x",
    ),
    "0",
  );
  assert.equal(sql("select count(*) from stock_adjustments"), "0");
  assert.equal(
    sql(
      "select count(*) from reda_maintenance.outbox where payload->>'title' like 'Order processing%'",
    ),
    "0",
  );
}
function concurrent(text) {
  const child = spawn(psql, args, { stdio: ["pipe", "pipe", "pipe"] });
  let out = "",
    err = "",
    readyResolve;
  const ready = new Promise((r) => {
    readyResolve = r;
  });
  child.stdout.on("data", (b) => {
    out += b;
    if (out.includes("LOCK_READY")) readyResolve();
  });
  child.stderr.on("data", (b) => {
    err += b;
  });
  const done = new Promise((resolve, reject) =>
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err)),
    ),
  );
  child.stdin.end(text);
  return { ready, done };
}
const results = [];
try {
  if (process.argv.includes("--browser-only")) {
    const { runImmediateBrowser } =
      await import("./test-immediate-browser.mjs");
    await runImmediateBrowser({ reset, checkEffects, sql, jwt, admin });
  } else {
    // No cron is run during this matrix: manual latency cannot depend on its
    // minute boundary or 25-second delay. Every batch is its own HTTP transaction.
    for (const n of [0, 1, 99, 100, 101, 153]) {
      reset(n);
      const t = performance.now();
      const p = await prepare();
      await submit(p);
      const result = await drain(p);
      result.totalMs = Math.round(performance.now() - t);
      delete result.last;
      assert(
        result.totalMs < 10000,
        `Recent-sized operation missed 10s target: ${result.totalMs}ms`,
      );
      checkEffects(n);
      const before = sql("select count(*) from delivery_status_history");
      await submit(p);
      await advance(p);
      assert.equal(
        sql("select count(*) from delivery_status_history"),
        before,
        "Lost response/repeated submission cannot repeat effects",
      );
      results.push({ groups: n, ...result });
      console.log("PASS real HTTP latency", JSON.stringify(results.at(-1)));
    }

    reset(1);
    const slowPreview = await prepare();
    await submit(slowPreview);
    // One complete group may exceed the soft budget. Preserve the scheduled
    // worker's 20s deadline instead of adding a new 10s failure/retry threshold.
    sql(
      "CREATE FUNCTION public.test_immediate_slow_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.created_via='rollover' THEN PERFORM pg_sleep(11); END IF; RETURN NEW; END $$; CREATE TRIGGER test_immediate_slow_group BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.test_immediate_slow_group();",
    );
    try {
      const slowResult = await advance(slowPreview);
      assert.equal(slowResult.complete, true);
      assert.equal(slowResult.needs_attention, false);
      checkEffects(1);
      assert.equal(sql("select attempts from reda_maintenance.work"), "1");
    } finally {
      sql(
        "DROP TRIGGER test_immediate_slow_group ON public.deliveries; DROP FUNCTION public.test_immediate_slow_group();",
      );
    }
    console.log(
      "PASS complete slow group retains existing 20s deadline without a new retry threshold",
    );

    reset(1);
    let p = await prepare();
    await assert.rejects(advance(p), (e) => e.code === "22023");
    await submit(p);
    for (const sub of [agent, other, null])
      await assert.rejects(advance(p, sub), (e) =>
        ["42501", "22023"].includes(e.code),
      );
    const get = await fetch(
      `http://127.0.0.1:55451/rpc/advance_manual_eod?p_preview_id=${p.preview_id}`,
      {
        headers: {
          Authorization: "Bearer " + jwt(),
          "x-reda-payment-contract": "1",
        },
      },
    );
    assert(!get.ok, "GET cannot mutate");
    assert.equal(
      sql("select count(*) from deliveries where created_via='rollover'"),
      "0",
    );
    insertOrders(1, 2);
    await drain(p);
    checkEffects(1);
    assert.equal(
      sql(
        "select current_status from deliveries where id=md5('immediate-order-2')::uuid",
      ),
      "pending",
      "Unapproved new work stays untouched",
    );
    console.log(
      "PASS approved-preview scope, unsubmitted/agent/other-user/anonymous/GET denial and real HTTP SERIALIZABLE enforcement",
    );

    reset(1);
    p = await prepare();
    await submit(p);
    sql(
      "update reda_maintenance.work set attempts=1,retry_at=now()+interval '5 minutes' where status='pending'",
    );
    let step = await advance(p);
    assert.equal(step.processed_groups, 0);
    assert.equal(step.retry_after_ms, 30000);
    assert.equal(step.complete, false);
    assert.equal(
      sql("select attempts from reda_maintenance.work"),
      "1",
      "Backoff does not consume attempts",
    );
    sql(
      "update reda_maintenance.work set retry_at=now() where status='pending'",
    );
    await drain(p);
    checkEffects(1);
    console.log("PASS real retry delay remains bounded and respected");

    reset(1);
    p = await prepare();
    await submit(p);
    sql("update reda_maintenance.settings set enabled=false");
    step = await advance(p);
    assert.equal(step.processed_groups, 0);
    assert.equal(step.retry_after_ms, 30000);
    checkEffects(0);
    sql("update reda_maintenance.settings set enabled=true");
    await drain(p);
    checkEffects(1);
    console.log("PASS operational pause respected without consuming work");

    reset(1);
    p = await prepare();
    await submit(p);
    sql(
      "update deliveries set current_status='available' where id=md5('immediate-order-1')::uuid",
    );
    step = await advance(p);
    assert.equal(step.complete, true);
    assert.equal(step.needs_attention, true);
    assert.equal(
      sql(
        "select current_status from deliveries where id=md5('immediate-order-1')::uuid",
      ),
      "available",
    );
    checkEffects(0);
    console.log("PASS changed order preserved, no false success");

    reset(1);
    p = await prepare();
    await submit(p);
    const rider = concurrent(
      `BEGIN; SELECT set_config('request.jwt.claim.sub','${agent}',true); SELECT public._same_customer_lock_orders(array[md5('immediate-order-1')::uuid]); SELECT 'LOCK_READY'; SELECT pg_sleep(1); UPDATE deliveries SET current_status='available' WHERE id=md5('immediate-order-1')::uuid; COMMIT;`,
    );
    await rider.ready;
    try {
      await advance(p);
    } catch (e) {
      assert.equal(e.code, "40001");
    }
    await rider.done;
    sql(
      "update reda_maintenance.work set retry_at=now() where status='pending'",
    );
    step = await advance(p);
    assert.equal(step.complete, true);
    assert.equal(step.needs_attention, true);
    assert.equal(
      sql(
        "select current_status from deliveries where id=md5('immediate-order-1')::uuid",
      ),
      "available",
    );
    checkEffects(0);
    console.log(
      "PASS concurrent rider action preserved through real HTTP execution",
    );

    reset(20);
    p = await prepare();
    await submit(p);
    sql(
      "CREATE FUNCTION public.test_immediate_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.created_via='rollover' THEN PERFORM pg_sleep(0.35); END IF; RETURN NEW; END $$; CREATE TRIGGER test_immediate_delay BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.test_immediate_delay();",
    );
    try {
      const t = performance.now();
      step = await advance(p);
      assert(
        step.processed_groups > 0 && step.processed_groups < 20,
        "Time budget stops before claiming all work",
      );
      assert(
        performance.now() - t < 6500,
        "Soft four-second budget bounds normal invocation",
      );
      assert.equal(step.retry_after_ms, 0);
      assert.equal(
        sql(
          "select count(*) from reda_maintenance.work where status='pending' and attempts<>0",
        ),
        "0",
        "Unstarted groups do not consume attempts",
      );
    } finally {
      sql(
        "DROP TRIGGER test_immediate_delay ON public.deliveries; DROP FUNCTION public.test_immediate_delay();",
      );
    }
    await drain(p);
    checkEffects(20);
    console.log(
      "PASS time-bounded batches leave unstarted work ready for immediate continuation",
    );

    reset(2);
    p = await prepare();
    await submit(p);
    sql(
      "CREATE FUNCTION public.test_immediate_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.created_via='rollover' AND NEW.customer_name='TEST immediate 2' THEN RAISE EXCEPTION 'TEST injected error' USING ERRCODE='P0002'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_immediate_failure BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.test_immediate_failure();",
    );
    try {
      step = await advance(p);
      assert.equal(step.complete, true);
      assert.equal(step.needs_attention, true);
      checkEffects(1);
      assert.equal(
        sql(
          "select count(*) from reda_maintenance.work where status='failed' and error_code='P0002'",
        ),
        "1",
      );
      assert.equal(
        sql(
          "select current_status from deliveries where id=md5('immediate-order-2')::uuid",
        ),
        "pending",
        "Failed group rolls back its earlier effects",
      );
      assert.equal(
        (await advance(p)).processed_groups,
        0,
        "No automatic reapproval of failed work",
      );
    } finally {
      sql(
        "DROP TRIGGER test_immediate_failure ON public.deliveries; DROP FUNCTION public.test_immediate_failure();",
      );
    }
    p = await prepare();
    await submit(p);
    await drain(p);
    checkEffects(2);
    console.log(
      "PASS group failure is atomic, visible and retried only after fresh approval",
    );

    reset(153);
    p = await prepare();
    await submit(p);
    sql("select reda_maintenance.dispatch();");
    const worker = concurrent(
      "BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT pg_advisory_xact_lock(hashtextextended('reda-maintenance-worker',0)); SELECT 'LOCK_READY'; SELECT pg_sleep(2); SELECT reda_maintenance.work(); COMMIT;",
    );
    await worker.ready;
    const blockedAt = performance.now();
    step = await advance(p);
    assert.equal(step.processed_groups, 0);
    assert.equal(step.retry_after_ms, 1000);
    assert(
      performance.now() - blockedAt < 1500,
      "Busy worker must return promptly",
    );
    await worker.done;
    await drain(p);
    checkEffects(153);
    console.log(
      "PASS scheduled/manual worker exclusion, continuation and unique effects",
    );

    reset(101);
    p = await prepare();
    const p2 = await prepare(other);
    await submit(p);
    await submit(p2, other);
    const overlapping = await Promise.allSettled([
      advance(p),
      advance(p2, other),
    ]);
    for (const result of overlapping)
      if (result.status === "rejected")
        assert.equal(result.reason.code, "40001");
    await drain(p);
    await drain(p2, other);
    checkEffects(101);
    console.log(
      "PASS simultaneous approved operations by two admins apply each effect once",
    );

    reset(101);
    p = await prepare();
    await submit(p);
    for (let i = 0; i < 2; i++)
      sql(
        "select reda_maintenance.dispatch(); BEGIN ISOLATION LEVEL SERIALIZABLE; select reda_maintenance.work(); COMMIT;",
      );
    step = await rpc("manual_eod_status", { p_preview_id: p.preview_id });
    assert.equal(step.complete, true);
    checkEffects(101);
    console.log(
      "PASS scheduled fallback completes committed approval without any foreground advance",
    );

    const originalClock = sql(
      "select pg_get_functiondef('reda_maintenance.business_day(timestamptz)'::regprocedure)",
    );
    try {
      for (const day of ["2026-09-21", "2026-09-26"]) {
        const setDay = (expression) =>
          sql(
            `CREATE OR REPLACE FUNCTION reda_maintenance.business_day(p_at timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$ SELECT ${expression} $$;`,
          );
        setDay(`date '${day}'`);
        reset(2);
        sql("update reda_maintenance.settings set batch_size=1");
        p = await prepare();
        await submit(p);
        assert.equal((await advance(p)).complete, false);
        setDay(`date '${day}'+1`);
        await drain(p);
        checkEffects(2, p.target_date);
        setDay(`date '${day}'`);
        reset(2);
        sql("update reda_maintenance.settings set batch_size=1");
        p = await prepare();
        await submit(p);
        await advance(p);
        setDay(`date '${p.target_date}'+1`);
        step = await advance(p);
        assert.equal(step.complete, true);
        assert.equal(step.needs_attention, true);
        checkEffects(1, p.target_date);
      }
    } finally {
      sql(originalClock);
    }
    console.log(
      "PASS midnight/Sunday continuation keeps approved destination; expired destination produces no further rollover",
    );

    reset(1530, 20000);
    const t = performance.now();
    p = await prepare();
    await submit(p);
    const large = await drain(p);
    large.totalMs = Math.round(performance.now() - t);
    delete large.last;
    assert(large.maxBatchMs < 6500, "Bounded batch budget");
    checkEffects(1530);
    results.push({ groups: 1530, historicalOrders: 20000, ...large });
    console.log("PASS real HTTP scale", JSON.stringify(results.at(-1)));
    if (process.env.EOD_IMMEDIATE_RESULTS)
      writeFileSync(
        process.env.EOD_IMMEDIATE_RESULTS,
        JSON.stringify(results, null, 2) + "\n",
      );
  }
} finally {
  cleanup();
}
