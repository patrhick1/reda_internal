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

// Auto-fill a delivery's report Note from data we already have:
//   • short delivery   → "1 of 2 delivered"
//   • customer balance → "balance ₦X" (customer ↔ vendor; informational)
// "—" when there's nothing notable, so the Note: line is never blank.
export function deriveDeliveryNote(input: {
  quantityOrdered: number | null | undefined;
  quantityDelivered: number | null | undefined;
  /** customer_price − paid for this delivery. */
  outstanding: number | null | undefined;
}): string {
  const ordered = Number(input.quantityOrdered ?? 0);
  const delivered = Number(input.quantityDelivered ?? 0);
  const outstanding = Number(input.outstanding ?? 0);
  const parts: string[] = [];
  if (ordered > 0 && delivered < ordered) parts.push(`${delivered} of ${ordered} delivered`);
  if (outstanding > 0.005) parts.push(`balance ${formatNaira(outstanding)}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export type ShareDeliveryLine = {
  customerName: string | null;
  productName: string | null;
  quantityDelivered: number | null;
  /** What Reda remits the client for this delivery (net of Reda fee). */
  remit: number;
  note: string;
};

// Builds the WhatsApp "Share with client" message in Uzo's preferred shape:
// per-delivery blocks (Name / Product / Qty / To Remit / Note), then a Total
// block (delivered units per product + the single remit total), closing with
// the thank-you line. Fee figures never appear — only client-facing numbers.
export function buildClientShareMessage(input: {
  clientName: string;
  rangeLabel: string;
  rows: ShareDeliveryLine[];
}): string {
  const blocks = input.rows.map((r) =>
    [
      `Name: ${r.customerName ?? 'Customer'}`,
      `Product: ${r.productName ?? 'Product'}`,
      `Qty: ${r.quantityDelivered ?? 0}`,
      `To Remit: ${formatNaira(Number(r.remit ?? 0))}`,
      `Note: ${r.note}`,
    ].join('\n'),
  );

  const byProduct = new Map<string, number>();
  for (const r of input.rows) {
    const name = r.productName ?? 'Product';
    byProduct.set(name, (byProduct.get(name) ?? 0) + Number(r.quantityDelivered ?? 0));
  }
  const productLines = [...byProduct.entries()].map(([name, qty]) => `${name}: ${qty}`);
  const totalRemit = input.rows.reduce((s, r) => s + Number(r.remit ?? 0), 0);

  const header = `Reda Logistics — ${input.clientName}\n${input.rangeLabel}`;
  const body = input.rows.length === 0 ? '(no deliveries in this range)' : blocks.join('\n\n');
  const totalBlock = ['Total', ...productLines, `To Remit: ${formatNaira(totalRemit)}`].join('\n');

  return `${header}\n\n${body}\n\n\n${totalBlock}\n\n\nThank you for choosing REDA 🥂`;
}
