// Shared reconcile helpers used by both the admin reconcile screens and the
// rep client-update screens. Centralising the date-range presets, the
// per-delivery Note derivation and the "Share with client" message builder
// keeps a single source of truth for the client-facing report format — the
// rep variant must produce byte-identical output to the admin one.
import { daysAgoLagos, todayLagos, yesterdayLagos } from '@/lib/date';
import { formatNaira } from '@/lib/format';

export type Preset = 'today' | 'yesterday' | 'last7' | 'custom';

export function presetRange(p: Preset): { from: string; to: string } | null {
  switch (p) {
    case 'today':
      return { from: todayLagos(), to: todayLagos() };
    case 'yesterday':
      return { from: yesterdayLagos(), to: yesterdayLagos() };
    case 'last7':
      return { from: daysAgoLagos(6), to: todayLagos() };
    case 'custom':
      return null;
  }
}

export function detectPreset(from: string, to: string): Preset {
  const today = todayLagos();
  const yesterday = yesterdayLagos();
  const last7 = daysAgoLagos(6);
  if (from === today && to === today) return 'today';
  if (from === yesterday && to === yesterday) return 'yesterday';
  if (from === last7 && to === today) return 'last7';
  return 'custom';
}

// Auto-fill a delivery's report Note. When the customer bought FEWER units than
// the order quantity, state what they actually bought ("Bought 1"). A delivered
// order is final — there is NO balance/outstanding concept (the customer paid for
// what they took; nothing is owed and nothing is collected later). "—" when they
// bought the full quantity, so the Note line is never blank.
export function deriveDeliveryNote(input: {
  quantityOrdered: number | null | undefined;
  quantityDelivered: number | null | undefined;
}): string {
  const ordered = Number(input.quantityOrdered ?? 0);
  const delivered = Number(input.quantityDelivered ?? 0);
  if (ordered > 0 && delivered < ordered) return `Bought ${delivered}`;
  return '—';
}

/** One delivered product line. `qty` is units delivered. */
export type ShareProduct = { name: string; qty: number };

export type ShareDeliveryLine = {
  /** 'waybill' rows are client charges, not customer/product deliveries. */
  orderType?: string | null;
  customerName: string | null;
  /** Client's own sales rep / closer captured from the forwarded order. */
  clientRep?: string | null;
  /** Every product on the delivery. Multi-product orders carry N entries — the
   *  reconcile RPC's per-item breakdown, not the collapsed legacy single line. */
  products: ShareProduct[];
  /** What Reda remits the client for this delivery (net of Reda fee). */
  remit: number;
  note: string;
  /** How the customer paid: 'cash' | 'transfer' | 'vendor_direct'. Cash is the
   *  only method called out in the client-facing message. */
  paymentMethod?: string | null;
  /** Cash POS fee. Not shown in the default format; the paidAndFee format lists
   *  it (when non-zero) so paid − delivery fee − POS fee reconciles to the row's
   *  remit and the footer total. */
  cashPosFee?: number | null;
  /** [paidAndFee format] What the customer actually paid (= paid). Admin-only —
   *  populated on the admin share path; the rep path omits it (its RPC strips
   *  paid/fee), so the rep never produces this format. */
  paid?: number | null;
  /** [paidAndFee format] Reda's per-delivery delivery fee (= reda_fee / charged
   *  snapshot). Admin-only, same as `paid`. */
  redaFee?: number | null;
};

/** Normalize a reconcile row into share-ready product lines: prefer the RPC's
 *  per-item `products` array; fall back to the legacy single product for rows
 *  with none. Shared so the on-screen display and the share message agree. */
export function remitRowProducts(row: {
  products?: { product_name: string | null; quantity_delivered: number | null }[] | null;
  product_name?: string | null;
  quantity_delivered?: number | null;
}): ShareProduct[] {
  const items = row.products ?? [];
  if (items.length > 0) {
    return items.map((p) => ({
      name: p.product_name ?? 'Product',
      qty: Number(p.quantity_delivered ?? 0),
    }));
  }
  return [{ name: row.product_name ?? 'Product', qty: Number(row.quantity_delivered ?? 0) }];
}

/** Total ordered + delivered units across a reconcile row's products — for the
 *  short-delivery Note. Sums the per-item breakdown (multi-product safe) so a
 *  partial multi-product order reports accurately, instead of the legacy
 *  aggregate columns (primary-line ordered vs cross-item-summed delivered, which
 *  describe different things). Falls back to the legacy columns for rows with no
 *  products array. */
export function remitRowQuantities(row: {
  products?: { quantity_ordered?: number | null; quantity_delivered: number | null }[] | null;
  quantity_ordered?: number | null;
  quantity_delivered?: number | null;
}): { ordered: number; delivered: number } {
  const items = row.products ?? [];
  if (items.length > 0) {
    return {
      ordered: items.reduce((s, p) => s + Number(p.quantity_ordered ?? 0), 0),
      delivered: items.reduce((s, p) => s + Number(p.quantity_delivered ?? 0), 0),
    };
  }
  return {
    ordered: Number(row.quantity_ordered ?? 0),
    delivered: Number(row.quantity_delivered ?? 0),
  };
}

