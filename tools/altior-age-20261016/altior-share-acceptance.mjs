// Real exported app, synthetic API data, captured Web Share payload only.
// Never sends to WhatsApp, clipboard or an external recipient.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, "index.mjs"))
        .href
    : "playwright"
);
const dist = path.resolve(
  process.env.ALTIOR_UI_DIST || "mobile/dist/altior-after",
);
const server = createServer((req, res) => {
  const requested = path.resolve(
    dist,
    "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
  );
  if (!requested.startsWith(dist + path.sep) && requested !== dist) {
    res.writeHead(403).end();
    return;
  }
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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STOCK_UI_BROWSER
    ? { executablePath: process.env.STOCK_UI_BROWSER }
    : {}),
});
const clientId = "0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc";
const reportRow = {
  delivery_id: "55555555-5555-4555-8555-555555555555",
  scheduled_date: "2026-10-15",
  order_type: "delivery",
  customer_name: "TEST Altior recipient",
  customer_phone: null,
  client_rep: "ORD-TEST-001",
  product_name: "Hair Removal Cream",
  quantity_ordered: 2,
  quantity_delivered: 2,
  products: null,
  customer_price: 26000,
  paid: 26000,
  reda_fee: 4000,
  remit: 22000,
  payment_method: "transfer",
  cash_pos_fee: 0,
  outstanding: 0,
};
const balance = {
  client_id: clientId,
  is_initialized: true,
  balance_before_period: 2000,
  period_activity: 22000,
  payouts_in_period: 7000,
  payments_in_period: 0,
  current_balance: 17000,
};
const messages = [];
try {
  for (const role of ["admin", "rep"]) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const page = await context.newPage();
    const user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: `${role}@example.invalid`,
      display_name: `TEST ${role}`,
      role,
      is_active: true,
    };
    const session = {
      access_token: "isolated-ui-test",
      refresh_token: "isolated-ui-test",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user,
    };
    await page.addInitScript((session) => {
      localStorage.setItem("sb-api-auth-token", JSON.stringify(session));
      window.__shared = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data) => window.__shared.push(data),
      });
    }, session);
    const errors = [],
      reportCalls = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.hostname !== "api.redalogisticss.com") return route.abort();
      const name = url.pathname.split("/").at(-1);
      let data = [];
      if (name === "users") data = url.searchParams.has("id") ? user : [user];
      if (name === "user") data = user;
      if (
        name === "client_remit_detail" ||
        name === "client_remit_detail_rep"
      ) {
        assert.equal(
          name,
          role === "admin" ? "client_remit_detail" : "client_remit_detail_rep",
        );
        assert.equal(route.request().postDataJSON().p_client_id, clientId);
        reportCalls.push(name);
        data = [reportRow];
      }
      if (name === "client_account_balances") data = [balance];
      if (name === "get_same_customer_config")
        data = { discovery_enabled: false };
      if (/^count_/.test(name)) data = 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
    try {
      await page.goto(
        `${origin}/(${role})/reconcile/client/${clientId}?name=Altior%20Essentials&from=2026-10-15&to=2026-10-15`,
      );
      await page.getByText(reportRow.customer_name, { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Share with client", exact: true })
        .click();
      await page.waitForFunction(() => window.__shared.length === 1);
      const payload = await page.evaluate(() => window.__shared[0]);
      const message = payload.text;
      assert(message.includes("Customer paid: ₦26,000\nDelivery fee: ₦4,000"));
      assert(message.includes("Note: ORD-TEST-001 —"));
      assert(message.includes("Hair Removal Cream: 2"));
      assert(message.includes("Today's remittance: ₦22,000"));
      assert(message.includes("Reda remits client: ₦17,000"));
      assert(!message.includes("\nTo Remit:"));
      assert(reportCalls.length > 0);
      assert.deepEqual(errors, []);
      messages.push(message);
      console.log(
        `PASS ${role}: open Altior report → Share → captured paid/fee layout with unchanged ledger footer`,
      );
    } catch (error) {
      console.error({
        role,
        errors,
        body: await page.locator("body").innerText(),
      });
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.equal(messages[0], messages[1]);
  console.log(
    "PASS admin and rep outputs are identical; no external message sent",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
