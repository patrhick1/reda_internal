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
  customerName: string | null;
  /** Every product on the delivery. Multi-product orders carry N entries — the
   *  reconcile RPC's per-item breakdown, not the collapsed legacy single line. */
  products: ShareProduct[];
  /** What Reda remits the client for this delivery (net of Reda fee). */
  remit: number;
  note: string;
  /** How the customer paid: 'cash' | 'transfer' | 'vendor_direct'. Drives the
   *  client-facing "Paid:" line. Optional/nullable: legacy rows (and the rep RPC
   *  before its passthrough columns land) omit it, in which case no Paid line
   *  and no Cash/Transfer total breakdown is emitted. */
  paymentMethod?: string | null;
  /** ₦500 when the customer paid cash (passed through to / absorbed by the
   *  client), 0 otherwise. Drives the per-delivery "POS charge:" line and the
   *  Total "POS charges (already deducted):" line. */
  cashPosFee?: number | null;
};

/** Client-facing label for a delivery's payment method. Returns null for an
 *  unknown / legacy-null method so the caller omits the line entirely rather
 *  than print "Paid: ". */
function paymentMethodLabel(method: string | null | undefined): string | null {
  switch (method) {
    case 'cash':
      return 'Cash';
    case 'transfer':
      return 'Transfer';
    case 'vendor_direct':
      return 'Direct to vendor';
    default:
      return null;
  }
}

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

// Builds the WhatsApp "Share with client" message in Uzo's preferred shape:
// per-delivery blocks (Name / Product(s) / Paid / [POS charge] / To Remit /
// Note), then a Total block (delivered units per product, a remit breakdown by
// payment method, the POS charges already deducted, and the single remit
// total), closing with the thank-you line. Reda's own fee never appears — only
// client-facing numbers (how the customer paid, the ₦500 POS pass-through, the
// remit). The payment lines self-omit when the row lacks payment_method, so a
// caller without that data still produces the original fee-free shape.
export function buildClientShareMessage(input: {
  clientName: string;
  rangeLabel: string;
  rows: ShareDeliveryLine[];
}): string {
  const blocks = input.rows.map((r) => {
    const lines = [`Name: ${r.customerName ?? 'Customer'}`, ...shareProductLines(r.products)];
    const method = paymentMethodLabel(r.paymentMethod);
    if (method) lines.push(`Paid: ${method}`);
    const pos = Number(r.cashPosFee ?? 0);
    if (pos > 0) lines.push(`POS charge: ${formatNaira(pos)}`);
    lines.push(`To Remit: ${formatNaira(Number(r.remit ?? 0))}`, `Note: ${r.note}`);
    return lines.join('\n');
  });

  const byProduct = new Map<string, number>();
  for (const r of input.rows) {
    for (const p of r.products) byProduct.set(p.name, (byProduct.get(p.name) ?? 0) + p.qty);
  }
  const productLines = [...byProduct.entries()].map(([name, qty]) => `${name}: ${qty}`);
  const totalRemit = input.rows.reduce((s, r) => s + Number(r.remit ?? 0), 0);

  // Remit broken down by how the customer paid. Only shown when EVERY row carries
  // a known method — a partial breakdown (some rows method-less) wouldn't sum to
  // the To Remit total and would mislead. Fixed order so the message is stable.
  const methodTotals = new Map<string, number>();
  let posTotal = 0;
  let allMethodsKnown = input.rows.length > 0;
  for (const r of input.rows) {
    const method = paymentMethodLabel(r.paymentMethod);
    if (method) methodTotals.set(method, (methodTotals.get(method) ?? 0) + Number(r.remit ?? 0));
    else allMethodsKnown = false;
    posTotal += Number(r.cashPosFee ?? 0);
  }
  const methodLines = allMethodsKnown
    ? ['Cash', 'Transfer', 'Direct to vendor']
        .filter((m) => methodTotals.has(m))
        .map((m) => `${m}: ${formatNaira(methodTotals.get(m) ?? 0)}`)
    : [];
  const posLine = posTotal > 0 ? [`POS charges (already deducted): ${formatNaira(posTotal)}`] : [];

  const header = `Reda Logistics — ${input.clientName}\n${input.rangeLabel}`;
  const body = input.rows.length === 0 ? '(no deliveries in this range)' : blocks.join('\n\n');
  const totalBlock = [
    'Total',
    ...productLines,
    ...methodLines,
    ...posLine,
    `To Remit: ${formatNaira(totalRemit)}`,
  ].join('\n');

  return `${header}\n\n${body}\n\n\n${totalBlock}\n\n\nThank you for choosing REDA 🥂`;
}