/** On-screen product summary for a reconcile row, e.g. "Gallant Max · 5 units"
 *  (single) or "Antivirus Cleanser ×2, Gallant Max ×5" (multi). */
export function remitProductsDisplay(products: ShareProduct[]): string {
  const [first] = products;
  if (!first) return '—';
  if (products.length === 1) return `${first.name} · ${first.qty} units`;
  return products.map((p) => `${p.name} ×${p.qty}`).join(', ');
}

/** Per-delivery product lines for the share message. Keeps the familiar
 *  "Product: X / Qty: N" pair for single-product orders (the common case) and
 *  switches to a bulleted "Products:" list when there's more than one. */
function shareProductLines(products: ShareProduct[]): string[] {
  // Single product (the common case) keeps the familiar two-line shape. `products`
  // is always non-empty in practice (remitRowProducts guarantees ≥1), but guard
  // the [0] read defensively rather than emit a "Product: Product" placeholder.
  if (products.length <= 1) {
    const p = products[0];
    return p ? [`Product: ${p.name}`, `Qty: ${p.qty}`] : ['Product: —'];
  }
  return ['Products:', ...products.map((p) => `- ${p.name} ×${p.qty}`)];
}

/** Prefix a delivery Note with the client's rep when one was captured.
 *  Examples: "Linda —" and "Linda — Bought 1". Older rows retain the
 *  existing note unchanged. */
export function clientShareNote(clientRep: string | null | undefined, note: string): string {
  const rep = clientRep?.trim();
  if (!rep) return note;
  return note === '—' ? `${rep} —` : `${rep} — ${note}`;
}

// ---------------------------------------------------------------------------
// Moniepoint bulk-payout CSV. Uzo downloads this at EOD and uploads it to the
// Moniepoint bulk-transfer screen to pay every vendor in one batch. Columns and
// order match Moniepoint's official template EXACTLY (Bulk-transfer-template.xlsx):
//   Account Name, Account Number, Amount, Bank
// The `Bank` value must be a name Moniepoint recognises — the client form picks
// it from MONIEPOINT_BANKS, so by the time a row reaches here it's already valid.
// ---------------------------------------------------------------------------

/** Whether a vendor can be paid via the bulk Moniepoint / Kuda files, from their
 *  stored bank details:
 *    - `complete` — all three fields set; ready to pay, appears in the file.
 *    - `none`     — no bank details at all. Most clients collect remittance
 *                   through their own system, so this is deliberate, NOT an error:
 *                   the vendor is left off the payout files silently, never listed
 *                   as "missing".
 *    - `partial`  — some but not all fields set; a genuine data-entry slip that IS
 *                   surfaced so an admin can complete or clear it.
 *  Shared by the Moniepoint and Kuda builders so both classify vendors identically. */
export type BankDetailStatus = 'complete' | 'partial' | 'none';

export function bankDetailStatus(
  c:
    | {
        bank_account_name?: string | null;
        bank_account_number?: string | null;
        bank_name?: string | null;
      }
    | null
    | undefined,
): BankDetailStatus {
  const filled = [c?.bank_account_name, c?.bank_account_number, c?.bank_name].filter(
    (v) => v != null && String(v).trim() !== '',
  ).length;
  if (filled === 0) return 'none';
  if (filled === 3) return 'complete';
  return 'partial';
}

/** One beneficiary line for the Moniepoint bulk-transfer file. Callers pass only
 *  vendors with complete bank details and a positive payout. */
export type MoniepointPayoutRow = {
  accountName: string;
  accountNumber: string;
  amount: number;
  bank: string;
};

const MONIEPOINT_CSV_HEADERS = ['Account Name', 'Account Number', 'Amount', 'Bank'] as const;

/** RFC-4180 cell escaping with CSV-injection hardening. Quotes + doubles inner
 *  quotes when the value contains a comma, quote, or newline (account names can
 *  contain commas, e.g. "X, Y Ltd"); and prefixes a leading =/+/-/@ with a
 *  single quote so a spreadsheet app can't interpret the cell as a formula. */
function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Plain numeric amount for a payout CSV — no currency symbol or thousands
 *  separators (the bank importer parses the raw number). Whole naira stays
 *  integer; kobo keeps 2dp. Shared by the Moniepoint and Kuda builders. */
