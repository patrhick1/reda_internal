// A dedicated local PostgreSQL cluster must be running on 127.0.0.1:55461,
// with superuser reda_call_test. No production connection options are accepted.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const psql =
  process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/17/bin/psql.exe"
    : "psql";
const database = "reda_call_session_test";
const args = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  "55461",
  "-U",
  "reda_call_test",
  "-d",
  database,
  "-v",
  "ON_ERROR_STOP=1",
  "-At",
];
function sql(input, db = database) {
  const parameters = [...args];
  parameters[parameters.indexOf("-d") + 1] = db;
  return execFileSync(psql, parameters, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
assert.equal(
  sql(
    "select current_user||'|'||host(inet_server_addr())||'|'||inet_server_port()",
    "postgres",
  ),
  "reda_call_test|127.0.0.1|55461",
);
if (process.argv.includes("--setup")) {
  sql(`CREATE DATABASE ${database}`, "postgres");
  sql(readFileSync(new URL("./bootstrap.sql", import.meta.url), "utf8"));
}
assert.equal(sql("select current_database()"), database);
assert.equal(
  sql("select count(*) from public.calls"),
  "0",
  "synthetic database must be empty",
);
sql(
  readFileSync(
    new URL(
      "../../supabase/migrations/20260928120000_call_session_recovery.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
const result = execFileSync(
  psql,
  [...args, "-f", fileURLToPath(new URL("./cases.sql", import.meta.url))],
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
);
assert(result.includes("ROLLBACK"));
console.log(
  "PASS call RPC lifecycle, expiry, permissions, device ownership, team acceptance",
);

function concurrent(input) {
  const child = spawn(psql, args, { stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    error = "";
  let signal;
  const ready = new Promise((resolve) => {
    signal = resolve;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes("LOCK_READY")) signal();
  });
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  const done = new Promise((resolve, reject) =>
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(error)),
    ),
  );
  child.stdin.end(input);
  return { ready, done };
}
const initiate =
  "select (public.initiate_call(md5('callee')::uuid,md5('device')::uuid,null,gen_random_uuid())).id;";
const login =
  "select set_config('request.jwt.claim.sub',md5('caller')::uuid::text,true);";
const first = concurrent(
  `BEGIN;${login}${initiate}SELECT 'LOCK_READY';SELECT pg_sleep(1);COMMIT;`,
);
await first.ready;
const second = concurrent(`BEGIN;${login}${initiate}COMMIT;`);
await Promise.all([first.done, second.done]);
assert.equal(sql("select count(*) from public.calls"), "1");
assert.equal(sql("select count(*) from public.call_test_audit"), "1");
console.log("PASS simultaneous call taps create one call and one audit");
sql("TRUNCATE public.calls,public.call_test_audit;");
