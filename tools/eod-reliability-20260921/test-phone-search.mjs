// Isolated database + real PostgREST; no production requests or order data.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  deliverySearchFilter,
  matchesDeliverySearch,
  phoneSearchKey,
} from "../../mobile/src/lib/delivery-search.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const psql =
  process.env.EOD_TEST_PSQL ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/17/bin/psql.exe"
    : "psql");
const sql = (text) =>
  execFileSync(
    psql,
    [
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
    ],
    {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    },
  ).trim();
// Large fixture creation must not block Node's socket-close/keepalive handling.
const sqlAsync = (text) =>
  new Promise((resolve, reject) => {
    const child = spawn(psql, [
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
    ]);
    let error = "";
    child.stdout.resume();
    child.stderr.on("data", (b) => {
      error += b;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(error)),
    );
    child.stdin.end(text);
  });
assert.equal(
  sql(
    "select current_database()='reda_eod_test' and current_user='reda_test' and (inet_server_addr()='127.0.0.1'::inet or (inet_server_addr()<<'172.16.0.0/12'::inet and inet_server_port()=5432))",
  ),
  "t",
);
assert.equal(sql("select count(*) from deliveries"), "0");
assert.equal(sql("select count(*) from public.users"), "0");
const admin = "2d8d5895-d2a8-4900-b15e-7662b176a805";
const agent = sql("select md5('eod-test-agent')::uuid");
const dispatcher = sql("select md5('phone-dispatcher')::uuid");
const quote = (v) => "'" + v.replaceAll("'", "''") + "'";
const formats = [
  "08033165485",
  "+234 803 316 5485",
  "2348033165485",
  "8033165485",
  "0803-316-5485",
  "(0803) 316 5485",
  "00234 8033165485",
  "+234 (0) 8033165485",
];
function jwt(sub = admin) {
  const body = [
    { alg: "HS256", typ: "JWT" },
    { role: "authenticated", sub, exp: Math.floor(Date.now() / 1000) + 3600 },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    body +
    "." +
    createHmac("sha256", "isolated-reda-eod-test-secret-at-least-32-characters")
      .update(body)
      .digest("base64url")
  );
}
async function request(endpoint, sub = admin, body) {
  const res = await fetch("http://127.0.0.1:55451/" + endpoint, {
    headers: {
      Authorization: "Bearer " + jwt(sub),
      "x-reda-payment-contract": "1",
      "Content-Type": "application/json",
      Connection: "close",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  assert(res.ok, JSON.stringify(data));
  return data;
}
const service = readFileSync(
  path.join(dir, "../../mobile/src/services/deliveries.ts"),
  "utf8",
);
// Supabase's select() removes whitespace before serializing the projection.
const projection = (
  service.match(/const LIST_COLUMNS = `([\s\S]*?)`/)[1] +
  "," +
  service.match(/const LIST_JOIN_FRAGMENT = `([\s\S]*?)`/)[1]
).replace(/\s/g, "");
async function search(
  query,
  sub = admin,
  view = sub === admin ? "deliveries_admin" : "deliveries_safe",
) {
  return request(
    view +
      "?" +
      new URLSearchParams({
        select: projection,
        or: "(" + deliverySearchFilter(query) + ")",
        order: "created_at.desc",
        limit: "100",
      }),
    sub,
  );
}
function insert(n, phone, alt = "NULL", extra = "") {
  return `INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,customer_phone_alt,raw_address,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,current_status,created_by_user_id)
 VALUES(md5('phone-'||${n})::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,'Phone Test ${n}',${quote(phone)},${alt},'TEST phone address ${n}',1,10000,3000,4000,${n === 10 ? "NULL" : quote(agent) + "::uuid"},public._ensure_workday(reda_maintenance.business_day()),'pending','${admin}'); ${extra}`;
}
try {
  sql(
    readFileSync(path.join(dir, "fixture.sql"), "utf8").replace(/^\uFEFF/, "") +
      `
 TRUNCATE deliveries CASCADE;
 -- The sanitized schema fixture omits deployment ACLs. Restore only the read
 -- grants used by these requests; the installed view predicates/RLS stay active.
 GRANT SELECT ON deliveries_admin,deliveries_safe,clients,locations,public.users TO authenticated;
 INSERT INTO auth.users(id,email) VALUES('${dispatcher}','phone-dispatcher@example.invalid');
 INSERT INTO public.users(id,email,display_name,role) VALUES('${dispatcher}','phone-dispatcher@example.invalid','TEST dispatcher','dispatcher');
 INSERT INTO feature_flags(key,enabled) VALUES('same_customer_discovery',true) ON CONFLICT(key) DO UPDATE SET enabled=true;
 ${formats.map((v, i) => insert(i + 1, v)).join("\n")}
 ${insert(9, "09099999999", quote("+234 803 316 5485"))}
 ${insert(10, "08033165485")}
 ${insert(11, "08033165485", "NULL", "UPDATE deliveries SET deleted_at=now() WHERE id=md5('phone-11')::uuid;")}
 COMMIT;`,
  );
  const before = sql(
    "select md5(string_agg(to_jsonb(d)::text,'' order by id)) from deliveries d",
  );
  for (const query of formats) {
    assert.equal(
      sql(`select public._delivery_phone_search_key(${quote(query)})`),
      phoneSearchKey(query),
    );
    for (const [sub, expected] of [
      [admin, 10],
      [dispatcher, 10],
      [agent, 9],
    ]) {
      const rows = await search(query, sub);
      assert.equal(rows.length, expected, query);
      assert(
        rows.every((r) => matchesDeliverySearch(r, query)),
        "Local filter must keep server matches",
      );
      assert(
        rows.every((r) => "client" in r && "assigned_agent" in r),
        "View relationship embedding preserved",
      );
      if (sub === admin)
        assert(rows.every((r) => r.client?.name === "EOD TEST"));
    }
  }
  assert.deepEqual(await search(formats[0], agent, "deliveries_admin"), []);
  assert.equal((await search("08033165486")).length, 0);
  assert.equal((await search("65485")).length, 10);
  assert.equal((await search("phone test 9")).length, 1);
  assert.equal(
    before,
    sql(
      "select md5(string_agg(to_jsonb(d)::text,'' order by id)) from deliveries d",
    ),
    "Searching does not mutate orders",
  );
  const day = sql(
    "select public._ensure_workday(reda_maintenance.business_day())",
  );
  const groupBaseline = await request("rpc/list_same_customer_orders", admin, {
    p_day: day,
    p_search: formats[0],
  });
  assert(groupBaseline.groups.length > 0);
  for (const query of formats)
    assert.deepEqual(
      await request("rpc/list_same_customer_orders", admin, {
        p_day: day,
        p_search: query,
      }),
      groupBaseline,
    );
  console.log(
    "PASS primary/alternate format matrix, real view embeds, admin/dispatcher/agent permissions, deleted rows, names, fragments, no mutations and same-customer search",
  );
  sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${admin}',true); SELECT set_config('reda.in_eod_rollover','true',true);
 UPDATE deliveries SET current_status='failed_delivery' WHERE id=md5('phone-9')::uuid;
 INSERT INTO delivery_status_history(delivery_id,from_status,to_status,changed_by_user_id,reason,changed_at,client_uuid)
 VALUES(md5('phone-9')::uuid,'pending','available','${admin}','TEST',now()-interval '1 minute',gen_random_uuid()),(md5('phone-9')::uuid,'available','failed_delivery','${admin}','TEST',now(),gen_random_uuid()); COMMIT;`);
  const today = sql("select reda_maintenance.business_day()");
  for (const query of formats)
    assert.equal(
      (
        await request("rpc/list_failed_delivery_outcomes", admin, {
          p_from: today,
          p_to: today,
          p_search: query,
        })
      ).length,
      1,
    );
  console.log(
    "PASS failed-outcome search matches alternate numbers across formats",
  );
  if (process.argv.includes("--browser")) {
    const { runPhoneSearchBrowser } =
      await import("./test-phone-search-browser.mjs");
    await runPhoneSearchBrowser({ jwt, admin, formats });
  }
  await sqlAsync(`BEGIN; SELECT set_config('request.jwt.claim.sub','${admin}',true); SELECT set_config('reda.in_eod_rollover','true',true);
 UPDATE deliveries SET customer_phone='07012345678' WHERE id=md5('phone-1')::uuid;
 INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,current_status,created_by_user_id)
 SELECT md5('phone-load-'||n)::uuid,md5('eod-test-client')::uuid,md5('eod-test-product')::uuid,'TEST history '||n,'090'||lpad(n::text,8,'0'),'TEST history address '||n,1,10000,3000,4000,'${agent}',public._ensure_workday(reda_maintenance.business_day()-100),'cancelled','${admin}' FROM generate_series(1,20000)n;
 COMMIT; ANALYZE deliveries;`);
  assert.equal(
    (await search("+234 701 234 5678")).length,
    1,
    "Edited phone searchable immediately",
  );
  assert.equal(
    (await search(formats[0])).length,
    9,
    "Old key removed on phone edit",
  );
  assert.equal((await search("history")).length, 100, "Bounded results");
  const terms = [
    "customer_name ILIKE '%08033165485%' OR customer_phone_search ILIKE '%8033165485%' OR customer_phone_alt_search ILIKE '%8033165485%' OR customer_phone_search ILIKE '%08033165485%' OR customer_phone_alt_search ILIKE '%08033165485%'",
    "customer_name ILIKE '%65485%' OR customer_phone_search ILIKE '%65485%' OR customer_phone_alt_search ILIKE '%65485%'",
  ];
  for (const term of terms) {
    const plan = sql(
      `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${admin}',true); EXPLAIN (ANALYZE,BUFFERS) SELECT id,customer_name,customer_phone,product_label,activity_at FROM deliveries_admin WHERE ${term} ORDER BY created_at DESC LIMIT 100; ROLLBACK;`,
    );
    assert.match(
      plan,
      /deliveries_phone_search_trgm/,
      "Normalized index must be used through real view",
    );
    assert.match(plan, /deliveries_phone_alt_search_trgm/);
    console.log(
      "PASS indexed search against 20,011 orders:",
      plan.match(/Execution Time: [\d.]+ ms/)[0],
    );
  }
} finally {
  sql(
    "BEGIN; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations CASCADE; COMMIT;",
  );
}
