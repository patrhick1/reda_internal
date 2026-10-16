// Executes the real formatter and actual admin/rep Share callbacks. Framework,
// loaded report data and OS sharing are mocked; no message is sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(
  new URL("../../mobile/package.json", import.meta.url),
);
const ts = require("typescript");
const root = new URL("../../mobile/", import.meta.url);
const cache = new Map();
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
function load(name) {
  assert(
    name.startsWith("@/lib/"),
    `Unexpected pure-module dependency: ${name}`,
  );
  if (!cache.has(name)) {
    const exports = {};
    cache.set(name, exports);
    vm.runInNewContext(
      compile(readFileSync(new URL(`src/${name.slice(2)}.ts`, root), "utf8")),
      { exports, Date, Intl, Map, Set, require: load },
    );
  }
  return cache.get(name);
}
const { clientShareFormat, clientShareShowsPhone, buildClientShareMessage } =
  load("@/lib/reconcile");
const altior = "0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc";
const karami = "2acf7d84-3a5c-4532-b47c-568b7f4928f3";
const decency = "88398fcc-d4f7-4b5b-a16e-53ce5c463cf3";
const line = {
  customerName: "TEST recipient",
  clientRep: "ORD-TEST-001",
  products: [{ name: "Hair Removal Cream", qty: 2 }],
  paid: 26000,
  redaFee: 4000,
  remit: 22000,
  note: "—",
  paymentMethod: "transfer",
  outstanding: 0,
};
const account = {
  balanceBeforePeriod: 2000,
  periodActivity: 22000,
  payoutsInPeriod: 7000,
  paymentsInPeriod: 0,
  currentBalance: 17000,
};
const message = (rows = [line], options = {}) =>
  buildClientShareMessage({
    clientName: "Altior Essentials",
    rangeLabel: "15 October 2026",
    rows,
    account,
    format: clientShareFormat(altior),
    ...options,
  });

test("Altior opts into the existing paid-and-fee layout by stable client ID", () => {
  assert.equal(clientShareFormat(altior), "paidAndFee");
  assert.equal(clientShareShowsPhone(altior), false);
  assert.equal(clientShareFormat(karami), "paidAndFee");
  assert.equal(clientShareFormat(decency), "paidFeeAndRemit");
  for (const id of [null, undefined, "unknown"])
    assert.equal(clientShareFormat(id), "default");
});
test("Altior adds recorded payment and fee while preserving order references, units and ledger totals", () => {
  const before = structuredClone({ line, account });
  const text = message();
  assert(text.includes("Customer paid: ₦26,000\nDelivery fee: ₦4,000"));
  assert(!text.includes("\nTo Remit:"));
  assert(text.includes("Note: ORD-TEST-001 —"));
  assert(text.includes("Hair Removal Cream: 2"));
  assert(
    text.includes(
      "Today's remittance: ₦22,000\nPrevious balance: ₦2,000\nAlready paid today: ₦7,000\nReda remits client: ₦17,000",
    ),
  );
  assert.deepEqual(
    { line, account },
    before,
    "Presentation must not mutate financial input",
  );
});
test("the footer remains byte-identical to the existing default format", () => {
  const footer = (text) => text.slice(text.indexOf("\n\nTotal\n"));
  assert.equal(
    footer(message()),
    footer(message([line], { format: "default" })),
  );
});
test("cash POS fees and multi-product quantities retain existing behavior", () => {
  const text = message(
    [
      {
        ...line,
        paymentMethod: "cash",
        cashPosFee: 500,
        remit: 21500,
        products: [
          { name: "Cream", qty: 2 },
          { name: "Device", qty: 1 },
        ],
      },
    ],
    { account: null },
  );
  assert(
    text.includes(
      "Customer paid: ₦26,000\nDelivery fee: ₦4,000\nCash POS fee: ₦500",
    ),
  );
  assert(text.includes("Products:\nCream ×2\nDevice ×1"));
  assert(text.includes("Total\nCream: 2\nDevice: 1\nTo Remit: ₦21,500"));
});
test("vendor-direct payment retains its note and existing negative remittance", () => {
  const text = message(
    [{ ...line, paid: 0, remit: -4000, paymentMethod: "vendor_direct" }],
    {
      account: {
        ...account,
        periodActivity: -4000,
        currentBalance: -4000,
        payoutsInPeriod: 0,
      },
    },
  );
  assert(text.includes("Customer paid: ₦0\nDelivery fee: ₦4,000"));
  assert(text.includes("Note: ORD-TEST-001 — Paid to vendor"));
  assert(text.includes("Client owes Reda: ₦4,000"));
});
test("other clients keep their existing line layouts", () => {
  const other = message([line], { format: clientShareFormat("other") });
  assert(other.includes("To Remit: ₦22,000"));
  assert(!other.includes("Delivery fee:"));
  const decencyMessage = message([line], {
    format: clientShareFormat(decency),
  });
  assert(
    decencyMessage.includes(
      "Customer paid: ₦26,000\nDelivery fee: ₦4,000\nTo remit: ₦22,000",
    ),
  );
});

