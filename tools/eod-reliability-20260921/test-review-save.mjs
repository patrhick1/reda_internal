// Actual API and database transactions, exclusively in the isolated fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
for (const table of ["deliveries", "public.users", "bot_inbound_messages"])
  assert.equal(sql("select count(*) from " + table), "0");
const admin = "2d8d5895-d2a8-4900-b15e-7662b176a805";
const agent = sql("select md5('eod-test-agent')::uuid"),
  other = randomUUID();
const client = sql("select md5('eod-test-client')::uuid"),
  product = sql("select md5('eod-test-product')::uuid"),
  product2 = randomUUID(),
  location = sql("select md5('eod-test-location')::uuid");
const day = sql(
  "select public._ensure_workday(reda_maintenance.business_day()+1)",
);
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
function jwt(sub = admin) {
  const body = [
    { alg: "HS256", typ: "JWT" },
    {
      role: sub ? "authenticated" : "anon",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
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
async function rpc(name, body, sub = admin) {
  const res = await fetch("http://127.0.0.1:55451/rpc/" + name, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + jwt(sub),
      "x-reda-payment-contract": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw Object.assign(new Error(data.message), {
      code: data.code,
      status: res.status,
    });
  return data;
}
let counter = 0;
async function source(sub = admin) {
  const id = randomUUID();
  sql(
    `INSERT INTO bot_inbound_messages(id,wasender_message_id,remote_jid,raw_payload,raw_text,status) VALUES('${id}','test:${id}','test','{}','TEST original WhatsApp message ${++counter}','needs_review');`,
  );
  await rpc(
    "acquire_edit_lock",
    { p_entity_type: "bot_inbound", p_entity_id: id },
    sub,
  );
  return id;
}
function payload(id, overrides = {}) {
  return {
    p_inbound_id: id,
    p_client_id: client,
    p_product_catalog_id: product,
    p_customer_name: "TEST corrected customer " + counter,
    p_customer_phone: "0803" + String(counter).padStart(7, "0"),
    p_customer_phone_alt: "08140000001",
    p_raw_address: "TEST corrected address " + counter,
    p_quantity_ordered: 3,
    p_customer_price: 47500,
    p_location_id: location,
    p_scheduled_date: day,
    p_assigned_agent_id: agent,
    p_items: [
      {
        product_catalog_id: product,
        quantity_ordered: 3,
        customer_price: null,
      },
      {
        product_catalog_id: product2,
        quantity_ordered: 1,
        customer_price: null,
      },
    ],
    p_delivery_instructions: "Call before arrival",
    ...overrides,
  };
}
const save = (body, sub = admin) =>
  rpc("create_delivery_from_review", body, sub);
async function rejects(body, code, sub = admin) {
  await assert.rejects(
    () => save(body, sub),
    (e) => e.code === code,
  );
}
function concurrentSql(text) {
  const child = spawn(psql, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    error = "",
    readyResolve;
  const ready = new Promise((r) => {
    readyResolve = r;
  });
  child.stdout.on("data", (b) => {
    output += b;
    if (output.includes("READY")) readyResolve();
  });
  child.stderr.on("data", (b) => {
    error += b;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(error)),
    );
  });
  child.stdin.end(text);
  return { ready, done };
}
try {
  sql(
    readFileSync(path.join(dir, "fixture.sql"), "utf8").replace(/^\uFEFF/, "") +
      `
 TRUNCATE deliveries CASCADE;
 INSERT INTO auth.users(id,email) VALUES('${other}','review-dispatcher@example.invalid');
 INSERT INTO public.users(id,email,display_name,role) VALUES('${other}','review-dispatcher@example.invalid','TEST dispatcher','dispatcher');
 INSERT INTO product_catalog(id,client_id,product_name) VALUES('${product2}','${client}','TEST socks');
 GRANT SELECT ON bot_inbound_messages,public.users,clients,locations,product_catalog TO authenticated;
 COMMIT;`,
  );
  let id = await source(),
    body = payload(id);
  const started = performance.now(),
    delivery = await save(body);
  console.log(
    "PASS actual HTTP single save",
    Math.round(performance.now() - started),
    "ms",
  );
  const row = JSON.parse(
    sql(`select row_to_json(d) from deliveries d where id='${delivery}'`),
  );
  assert.equal(row.customer_name, body.p_customer_name);
  assert.equal(row.customer_phone_alt, body.p_customer_phone_alt);
  assert.equal(row.raw_address, body.p_raw_address);
  assert.equal(row.customer_price, 47500);
  assert.equal(row.quantity_ordered, 3);
  assert.equal(row.delivery_instructions, body.p_delivery_instructions);
  assert.equal(row.assigned_agent_id, agent);
  assert.equal(row.scheduled_date, day);
  assert.equal(row.created_via, "manual");
  assert.match(row.bot_raw_message, /TEST original WhatsApp/);
  assert.equal(
    sql(`select count(*) from delivery_items where delivery_id='${delivery}'`),
    "2",
  );
  assert.equal(
    sql(
      `select sum(quantity_ordered) from delivery_items where delivery_id='${delivery}'`,
    ),
    "4",
  );
  assert.equal(
    sql(
      `select status||':'||delivery_id from bot_inbound_messages where id='${id}'`,
    ),
    "created_delivery:" + delivery,
  );
  assert.equal(
    sql(`select count(*) from edit_locks where entity_id='${id}'`),
    "0",
  );
  assert.equal(await save(body), delivery, "Lost-response retry");
  assert.equal(
    await save({ ...body, p_customer_price: 1 }, other),
    delivery,
    "Later stale payload cannot overwrite saved values",
  );
  await rejects(body, "42501", agent);
  await rejects(body, "42501", null);
  assert.equal(
    Number(sql(`select customer_price from deliveries where id='${delivery}'`)),
    47500,
  );
  await assert.rejects(
    () => rpc("discard_inbound", { p_inbound_id: id, p_reason: "duplicate" }),
    (e) => e.code === "PT409",
  );
  await rpc("resolve_inbound_to_delivery", {
    p_inbound_id: id,
    p_delivery_id: delivery,
  });
  await assert.rejects(
    () =>
      rpc("resolve_inbound_to_delivery", {
        p_inbound_id: id,
        p_delivery_id: randomUUID(),
      }),
    (e) => e.code === "PT409",
  );
  console.log(
    "PASS preserved form data/message/items, idempotency, permissions, stale link/discard guards",
  );

  id = await source();
  body = payload(id);
  // Hold the first save open during linking so the two requests overlap.
  sql(`CREATE FUNCTION public.test_review_slow_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${id}' AND NEW.status='created_delivery' THEN PERFORM pg_sleep(0.7); END IF; RETURN NEW; END $$;
 CREATE TRIGGER test_review_slow_link BEFORE UPDATE ON bot_inbound_messages FOR EACH ROW EXECUTE FUNCTION public.test_review_slow_link();`);
  let results;
  try {
    results = await Promise.all([save(body), save(body)]);
  } finally {
    sql(
      "DROP TRIGGER test_review_slow_link ON bot_inbound_messages; DROP FUNCTION public.test_review_slow_link();",
    );
  }
  assert.equal(results[0], results[1]);
  assert.equal(
    sql(
      `select count(*) from delivery_status_history where client_uuid='review-save-v1:${id}'`,
    ),
    "1",
  );
  const heldByOther = await source(other);
  await rejects(payload(heldByOther), "55P03");
  await save(payload(heldByOther), other);
  id = await source();
  sql(
    `update edit_locks set acquired_at=now()-interval '6 minutes' where entity_id='${id}'`,
  );
  await rejects(payload(id), "55P03");
  id = await source();
  await rpc(
    "acquire_edit_lock",
    { p_entity_type: "bot_inbound", p_entity_id: id, p_takeover: true },
    other,
  );
  await rejects(payload(id), "55P03");
  id = await source();
  await rpc("discard_inbound", { p_inbound_id: id, p_reason: "spam" });
  await rejects(payload(id), "PT409");
  await rejects(payload(randomUUID()), "P0002");
  console.log(
    "PASS two-device save, dispatcher, expired/stolen locks, discarded/missing source",
  );

  id = await source();
  body = payload(id);
  let count = sql("select count(*) from deliveries");
  await rejects({ ...body, p_customer_price: -1 }, "23514");
  await rejects(
    {
      ...body,
      p_items: [{ product_catalog_id: randomUUID(), quantity_ordered: 1 }],
    },
    "23514",
  );
  await rejects({ ...body, p_client_id: randomUUID() }, "23514");
  assert.equal(sql("select count(*) from deliveries"), count);
  assert.equal(
    sql(`select status from bot_inbound_messages where id='${id}'`),
    "needs_review",
  );
  await save(body);
  // Inject failure AFTER create_delivery: all effects must roll back together.
  id = await source();
  body = payload(id);
  count = sql("select count(*) from deliveries");
  sql(`CREATE FUNCTION public.test_review_link_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${id}' AND NEW.status='created_delivery' THEN RAISE EXCEPTION 'TEST failed link'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER test_review_link_failure BEFORE UPDATE ON bot_inbound_messages FOR EACH ROW EXECUTE FUNCTION public.test_review_link_failure();`);
  try {
    await rejects(body, "P0001");
    assert.equal(sql("select count(*) from deliveries"), count);
    assert.equal(
      sql(
        `select count(*) from delivery_status_history where client_uuid='review-save-v1:${id}'`,
      ),
      "0",
    );
    assert.equal(
      sql(`select count(*) from edit_locks where entity_id='${id}'`),
      "1",
    );
  } finally {
    sql(
      "DROP TRIGGER test_review_link_failure ON bot_inbound_messages; DROP FUNCTION public.test_review_link_failure();",
    );
  }
  await save(body);
  console.log(
    "PASS invalid form and late link failure roll back creation; corrected retry succeeds",
  );
  id = await source();
  body = payload(id);
  count = sql("select count(*) from deliveries");
  await rpc("add_customer_blacklist", {
    p_phone: body.p_customer_phone,
    p_reason: "TEST blacklist",
  });
  await rejects(body, "P0001");
  assert.equal(sql("select count(*) from deliveries"), count);
  sql("TRUNCATE customer_blacklist CASCADE;");
  await save(body);
  // Compare the same existing creation rules, including Saturday/Sunday date
  // handling, calculated fees and an optional agent, rather than duplicating them.
  for (const date of [day, "2026-10-03", "2026-10-04"]) {
    id = await source();
    body = payload(id, { p_scheduled_date: date, p_assigned_agent_id: null });
    const current = await save(body),
      old = { ...body, p_client_uuid: randomUUID(), p_created_via: "manual" };
    delete old.p_inbound_id;
    const previous = await rpc("create_delivery", old);
    const fields =
      "jsonb_build_array(scheduled_date,charged_snapshot,agent_payment_snapshot,assigned_agent_id,quantity_ordered,customer_price,delivery_instructions)";
    assert.equal(
      sql(`select ${fields} from deliveries where id='${current}'`),
      sql(`select ${fields} from deliveries where id='${previous}'`),
    );
  }
  console.log(
    "PASS blacklist, unassigned orders, dates and fee parity with existing create_delivery",
  );

  // A locked review item must not block another source. A genuinely busy source
  // should fail promptly, then succeed on retry after the lock is released.
  id = await source();
  body = payload(id);
  const independent = await source();
  const held = concurrentSql(
    `BEGIN; SELECT 1 FROM bot_inbound_messages WHERE id='${id}' FOR UPDATE; SELECT 'READY'; SELECT pg_sleep(3.5); COMMIT;`,
  );
  await held.ready;
  const t = performance.now();
  await save(payload(independent));
  assert(performance.now() - t < 2000);
  await rejects(body, "55P03");
  await held.done;
  await save(body);
  console.log(
    "PASS independent review remains responsive, contended save bounded and retryable",
  );

  // Legacy client finished first: the new endpoint reuses its linked order.
  id = await source();
  body = payload(id);
  const legacyBody = {
    ...body,
    p_client_uuid: randomUUID(),
    p_created_via: "manual",
  };
  delete legacyBody.p_inbound_id;
  const legacy = await rpc("create_delivery", legacyBody);
  await rpc("resolve_inbound_to_delivery", {
    p_inbound_id: id,
    p_delivery_id: legacy,
  });
  assert.equal(await save(body), legacy);
  assert.match(
    sql(`select bot_raw_message from deliveries where id='${legacy}'`),
    /TEST original WhatsApp/,
  );
  // Old client created but has not linked: it has already committed independent
  // data; preserve it rather than delete an order that may have been worked.
  id = await source();
  body = payload(id, { p_assigned_agent_id: null });
  const oldBody = {
    ...body,
    p_client_uuid: randomUUID(),
    p_created_via: "manual",
  };
  delete oldBody.p_inbound_id;
  const orphan = await rpc("create_delivery", oldBody),
    winner = await save(body);
  assert.notEqual(orphan, winner);
  await assert.rejects(
    () =>
      rpc("resolve_inbound_to_delivery", {
        p_inbound_id: id,
        p_delivery_id: orphan,
      }),
    (e) => e.code === "PT409",
  );
  assert.equal(
    sql(`select delivery_id from bot_inbound_messages where id='${id}'`),
    winner,
  );
  console.log(
    "PASS legacy completed-save reuse and late-link rejection; pre-existing legacy creation remains a documented rollout boundary",
  );

  if (process.argv.includes("--browser")) {
    const { runReviewSaveBrowser } =
      await import("./test-review-save-browser.mjs");
    await runReviewSaveBrowser({
      source,
      payload,
      sql,
      jwt,
      admin,
      client,
      product,
      product2,
      location,
      agent,
    });
  }
} finally {
  sql(
    "BEGIN; TRUNCATE public.deliveries,public.users,auth.users,public.clients,public.product_catalog,public.locations,public.bot_inbound_messages,public.edit_locks CASCADE; COMMIT;",
  );
}
