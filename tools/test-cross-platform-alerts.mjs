// Run with node tools/test-cross-platform-alerts.mjs. Requires Playwright and
// Chrome (or set ALERT_TEST_BROWSER=msedge). PLAYWRIGHT_MODULE can point to a
// bundled playwright/index.js when Playwright isn't installed in this repo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { after, before, beforeEach, test } from "node:test";

const requireMobile = createRequire(
  new URL("../mobile/package.json", import.meta.url),
);
const ts = requireMobile("typescript");
const playwrightModule = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const { chromium } = playwrightModule.default ?? playwrightModule;
const read = (path) =>
  readFileSync(new URL(`../mobile/${path}`, import.meta.url), "utf8");
const compile = (source, module = ts.ModuleKind.CommonJS) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module },
  }).outputText;
const webCode = compile(read("src/lib/alert.web.ts"));

// Exercise the real transfer handler, including the auto-selected warehouse
// condition that originally prevented a reason change on web.
const transferSource = ts.createSourceFile(
  "Transfer.tsx",
  read("src/screens/stock/Transfer.tsx"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let changeReason;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "changeReason") {
    changeReason = compile(node.getText(transferSource));
  }
  ts.forEachChild(node, visit);
}
visit(transferSource);
assert(changeReason, "Transfer changeReason handler exists");

let browser;
let page;
before(async () => {
  browser = await chromium.launch({
    channel: process.env.ALERT_TEST_BROWSER ?? "chrome",
    headless: true,
  });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});
beforeEach(async () => {
  await page.goto("about:blank");
  await page.setContent('<button id="opener">Open form</button>');
  await page.addScriptTag({
    content: `(() => { const exports = {}; ${webCode}\n window.Alert = exports.Alert; })();`,
  });
});

test("native adapter forwards to the existing native Alert unchanged", () => {
  const native = { alert: () => undefined };
  const exports = {};
  runInNewContext(compile(read("src/lib/alert.ts")), {
    exports,
    require: (name) => {
      assert.equal(name, "react-native");
      return { Alert: native };
    },
  });
  assert.equal(exports.Alert.alert, native.alert);
});

test("web module can be imported and called during static rendering", () => {
  const exports = {};
  runInNewContext(webCode, { exports });
  assert.doesNotThrow(() => exports.Alert.alert("Static render"));
});

async function setupTransfer({ empty = false } = {}) {
  await page.addScriptTag({
    content: `(() => {
    let reason = ${empty ? "null" : "'warehouse_issue'"};
    let fromHolderId = ${empty ? "null" : "'warehouse-1'"};
    let toHolderId = null;
    let rows = [{ id: 'row-1', productId: null, quantity: '' }];
    let error = null;
    const setReason = v => reason = v;
    const setError = v => error = v;
    const setFromHolderId = v => fromHolderId = v;
    const setToHolderId = v => toHolderId = v;
    const resetRows = () => rows = [{ id: 'reset-row', productId: null, quantity: '' }];
    ${changeReason}
    window.changeReason = changeReason;
    window.fillTransfer = () => { toHolderId = 'agent-1'; rows[0].productId = 'product-1'; rows[0].quantity = '3'; };
    window.transferState = () => ({ reason, fromHolderId, toHolderId, rows, error });
  })();`,
  });
}

test("transfer with auto-selected warehouse changes only after Switch", async () => {
  await setupTransfer();
  await page.evaluate(() => window.changeReason("warehouse_return"));
  assert.equal(
    await page
      .getByRole("alertdialog", { name: "Switch transfer type?" })
      .count(),
    1,
  );
  if (process.env.ALERT_TEST_SCREENSHOT)
    await page.screenshot({ path: process.env.ALERT_TEST_SCREENSHOT });
  assert.equal(
    await page.evaluate(() => window.transferState().reason),
    "warehouse_issue",
  );
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  const state = await page.evaluate(() => window.transferState());
  assert.equal(state.reason, "warehouse_return");
  assert.equal(state.fromHolderId, null);
  assert.equal(state.toHolderId, null);
  assert.equal(state.rows[0].productId, null);
});

test("Cancel preserves entered transfer details; Switch clears them", async () => {
  await setupTransfer();
  await page.evaluate(() => window.fillTransfer());
  const original = await page.evaluate(() => window.transferState());
  await page.evaluate(() => window.changeReason("transfer"));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.transferState()), original);
  await page.evaluate(() => window.changeReason("transfer"));
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  const state = await page.evaluate(() => window.transferState());
  assert.equal(state.reason, "transfer");
  assert.equal(state.toHolderId, null);
  assert.equal(state.rows[0].quantity, "");
});

test("initial reason selection and reselecting the current reason need no confirmation", async () => {
  await setupTransfer({ empty: true });
  await page.evaluate(() => window.changeReason("warehouse_issue"));
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  await page.evaluate(() => window.fillTransfer());
  const original = await page.evaluate(() => window.transferState());
  await page.evaluate(() => window.changeReason("warehouse_issue"));
  assert.deepEqual(await page.evaluate(() => window.transferState()), original);
  assert.equal(await page.getByRole("alertdialog").count(), 0);
});

test("Escape and backdrop dismissal obey cancelable and never confirm", async () => {
  await page.evaluate(() => {
    window.confirmed = 0;
    window.dismissed = 0;
    window.ask = (cancelable) =>
      window.Alert.alert(
        "Confirm?",
        "Details",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Confirm", onPress: () => window.confirmed++ },
        ],
        { cancelable, onDismiss: () => window.dismissed++ },
      );
    window.ask(false);
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("alertdialog").count(), 1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => window.ask(true));
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  await page.evaluate(() => window.ask(true));
  await page.mouse.click(1, 1);
  assert.deepEqual(
    await page.evaluate(() => [window.confirmed, window.dismissed]),
    [0, 2],
  );
});

