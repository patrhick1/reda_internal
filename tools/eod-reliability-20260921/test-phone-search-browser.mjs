// Real exported search screen, real isolated PostgREST and persisted fixtures.
// Only authentication/navigation shell responses are stubbed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runPhoneSearchBrowser({ jwt, admin, formats }) {
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
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const user = {
        id: admin,
        email: "system@reda.local",
        display_name: "TEST admin",
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
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          name = url.pathname.split("/").at(-1);
        if (url.hostname === "127.0.0.1") return route.continue();
        if (url.hostname !== "api.redalogisticss.com") return route.abort();
        if (["deliveries_admin", "deliveries_safe"].includes(name)) {
          const res = await fetch(
            "http://127.0.0.1:55451/" + name + url.search,
            {
              headers: {
                Authorization: "Bearer " + jwt(),
                "x-reda-payment-contract": "1",
              },
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await res.text();
          assert(res.ok, body);
          return route.fulfill({
            status: res.status,
            contentType: "application/json",
            body,
          });
        }
        let data = [];
        if (name === "users") data = url.searchParams.has("id") ? user : [user];
        if (name === "user") data = user;
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
        await page.goto("http://127.0.0.1:55453/(admin)/deliveries");
        const input = page.getByPlaceholder("Search name or phone (all dates)");
        await input.waitFor();
        for (const query of [...formats, "65485", "phone test 9"]) {
          await input.fill(query);
          await page
            .getByText("Phone Test 9", { exact: true })
            .first()
            .waitFor();
          // Wait for this exact debounced API query, then verify the client filter
          // retained the alternate-number result too.
          await page.waitForTimeout(600);
          assert(
            await page
              .getByText("Phone Test 9", { exact: true })
              .first()
              .isVisible(),
            query,
          );
        }
        await input.fill("08033165486");
        await page
          .getByText("Phone Test 9", { exact: true })
          .first()
          .waitFor({ state: "hidden" });
        await page.waitForTimeout(600);
        assert.equal(
          await page.getByText("Phone Test 9", { exact: true }).count(),
          0,
        );
        await page.goto("http://127.0.0.1:55453/(admin)/replacement-new");
        await page
          .getByPlaceholder("Customer name or phone — all dates")
          .fill("+234 803 316 5485");
        await page
          .getByText(/Phone Test 9 ·/)
          .first()
          .waitFor();
        assert.deepEqual(errors, []);
        console.log(
          "PASS browser search formats, alternate contact, partial/name, unmatched and replacement queries at width",
          width,
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