async function shareFromActualScreen(role) {
  const elements = [],
    messages = [];
  const row = {
    delivery_id: "test-order",
    scheduled_date: "2026-10-15",
    order_type: "delivery",
    customer_name: line.customerName,
    customer_phone: null,
    client_rep: line.clientRep,
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
  const reportAccount = {
    is_initialized: true,
    balance_before_period: 2000,
    period_activity: 22000,
    payouts_in_period: 7000,
    payments_in_period: 0,
    current_balance: 17000,
  };
  const hookData = [[row], reportAccount, [], []];
  const jsx = (type, props) => {
    const e = { type, props };
    elements.push(e);
    return e;
  };
  const mocks = {
    react: { useMemo: (f) => f(), useCallback: (f) => f },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      ...Object.fromEntries(
        ["ActivityIndicator", "FlatList", "RefreshControl", "Text", "View"].map(
          (n) => [n, n],
        ),
      ),
      Share: { share: async ({ message }) => messages.push(message) },
    },
    "expo-router": {
      useLocalSearchParams: () => ({
        id: altior,
        name: "Altior Essentials",
        from: "2026-10-15",
        to: "2026-10-15",
      }),
      useRouter: () => ({ back: () => {} }),
    },
    "@/hooks/useAsync": {
      useAsync: () => ({
        data: hookData.shift(),
        loading: false,
        error: null,
        reload: () => {},
      }),
    },
    "@/hooks/useReloadOnFocus": { useReloadOnFocus: () => {} },
    "@/lib/financial-refresh": { useFinancialRevision: () => 0 },
    "@/lib/theme": { colors: {}, fonts: {} },
    "@/lib/alert": { Alert: {} },
    "@/lib/errors": { errorMessage: String },
    "@/services/reconciliation": {},
    "@/components/ClientReportShare": { ClientReportShare: "ClientReportShare" },
    "@/components/ui": Object.fromEntries(
      ["AppBar", "Button", "Card", "Empty"].map((n) => [n, n]),
    ),
  };
  const exports = {};
  vm.runInNewContext(
    compile(
      readFileSync(
        new URL(`app/(${role})/reconcile/client/[id].tsx`, root),
        "utf8",
      ),
    ),
    { exports, Date, Map, Set, require: (name) => mocks[name] ?? load(name) },
  );
  exports.default();
  const reportShare = elements.find((e) => e.type === "ClientReportShare");
  if (reportShare) {
    assert(!reportShare.props.disabled && !reportShare.props.loadError);
    return load("@/lib/share-report").reportText(reportShare.props.buildReport());
  }
  const button = elements.find(
    (e) => e.type === "Button" && e.props.children === "Share with client",
  );
  assert(
    button && !button.props.disabled,
    "The actual Share action is available",
  );
  await button.props.onPress();
  assert.equal(messages.length, 1);
  return messages[0];
}
test("acceptance: admin and rep Share with client produce the same approved Altior message", async () => {
  const admin = await shareFromActualScreen("admin");
  const rep = await shareFromActualScreen("rep");
  assert.equal(admin, rep);
  assert.equal(admin, message());
  assert(admin.includes("Customer paid: ₦26,000\nDelivery fee: ₦4,000"));
});