test("actual sign-out flow offers Review and requires both destructive confirmations", async () => {
  const signOutCode = compile(read("src/queue/useGuardedSignOut.ts"));
  await page.addScriptTag({
    content: `(() => {
    const exports = {};
    window.signedOut = 0; window.routes = [];
    const require = name => ({
      react: { useCallback: fn => fn },
      '@/lib/alert': { Alert: window.Alert },
      'expo-router': { useRouter: () => ({ push: route => window.routes.push(route) }) },
      '@/hooks/useAuth': { useAuth: () => ({ signOut: () => window.signedOut++ }) },
      './QueueProvider': { useQueue: () => ({ hasUnsynced: true, snapshot: { jobs: [{ status: 'pending' }] } }) },
    })[name];
    ${signOutCode}
    window.askSignOut = exports.useGuardedSignOut();
  })();`,
  });
  await page.evaluate(() => window.askSignOut());
  assert.equal(
    await page.getByRole("alertdialog").getByRole("button").count(),
    3,
  );
  await page.getByRole("button", { name: "Review", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.routes), [
    "/(queue)/dead-letter",
  ]);
  await page.evaluate(() => window.askSignOut());
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => window.signedOut), 0);
  await page.evaluate(() => window.askSignOut());
  await page
    .getByRole("button", { name: "Sign out anyway", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.signedOut), 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => window.signedOut), 0);
  await page.evaluate(() => window.askSignOut());
  await page
    .getByRole("button", { name: "Sign out anyway", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard & sign out", exact: true })
    .click();
  assert.equal(await page.evaluate(() => window.signedOut), 1);
});

test("queued alerts stay separate and callbacks fire only once", async () => {
  await page.evaluate(() => {
    window.presses = 0;
    window.Alert.alert("First", "", [
      { text: "Continue", onPress: () => window.presses++ },
    ]);
    window.Alert.alert("Second");
    const button = document.querySelector("dialog button");
    button.click();
    button.click();
  });
  assert.equal(await page.evaluate(() => window.presses), 1);
  assert.equal(
    await page.getByRole("alertdialog", { name: "Second" }).count(),
    1,
  );
  await page.getByRole("button", { name: "OK", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog").count(), 0);
});

test("focus starts on Cancel, stays in the dialog, and returns to the opener", async () => {
  await page.locator("#opener").focus();
  await page.evaluate(() =>
    window.Alert.alert("Delete?", "Keep the safe choice focused", [
      { text: "Delete", style: "destructive" },
      { text: "Cancel", style: "cancel" },
    ]),
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.textContent),
    "Cancel",
  );
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    assert.notEqual(
      await page.evaluate(() => document.activeElement.id),
      "opener",
    );
  }
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "opener");
});

test("text is escaped and long messages fit a narrow viewport", async () => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() =>
    window.Alert.alert(
      "<img src=x onerror=alert(1)>",
      "Long message\n".repeat(80),
    ),
  );
  assert.equal(await page.locator("dialog img").count(), 0);
  const bounds = await page.getByRole("alertdialog").boundingBox();
  assert(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.width <= 360 &&
      bounds.height <= 640,
  );
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("promise-based delivery confirmation resolves on confirm, cancel, and dismiss", async () => {
  const source = ts.createSourceFile(
    "New.tsx",
    read("src/screens/deliveries/New.tsx"),
    99,
    true,
    ts.ScriptKind.TSX,
  );
  const fn = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "confirmAsync",
  );
  assert(fn);
  await page.addScriptTag({
    content: `${compile(fn.getText(source))}\nwindow.confirmAsync = confirmAsync;`,
  });
  for (const action of ["Cancel", "Escape", "Create anyway"]) {
    await page.evaluate(() => {
      window.answer = "waiting";
      window
        .confirmAsync("Possible duplicate", "Create another?", "Create anyway")
        .then((value) => (window.answer = value));
    });
    if (action === "Escape") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: action, exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.answer),
      action === "Create anyway",
    );
  }
});

test(
  "exported app resolves the web alert module and displays an alert from the login screen",
  {
    skip: !process.env.ALERT_TEST_WEB_BUILD,
  },
  async () => {
    const root = fileURLToPath(new URL("../mobile/dist/", import.meta.url));
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".ttf": "font/ttf",
      ".png": "image/png",
    };
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const file = resolve(root, `.${pathname}`);
      if (!file.startsWith(resolve(root) + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      try {
        res.setHeader(
          "Content-Type",
          mime[extname(file)] ?? "application/octet-stream",
        );
        res.end(readFileSync(file));
      } catch {
        res.setHeader("Content-Type", "text/html");
        res.end(readFileSync(resolve(root, "index.html")));
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Only serve the local build. This test never signs in or sends reset emails.
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    try {
      await page.goto(`${origin}/login`);
      await page.getByText("Forgot password?", { exact: true }).click();
      await page
        .getByRole("button", { name: "Send link", exact: true })
        .click();
      const dialog = page.getByRole("alertdialog", { name: "Email required" });
      await dialog.waitFor();
      assert.match(
        await dialog.textContent(),
        /Enter the email you sign in with/,
      );
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      assert.equal(await page.getByRole("alertdialog").count(), 0);
    } finally {
      await page.unroute("**/*");
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  },
);