function payoutAmount(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/** Build the Moniepoint bulk-transfer CSV from already-validated payout rows.
 *  Header row + CRLF line endings (what spreadsheet/upload parsers expect). */
export function buildMoniepointPayoutCsv(rows: MoniepointPayoutRow[]): string {
  const lines = [MONIEPOINT_CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.accountName),
        csvCell(r.accountNumber),
        payoutAmount(r.amount),
        csvCell(r.bank),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

// The Kuda bulk-payout export is an .xlsx (Kuda's official template format) —
// see lib/kuda-export.ts (buildKudaPayoutXlsx). It lives in its own module
// because it pulls in the SheetJS workbook writer, which this pure helper file
// (also used by the rep screens) should not carry.

export type ClientShareFormat = 'default' | 'paidAndFee';

// Per-client override for the "Share with client" report format. Only Karami
// wants the per-delivery "Customer paid" + "Delivery fee" breakdown today; every
// other client uses the default net-remit layout. Keyed by client id (stable
// across renames). 'paidAndFee' reveals Reda's delivery fee, so it is ONLY ever
// selected on the admin share path — reps must never see the fee (their RPC
// strips paid/fee). To add a client: drop their id here (flip to a clients
// column if this list ever grows).
const CLIENT_SHARE_FORMAT: Record<string, ClientShareFormat> = {
  '2acf7d84-3a5c-4532-b47c-568b7f4928f3': 'paidAndFee', // Karami
};

/** The share-message format for a client (default when unmapped). */
export function clientShareFormat(clientId: string | null | undefined): ClientShareFormat {
  return (clientId && CLIENT_SHARE_FORMAT[clientId]) || 'default';
}

// Builds the WhatsApp "Share with client" message in Uzo's preferred shape:
// Delivery rows use Name / Product(s) / Paid: Cash / To Remit / Note (default)
// or Name / Product(s) / Customer paid / Delivery fee / Note (paidAndFee).
// Pickup and waybill rows instead use Type / Charge to client / deduction note,
// because they are client charges rather than customer deliveries. The Total
// block keeps delivered units, surfaces waybill charges, and states who owes whom.
export function buildClientShareMessage(input: {
  clientName: string;
  rangeLabel: string;
  rows: ShareDeliveryLine[];
  /** Per-delivery layout. 'default' shows the net "To Remit"; 'paidAndFee' shows
   *  "Customer paid" + "Delivery fee" (Karami). Admin-only — see
   *  ShareDeliveryLine.paid. Defaults to 'default'. */
  format?: ClientShareFormat;
}): string {
  const format = input.format ?? 'default';
  const blocks = input.rows.map((r) => {
    if (r.orderType === 'waybill') {
      // Uzo's format: the charge-side breakdown only (type fee + each pickup
      // extra), printed verbatim from the stored note — no header or total.
      // Fall back to a single "<type> ₦total" line if the note is missing.
      const breakdown = (r.note ?? '').trim();
      return (
        breakdown ||
        `${r.customerName ?? 'Pickup / Waybill'} ${formatNaira(Math.abs(Number(r.remit ?? 0)))}`
      );
    }
    const lines = [`Name: ${r.customerName ?? 'Customer'}`, ...shareProductLines(r.products)];
    if (format === 'paidAndFee') {
      // Karami's format: show what the customer paid and Reda's delivery fee
      // instead of the net remit. The cash POS fee (when any) is listed too so
      // paid − fee − POS reconciles to the same total the footer shows.
      lines.push(
        `Customer paid: ${formatNaira(Number(r.paid ?? 0))}`,
        `Delivery fee: ${formatNaira(Number(r.redaFee ?? 0))}`,
      );
      if (Number(r.cashPosFee ?? 0) > 0) {
        lines.push(`Cash POS fee: ${formatNaira(Number(r.cashPosFee))}`);
      }
    } else {
      if (r.paymentMethod === 'cash') lines.push('Paid: Cash');
      lines.push(`To Remit: ${formatNaira(Number(r.remit ?? 0))}`);
    }
    lines.push(`Note: ${clientShareNote(r.clientRep, r.note)}`);
    return lines.join('\n');
  });

  const byProduct = new Map<string, number>();
  for (const r of input.rows) {
    if (r.orderType === 'waybill') continue;
    for (const p of r.products) byProduct.set(p.name, (byProduct.get(p.name) ?? 0) + p.qty);
  }
  const productLines = [...byProduct.entries()].map(([name, qty]) => `${name}: ${qty}`);
  const totalRemit = input.rows.reduce((s, r) => s + Number(r.remit ?? 0), 0);
  const waybillCharges = input.rows
    .filter((r) => r.orderType === 'waybill')
    .reduce((s, r) => s + Math.abs(Number(r.remit ?? 0)), 0);
  const hasWaybill = waybillCharges > 0;
  const balanceLine = !hasWaybill
    ? `To Remit: ${formatNaira(totalRemit)}`
    : totalRemit >= 0
      ? `Reda remits client: ${formatNaira(totalRemit)}`
      : `Client owes Reda: ${formatNaira(Math.abs(totalRemit))}`;

  const header = `Reda Logistics — ${input.clientName}\nDelivered Update\n${input.rangeLabel}`;
  const body = input.rows.length === 0 ? '(no deliveries in this range)' : blocks.join('\n\n');
  const totalBlock = [
    'Total',
    ...productLines,
    ...(waybillCharges > 0 ? [`Pickup / waybill charges: ${formatNaira(waybillCharges)}`] : []),
    balanceLine,
  ].join('\n');

  return `${header}\n\n${body}\n\n\n${totalBlock}\n\n\nThank you for choosing REDA 🥂`;
}
