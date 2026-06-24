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
  /** How the customer paid: 'cash' | 'transfer' | 'vendor_direct'. Cash is the
   *  only method called out in the client-facing message. */
  paymentMethod?: string | null;
  /** Cash POS fee retained in the row shape for callers that use the same
   *  reconciliation data elsewhere. It is not shown in the share message. */
  cashPosFee?: number | null;
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

// Builds the WhatsApp "Share with client" message in Uzo's preferred shape:
// per-delivery blocks (Name / Product(s) / Paid: Cash when applicable /
// To Remit / Note), then a Total block (delivered units per product and the
// single remit total), closing with the thank-you line. Transfer methods and
// POS fees are deliberately omitted because clients already know those details.
export function buildClientShareMessage(input: {
  clientName: string;
  rangeLabel: string;
  rows: ShareDeliveryLine[];
}): string {
  const blocks = input.rows.map((r) => {
    const lines = [`Name: ${r.customerName ?? 'Customer'}`, ...shareProductLines(r.products)];
    if (r.paymentMethod === 'cash') lines.push('Paid: Cash');
    lines.push(`To Remit: ${formatNaira(Number(r.remit ?? 0))}`, `Note: ${r.note}`);
    return lines.join('\n');
  });

  const byProduct = new Map<string, number>();
  for (const r of input.rows) {
    for (const p of r.products) byProduct.set(p.name, (byProduct.get(p.name) ?? 0) + p.qty);
  }
  const productLines = [...byProduct.entries()].map(([name, qty]) => `${name}: ${qty}`);
  const totalRemit = input.rows.reduce((s, r) => s + Number(r.remit ?? 0), 0);

  const header = `Reda Logistics — ${input.clientName}\n${input.rangeLabel}`;
  const body = input.rows.length === 0 ? '(no deliveries in this range)' : blocks.join('\n\n');
  const totalBlock = ['Total', ...productLines, `To Remit: ${formatNaira(totalRemit)}`].join('\n');

  return `${header}\n\n${body}\n\n\n${totalBlock}\n\n\nThank you for choosing REDA 🥂`;
}
