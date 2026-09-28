// Real exported form and real local database/API. Auth/navigation shell alone
// is stubbed. Slow/lost responses are injected around actual committed saves.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runReviewSaveBrowser({
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
}) {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE_PATH
      ? pathToFileURL(
          path.join(process.env.PLAYWRIGHT_MODULE_PATH, "index.mjs"),
        ).href
      : "playwright"
  );
  const dist = path.resolve("mobile/dist");
  const server = createServer((req, res) => {
    const requested = path.resolve(
      dist,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (!requested.startsWith(dist + path.sep) && requested !== dist)
      return res.writeHead(403).end();
    const file =
      existsSync(requested) && path.extname(requested)
        ? requested
        : path.join(dist, "index.html");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".ttf": "font/ttf",
      }[path.extname(file)] || "application/octet-stream",
    );
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(55453, "127.0.0.1", r));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.EOD_UI_BROWSER_CHANNEL
      ? { channel: process.env.EOD_UI_BROWSER_CHANNEL }
      : {}),
  });
  try {
    for (const width of [390, 1280])
      for (const scenario of ["normal", "lost-response", "failed-request"]) {
        const id = await source(),
          input = payload(id);
        const parse = {
          extracted: {
            customer_name: input.p_customer_name,
            customer_phone: input.p_customer_phone,
            raw_address: input.p_raw_address,
            instructions: "Call before arrival",
            total_amount: 47500,
          },
          product_matches: [
            {
              line: { quantity: 3, product_name: "TEST product" },
              matched: {
                id: product,
                client_id: client,
                client_name: "EOD TEST",
                product_name: "TEST product",
              },
            },
            {
              line: { quantity: 1, product_name: "TEST socks" },
              matched: {
                id: product2,
                client_id: client,
                client_name: "EOD TEST",
                product_name: "TEST socks",
              },
            },
          ],
          address: { matched_location_id: location },
          agent_resolution: { agent_id: agent },
        };
        const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
        sql(
          `UPDATE bot_inbound_messages SET parse_result=${quote(JSON.stringify(parse))}::jsonb WHERE id='${id}';`,
        );
        const page = await browser.newPage({
            viewport: { width, height: 1000 },
          }),
          errors = [],
          calls = [];
        const user = {
          id: admin,
          email: "system@reda.local",
          display_name: "TEST Uzo",
          role: "admin",
          is_active: true,
        };
        await page.addInitScript(
          (session) =>
            localStorage.setItem("sb-api-auth-token", JSON.stringify(session)),
          {
            access_token: jwt(),
            refresh_token: "isolated-test-only",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user,
          },
        );
        page.on("pageerror", (e) => errors.push(e.message));
        let saves = 0;
        const real = [
          "bot_inbound_messages",
          "clients",
          "locations",
          "product_catalog",
          "acquire_edit_lock",
          "release_edit_lock",
          "heartbeat_edit_lock",
          "create_delivery_from_review",
          "create_delivery",
          "resolve_inbound_to_delivery",
        ];
        await page.route("**/*", async (route) => {
          const request = route.request(),
            url = new URL(request.url()),
            name = url.pathname.split("/").at(-1);
          if (url.hostname === "127.0.0.1") return route.continue();
          if (url.hostname !== "api.redalogisticss.com") return route.abort();
          calls.push(name);
          if (real.includes(name)) {
            const mutation = [
              "create_delivery_from_review",
              "create_delivery",
              "resolve_inbound_to_delivery",
              "release_edit_lock",
            ].includes(name);
            if (mutation) await sleep(300);
            if (name === "create_delivery_from_review") {
              saves++;
              if (scenario === "failed-request" && saves === 1)
                return route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: JSON.stringify({
                    message: "TEST connection interrupted; try again",
                  }),
                });
            }
            const res = await fetch(
              "http://127.0.0.1:55451/" +
                (url.pathname.includes("/rpc/") ? "rpc/" : "") +
                name +
                url.search,
              {
                method: request.method(),
                headers: {
                  Authorization: "Bearer " + jwt(),
                  "x-reda-payment-contract": "1",
                  "Content-Type": "application/json",
                  Accept: request.headers().accept || "application/json",
                },
                ...(request.postData() ? { body: request.postData() } : {}),
                signal: AbortSignal.timeout(25000),
              },
            );
            const body = await res.text();
            if (
              name === "create_delivery_from_review" &&
              scenario === "lost-response" &&
              saves === 1
            ) {
              assert(res.ok, body);
              return route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                  message: "TEST connection interrupted; try again",
                }),
              });
            }
            return route.fulfill({
              status: res.status,
              contentType: "application/json",
              body,
            });
          }
          let data = [];
          if (name === "user") data = user;
          if (name === "users")
            data = url.searchParams.has("id")
              ? user
              : [
                  user,
                  {
                    id: agent,
                    display_name: "TEST rider",
                    role: "agent",
                    is_active: true,
                  },
                ];
          if (name === "get_same_customer_config")
            data = { discovery_enabled: false };
          if (/^count_/.test(name)) data = 0;
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(data),
          });
        });
        try {
          // Open from the queue, so successful save must actually return to it.
          await page.goto("http://127.0.0.1:55453/(admin)/needs-review");
          await page.getByText(input.p_customer_name, { exact: true }).click();
          const button = page.getByRole("button", {
            name: "Create delivery",
            exact: true,
          });
          await button.waitFor();
          const start = performance.now();
          await button.click();
          if (scenario !== "normal") {
            await page
              .getByText("TEST connection interrupted; try again", {
                exact: true,
              })
              .waitFor();
            const enteredValues = await page
              .locator("input,textarea")
              .evaluateAll((fields) => fields.map((field) => field.value));
            assert(
              enteredValues.includes(input.p_customer_name),
              "Name survives failed save",
            );
            assert(
              enteredValues.includes("47500"),
              "Price survives failed save",
            );
            await button.click();
          }
          await page.waitForURL(
            (url) =>
              url.pathname === "/(admin)/needs-review" ||
              url.pathname === "/needs-review",
          );
          const elapsed = Math.round(performance.now() - start);
          assert.equal(saves, scenario === "normal" ? 1 : 2);
          assert.equal(calls.filter((n) => n === "create_delivery").length, 0);
          assert.equal(
            calls.filter((n) => n === "resolve_inbound_to_delivery").length,
            0,
          );
          assert.equal(
            calls.filter((n) => n === "release_edit_lock").length,
            0,
            "Server release needs no extra cleanup call",
          );
          assert.equal(
            sql(
              `select count(*) from delivery_status_history where client_uuid='review-save-v1:${id}'`,
            ),
            "1",
          );
          assert.equal(
            sql(`select count(*) from edit_locks where entity_id='${id}'`),
            "0",
          );
          assert.equal(
            sql(
              `select count(*) from delivery_items where delivery_id=(select delivery_id from bot_inbound_messages where id='${id}')`,
            ),
            "2",
          );
          assert.deepEqual(errors, []);
          console.log(
            "PASS real Review browser",
            JSON.stringify({
              width,
              scenario,
              elapsedMs: elapsed,
              injectedDelayPerRequestMs: 300,
              saves,
            }),
          );
          if (scenario === "normal") {
            // Measure the previous three-request save chain in the same browser with
            // identical network delay and database business functions (not a mock).
            const legacyId = await source(),
              legacy = payload(legacyId, { p_assigned_agent_id: null });
            const legacyMs = await page.evaluate(
              async ({ input, token }) => {
                async function rpc(name, body) {
                  const r = await fetch(
                    "https://api.redalogisticss.com/rest/v1/rpc/" + name,
                    {
                      method: "POST",
                      headers: {
                        Authorization: "Bearer " + token,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify(body),
                    },
                  );
                  if (!r.ok) throw new Error(await r.text());
                  const t = await r.text();
                  return t ? JSON.parse(t) : null;
                }
                const start = performance.now(),
                  body = {
                    ...input,
                    p_client_uuid: crypto.randomUUID(),
                    p_created_via: "manual",
                  };
                delete body.p_inbound_id;
                const delivery = await rpc("create_delivery", body);
                await rpc("resolve_inbound_to_delivery", {
                  p_inbound_id: input.p_inbound_id,
                  p_delivery_id: delivery,
                });
                await rpc("release_edit_lock", {
                  p_entity_type: "bot_inbound",
                  p_entity_id: input.p_inbound_id,
                });
                return Math.round(performance.now() - start);
              },
              { input: legacy, token: jwt() },
            );
            console.log(
              "Measured old three-request chain in same browser",
              JSON.stringify({ width, elapsedMs: legacyMs }),
            );
            assert(legacyMs >= 900);
            assert(
              elapsed < legacyMs,
              "Single-request click-to-return improves on old chain",
            );
          }
        } catch (error) {
          console.error(errors, await page.locator("body").innerText());
          throw error;
        } finally {
          await page.close();
        }
      }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
