// Called by test-immediate-http.mjs --browser-only. The exported real screen
// calls real local HTTP EOD endpoints. Only login/navigation shell data is stubbed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runImmediateBrowser({
  reset,
  checkEffects,
  sql,
  jwt,
  admin,
}) {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE_PATH
      ? pathToFileURL(
          path.join(process.env.PLAYWRIGHT_MODULE_PATH, "index.mjs"),
        ).href
      : "playwright"
  );
  const dist = path.resolve(process.env.EOD_UI_DIST || "mobile/dist");
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
  await new Promise((r) => server.listen(55453, "127.0.0.1", r));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.EOD_UI_BROWSER_CHANNEL
      ? { channel: process.env.EOD_UI_BROWSER_CHANNEL }
      : {}),
  });
  try {
    for (const width of [390, 1280])
      for (const scenario of ["normal", "lost-response", "reload"]) {
        reset(153);
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        const user = {
          id: admin,
          email: "system@reda.local",
          display_name: "TEST dispatcher",
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
        let steps = 0,
          submissions = 0,
          statusReads = 0,
          resolveFirst;
        const first = new Promise((r) => {
          resolveFirst = r;
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          if (url.hostname === "127.0.0.1") return route.continue();
          if (url.hostname !== "api.redalogisticss.com") return route.abort();
          const name = url.pathname.split("/").at(-1);
          if (
            [
              "prepare_manual_eod",
              "manual_eod_preview_page",
              "request_manual_eod",
              "advance_manual_eod",
              "manual_eod_status",
            ].includes(name)
          ) {
            // No EOD response is fabricated. A lost response is injected only
            // after the actual processing transaction has committed.
            const res = await fetch("http://127.0.0.1:55451/rpc/" + name, {
              method: "POST",
              headers: {
                Authorization: "Bearer " + jwt(),
                "x-reda-payment-contract": "1",
                "Content-Type": "application/json",
              },
              body: request.postData(),
              signal: AbortSignal.timeout(15000),
            });
            const body = await res.text();
            if (name === "request_manual_eod") submissions++;
            if (name === "manual_eod_status") statusReads++;
            if (name === "advance_manual_eod") {
              steps++;
              if (steps === 1) resolveFirst();
              if (scenario === "lost-response" && steps === 1)
                return route.fulfill({
                  status: 503,
                  contentType: "application/json",
                  body: '{"message":"TEST committed response lost"}',
                });
            }
            return route.fulfill({
              status: res.status,
              contentType: "application/json",
              body,
            });
          }
          let data = [];
          if (name === "users")
            data = url.searchParams.has("id") ? user : [user];
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
          await page.goto("http://127.0.0.1:55453/(admin)/eod");
          await page.getByText("Roll forward · 153", { exact: true }).waitFor();
          await page
            .getByRole("button", { name: "Run end of day", exact: true })
            .click();
          const confirmation = page.getByRole("alertdialog", {
            name: "Run end of day?",
            exact: true,
          });
          await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
          await confirmation.waitFor({ state: "hidden" });
          assert.equal(submissions, 0, "Cancel sends no EOD submission");
          assert.equal(steps, 0, "Cancel starts no EOD processing");
          await page
            .getByRole("button", { name: "Run end of day", exact: true })
            .click();
          await confirmation.waitFor();
          const started = performance.now();
          await confirmation
            .getByRole("button", { name: "Run end of day", exact: true })
            .click();
          if (scenario === "reload") {
            await first;
            await page.reload();
          }
          await page
            .getByText(/End of day complete\./)
            .waitFor({ timeout: 15000 });
          const elapsedMs = Math.round(performance.now() - started);
          assert(
            elapsedMs < (scenario === "normal" ? 10000 : 15000),
            `Click-to-completion latency ${elapsedMs}ms`,
          );
          assert(
            steps >= 2,
            "More than 100 groups requires immediately continuing a bounded batch",
          );
          assert.equal(
            submissions,
            scenario === "reload" ? 2 : 1,
            "Single confirmation, same approval on reload",
          );
          if (scenario === "lost-response")
            assert(
              statusReads > 0,
              "Lost response verified against saved status",
            );
          checkEffects(153);
          assert.equal(
            sql(
              "select count(*) from reda_maintenance.work where status<>'succeeded'",
            ),
            "0",
          );
          assert.deepEqual(errors, []);
          console.log(
            "PASS real browser + HTTP + database",
            JSON.stringify({ width, scenario, groups: 153, elapsedMs, steps }),
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
