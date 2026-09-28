// Run: node tools/test-client-stock-share.mjs. Exercises the actual screen
// component and stock grouping; native UI, data hooks, and OS sharing are mocked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const requireMobile = createRequire(
  new URL("../mobile/package.json", import.meta.url),
);
const ts = requireMobile("typescript");
const read = (path) =>
  readFileSync(new URL(`../mobile/${path}`, import.meta.url), "utf8");
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
const stockSource = ts.createSourceFile(
  "stock.ts",
  read("src/services/stock.ts"),
  ts.ScriptTarget.Latest,
  true,
);
const groupNode = stockSource.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "groupByClient",
);
assert(groupNode, "actual stock grouping function exists");
const grouped = {};
runInNewContext(compile(groupNode.getText(stockSource)), { exports: grouped });
const screenCode = compile(read("src/screens/stock/ClientDetail.tsx"));
const catalog = [{ id: "empty", product_name: "Face Mask", is_active: true }];
const complete = (data) => ({
  data,
  loading: false,
  error: null,
  reload: async () => {},
});

function render(options = {}) {
  const messages = [];
  const refreshStates = [];
  let onFocus;
  const stock = options.stock ?? complete({ clientId: "vendor", rows: [] });
  const products = options.products ?? complete(catalog);
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (current) => ({ current }),
      useState: () => [
        options.refreshing ?? false,
        (value) => refreshStates.push(value),
      ],
    },
    "react-native": {
      ...Object.fromEntries(
        [
          "ActivityIndicator",
          "FlatList",
          "Pressable",
          "RefreshControl",
          "Text",
          "View",
        ].map((name) => [name, name]),
      ),
      Share: { share: async ({ message }) => messages.push(message) },
    },
    "expo-router": {
      useLocalSearchParams: () => ({ id: "vendor", name: "Test Vendor" }),
      useRouter: () => ({ back() {}, push() {} }),
    },
    "@/hooks/useAsync": { useAsync: () => stock },
    "@/hooks/useReloadOnFocus": { useReloadOnFocus: (fn) => (onFocus = fn) },
    "@/hooks/useCurrentUser": {},
    "@/hooks/useAuth": { useCurrentUser: () => ({ role: "admin" }) },
    "@/hooks/queries": { useActiveProductsByClient: () => products },
    "@/services/stock": { groupByClient: grouped.groupByClient },
    "@/components/ui": Object.fromEntries(
      ["AppBar", "Banner", "Button", "Card", "Empty", "Icon"].map((name) => [
        name,
        name,
      ]),
    ),
    "@/lib/permissions": { canViewGlobalStockHistory: () => true },
    "@/lib/theme": { colors: {}, fonts: {} },
    "@/lib/date": {
      todayLagos: () => "2026-09-28",
      formatDateLagos: (date) => date,
    },
  };
  const exports = {};
  runInNewContext(screenCode, {
    exports,
    require: (name) => {
      assert(name in modules, `expected dependency: ${name}`);
      return modules[name];
    },
  });
  const root = exports.ClientStockDetail();
  const elements = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    elements.push(node);
    visit(node.props?.children);
  }
  visit(root);
  return {
    messages,
    refreshStates,
    onFocus,
    share: elements.find(
      (node) => node.type === "Button" && node.props.icon === "share",
    ),
    list: elements.find((node) => node.type === "FlatList"),
    error: elements.find((node) => node.type === "Banner"),
  };
}

test("catalog arriving before stock cannot label unknown quantities or share them", async () => {
  const page = render({ stock: { ...complete(null), loading: true } });
  assert.equal(page.share.props.disabled, true);
  assert.equal(page.list.props.data.length, 0);
  await page.share.props.onPress();
  assert.equal(page.messages.length, 0);
});

test("stock and catalog errors remain visible and prevent sharing even with cached rows", async () => {
  for (const source of ["stock", "products"]) {
    const stock = complete({ clientId: "vendor", rows: [] });
    const products = complete(catalog);
    (source === "stock" ? stock : products).error = "Network unavailable";
    const page = render({ stock, products });
    assert.match(
      page.error.props.children,
      /Network unavailable.*Refresh before sharing/,
    );
    assert.equal(page.share.props.disabled, true);
    await page.share.props.onPress();
    assert.equal(page.messages.length, 0);
  }
});

test("catalog loading, refresh in progress, and another client’s stale stock disable sharing", async () => {
  for (const options of [
    { products: { ...complete(null), loading: true } },
    { refreshing: true },
    { stock: { ...complete({ clientId: "vendor", rows: [] }), loading: true } },
    { stock: complete({ clientId: "previous-vendor", rows: [] }) },
  ]) {
    const page = render(options);
    assert.equal(page.share.props.disabled, true);
    await page.share.props.onPress();
    assert.equal(page.messages.length, 0);
  }
});

test("successful empty stock shares active products as Out of stock", async () => {
  const page = render();
  assert.equal(page.share.props.disabled, false);
  await page.share.props.onPress();
  assert.match(page.messages[0], /Face Mask: Out of stock/);
});

test("share includes real quantities and zero stock but never inactive products", async () => {
  const row = (id, name, quantity, active) => ({
    client_id: "vendor",
    client_name: "Test Vendor",
    product_catalog_id: id,
    product_name: name,
    quantity_on_hand: quantity,
    is_active: active,
    user_role: "warehouse",
  });
  const page = render({
    stock: complete({
      clientId: "vendor",
      rows: [
        row("held", "Car Dent Puller", 9, true),
        row("retired", "Retired item", 7, false),
      ],
    }),
  });
  await page.share.props.onPress();
  assert.match(page.messages[0], /Car Dent Puller: 9/);
  assert.match(page.messages[0], /Face Mask: Out of stock/);
  assert.doesNotMatch(page.messages[0], /Retired item/);
});

test("pull refresh reloads both stock and catalog and waits for both", async () => {
  let stockDone;
  let catalogDone;
  let stockReloads = 0;
  let catalogReloads = 0;
  const stock = complete({ clientId: "vendor", rows: [] });
  const products = complete(catalog);
  stock.reload = () => {
    stockReloads++;
    return new Promise((resolve) => (stockDone = resolve));
  };
  products.reload = () => {
    catalogReloads++;
    return new Promise((resolve) => (catalogDone = resolve));
  };
  const page = render({ stock, products });
  page.list.props.refreshControl.props.onRefresh();
  assert.equal(stockReloads, 1);
  assert.equal(catalogReloads, 1);
  assert.deepEqual(page.refreshStates, [true]);
  stockDone();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(page.refreshStates, [true]);
  catalogDone();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(page.refreshStates, [true, false]);
});
