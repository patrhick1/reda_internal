// Actual exported stock screen with synthetic API data; no production requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE_PATH
    ? pathToFileURL(path.join(process.env.PLAYWRIGHT_MODULE_PATH, "index.mjs"))
        .href
    : "playwright"
);
const dist = path.resolve(process.env.EOD_UI_DIST || "mobile/dist");
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
await new Promise((resolve) => server.listen(55453, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.EOD_UI_BROWSER_CHANNEL
    ? { channel: process.env.EOD_UI_BROWSER_CHANNEL }
    : {}),
});
const admin = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "test@example.invalid",
  display_name: "TEST admin",
  role: "admin",
  is_active: true,
};
const holder = {
  ...admin,
  id: "33333333-3333-4333-8333-333333333333",
  display_name: "TEST agent",
  role: "agent",
};
const product = {
  id: "66666666-6666-4666-8666-666666666666",
  client_id: "77777777-7777-4777-8777-777777777777",
  product_name: "Test bottles",
  is_active: true,
  clients: { name: "Test vendor" },
};
try {
  for (const role of ["admin", "admin-batch", "warehouse"]) {
    const active = role.startsWith("admin")
      ? admin
      : { ...admin, role: "warehouse", warehouse_id: holder.id };
    const warehouseHolder = {
      ...holder,
      role: "warehouse",
      warehouse_id: null,
    };
    const page = await browser.newPage({
      viewport: { width: 390, height: 1000 },
    });
    const errors = [],
      requests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(
      (session) =>
        localStorage.setItem("sb-api-auth-token", JSON.stringify(session)),
      {
        access_token: "isolated-ui-test",
        refresh_token: "isolated-ui-test",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: active,
      },
    );
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url()),
        name = url.pathname.split("/").at(-1);
      if (url.hostname === "127.0.0.1") return route.continue();
      if (url.hostname !== "api.redalogisticss.com") return route.abort();
      let data = [];
      if (name === "users")
        data = url.searchParams.has("id")
          ? url.searchParams.get("id").includes(holder.id)
            ? role === "warehouse"
              ? warehouseHolder
              : holder
            : active
          : [active, role === "warehouse" ? warehouseHolder : holder];
      if (name === "user") data = active;
      if (name === "get_same_customer_config")
        data = { discovery_enabled: false };
      if (name === "get_blacklist_notice_summary")
        data = { count: 0, latest_id: null, latest_inbound_id: null };
      if (/^count_/.test(name)) data = 0;
      if (name === "product_catalog") data = [product];
      if (name === "current_stock")
        data = [
          {
            agent_id: holder.id,
            product_catalog_id: product.id,
            quantity_on_hand: 10,
          },
        ];
      if (name === "create_stock_adjustment") {
        requests.push(route.request().postDataJSON());
        if (role === "admin-batch" && requests.length === 2)
          return route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              code: "P0001",
              message: "insufficient_stock: only 1 unit remains",
            }),
          });
        data = "88888888-8888-4888-8888-888888888888";
      }
      if (name === "create_waybill")
        throw Error("Stock action invoked financial waybill");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });
    await page.goto(
      `http://127.0.0.1:55453/${role.startsWith("admin") ? "(admin)/stock/adjust?holderId=" + holder.id : "(warehouse)/(home)/adjust"}`,
    );
    await page.getByText("Pick a reason", { exact: true }).click();
    if (role === "warehouse") {
      await page.getByText("Loss", { exact: true }).waitFor();
      assert.equal(
        await page.getByText("Waybill — stock out", { exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByText("Correction", { exact: true }).count(),
        0,
      );
      console.log(
        "PASS: warehouse reason menu excludes admin-only stock waybill",
      );
    } else {
      await page.getByText("Waybill — stock out", { exact: true }).click();
      await page.getByText(/This does not record a waybill charge/).waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Add stock", exact: true })
          .count(),
        0,
      );
      await page.getByText("Search product or client", { exact: true }).click();
      await page.getByText("Test bottles", { exact: true }).click();
      const quantity = page.locator("input").first();
      await quantity.fill("1.5");
      await page
        .getByRole("button", { name: "Apply 1 adjustment", exact: true })
        .click();
      await page
        .getByText("Each row needs a positive whole-number quantity", {
          exact: true,
        })
        .waitFor();
      assert.equal(await quantity.inputValue(), "1.5");
      assert.equal(requests.length, 0);
      await quantity.fill("11");
      await page
        .getByRole("button", { name: "Apply 1 adjustment", exact: true })
        .click();
      await page
        .getByText("Test bottles: only 10 on hand", { exact: true })
        .waitFor();
      assert.equal(requests.length, 0);
      if (role === "admin-batch") {
        await quantity.fill("2");
        await page
          .getByRole("button", { name: "+ Add another item", exact: true })
          .click();
        await page
          .getByText("Search product or client", { exact: true })
          .click();
        await page.getByText("Test bottles", { exact: true }).last().click();
        await page.locator("input").nth(1).fill("3");
        await page
          .getByRole("button", { name: "Apply 2 adjustments", exact: true })
          .click();
        await page.getByText(/1 of 2 applied; 1 failed:/).waitFor();
        assert.equal(requests.length, 2);
        assert.equal(await page.locator("input").first().inputValue(), "");
        await page.goto("http://127.0.0.1:55453/(queue)/dead-letter");
        const retried = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith(
              "/create_stock_adjustment",
            ) && response.status() === 200,
        );
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await retried;
        await page.getByText("All synced", { exact: true }).waitFor();
        assert.equal(requests.length, 3);
        assert.equal(requests[2].p_client_uuid, requests[1].p_client_uuid);
        assert.notEqual(requests[2].p_client_uuid, requests[0].p_client_uuid);
        console.log(
          "PASS: partial batch clears submitted rows and retries only failure with its original ID",
        );
        assert.deepEqual(errors, []);
        await page.close();
        continue;
      }
      await quantity.fill("5");
      await page
        .getByPlaceholder("Optional — shipment reference or destination")
        .fill("Shipment WB-TEST");
      const sent = page.waitForResponse((r) =>
        new URL(r.url()).pathname.endsWith("/create_stock_adjustment"),
      );
      await page
        .getByRole("button", { name: "Apply 1 adjustment", exact: true })
        .click();
      await sent;
      assert.equal(requests.length, 1);
      assert.equal(requests[0].p_reason, "waybill");
      assert.equal(requests[0].p_quantity_delta, -5);
      assert.equal(requests[0].p_agent_id, holder.id);
      assert.equal(requests[0].p_product_catalog_id, product.id);
      assert.equal(requests[0].p_notes, "Shipment WB-TEST");
      assert(requests[0].p_client_uuid);
      console.log(
        "PASS: real form validates fractions and overdraw, queues one stock-only waybill with a retry ID",
      );
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
