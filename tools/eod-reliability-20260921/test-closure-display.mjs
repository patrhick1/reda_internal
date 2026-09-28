// Display-only check: actual exported screen with synthetic history responses.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isClientPolicyClosure } from "../../mobile/src/lib/delivery-status-display.ts";

for (const reason of [
  "maintenance:manual_close_policy",
  "maintenance:close_policy; canonical=123",
  "eod_auto_cancel:client_policy",
  "Postponed order came due; auto-cancelled per client policy",
]) {
  assert(isClientPolicyClosure("failed_delivery", reason));
  assert.equal(isClientPolicyClosure("unserious", reason), false);
}
for (const reason of [
  null,
  "Customer refused delivery",
  "maintenance:manual_close_followup",
  "maintenance:manual_close_policy_other",
])
  assert.equal(isClientPolicyClosure("failed_delivery", reason), false);

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, "index.mjs"))
        .href
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
    for (const reason of [
      "maintenance:manual_close_policy",
      "eod_auto_cancel:client_policy",
      "Customer refused delivery",
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const user = {
        id: "22222222-2222-4222-8222-222222222222",
        email: "admin@example.invalid",
        display_name: "TEST Uzo",
        role: "admin",
        is_active: true,
      };
      const id = "55555555-5555-4555-8555-555555555555",
        historyId = "66666666-6666-4666-8666-666666666666";
      const delivery = {
        id,
        customer_name: "TEST policy closure",
        customer_phone: "08000000000",
        raw_address: "TEST address",
        current_status: "failed_delivery",
        scheduled_date: "2026-09-23",
        created_date: "2026-09-23",
        created_at: "2026-09-23T09:00:00Z",
        updated_at: "2026-09-23T21:31:00Z",
        latest_history_id: historyId,
        order_type: "delivery",
        quantity_ordered: 1,
        customer_price: 10000,
        charged_snapshot: 4000,
        agent_payment_snapshot: 3000,
        margin: 1000,
        rollover_count: 0,
        client: { name: "TEST client", auto_cancel_soft_fails: true },
        location: null,
        assigned_agent: null,
      };
      await page.addInitScript(
        (session) =>
          localStorage.setItem("sb-api-auth-token", JSON.stringify(session)),
        {
          access_token: "isolated-ui-test",
          refresh_token: "isolated-ui-test",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user,
        },
      );
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url()),
          name = url.pathname.split("/").at(-1);
        if (url.hostname === "127.0.0.1") return route.continue();
        if (url.hostname !== "api.redalogisticss.com") return route.abort();
        let data = [];
        if (name === "users") data = url.searchParams.has("id") ? user : [user];
        if (name === "user") data = user;
        if (name === "get_same_customer_config")
          data = { discovery_enabled: false };
        if (/^count_/.test(name)) data = 0;
        if (name === "get_delivery_pay_state")
          data = [
            {
              delivery_id: id,
              mode: "legacy",
              state: "ready",
              amount: 3000,
              margin: 1000,
            },
          ];
        if (["deliveries_admin", "deliveries_safe"].includes(name))
          data = url.searchParams.has("id") ? delivery : [delivery];
        if (name === "list_delivery_history_chain_v2")
          data = [
            {
              id: "77777777-7777-4777-8777-777777777777",
              delivery_id: "88888888-8888-4888-8888-888888888888",
              is_current: false,
              scheduled_date: "2026-09-22",
              to_status: "failed_delivery",
              from_status: "tomorrow",
              changed_by_name: "Reda System",
              effective_at: "2026-09-22T21:00:00Z",
              changed_at: "2026-09-22T21:00:00Z",
              reason: "maintenance:close_policy",
              notes: null,
            },
            {
              id: historyId,
              delivery_id: id,
              is_current: true,
              scheduled_date: "2026-09-23",
              to_status: "failed_delivery",
              from_status: "tomorrow",
              changed_by_name: "Reda System",
              effective_at: "2026-09-23T21:31:00Z",
              changed_at: "2026-09-23T21:31:00Z",
              reason,
              notes: null,
            },
          ];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      });
      try {
        await page.goto("http://127.0.0.1:55453/(admin)/deliveries/" + id);
        const explanation =
          "Closed because this client’s orders do not roll over.";
        await page.getByText(explanation, { exact: true }).first().waitFor();
        const policy = isClientPolicyClosure("failed_delivery", reason);
        assert.equal(
          await page.getByText("Closed", { exact: true }).count(),
          policy ? 3 : 1,
          "Header uses current event, not ancestor or client setting",
        );
        assert.equal(
          await page.getByText("Failed", { exact: true }).count(),
          policy ? 0 : 2,
        );
        if (!policy) await page.getByText(reason, { exact: true }).waitFor();
        assert.equal(
          await page.getByText(/^maintenance:/).count(),
          0,
          "Technical closure code hidden",
        );
        assert.equal(await page.getByText(/^eod_auto_cancel:/).count(), 0);
        assert.deepEqual(errors, []);
        console.log(
          "PASS closure display, history and current-event badge",
          width,
          reason,
        );
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
