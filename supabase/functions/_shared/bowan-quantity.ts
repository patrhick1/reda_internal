import type { LineItem } from './product-extract.ts';

type QuantityLine = { key: string; quantity: number };

// Ignore formatting, the product-name prefix ("3 - SUCTION ..."), and the
// explicitly labelled gift when matching a paid line to its extracted name.
function productKey(name: string): string {
  return name.trim().replace(/^[-*•]\s*/, '')
    .replace(/^(?:details of products|products?)\s*:\s*/i, '')
    .replace(/^\d+\s*[-–]\s*/, '')
    .replace(/\s*\+\s*free\b.*$/i, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Explicit Bowan quantities outrank an extracted product-name prefix. Match
 * each paid product separately; never broadcast the first line's quantity. */
export function applyBowanQuantities(
  raw: string | null | undefined,
  items: LineItem[],
): LineItem[] {
  if (!raw || !/order\s*number\s*:/i.test(raw) || !/closer(?:\s+name)?\s*:/i.test(raw)) {
    return items;
  }
  const lines: QuantityLine[] = [];
  for (const text of raw.split(/\r?\n/)) {
    const pipe = text.match(
      /^\s*(.+?)\s*\|\s*(\d+)\s*\|\s*([\d,]+(?:\.\d{1,2})?)\s*\|\s*([\d,]+(?:\.\d{1,2})?)\s*$/,
    );
    const explicit = text.match(
      /^\s*(.+?)\s*[x×]\s*(\d+)\s*·\s*(?:NGN|₦|N)\s*([\d,]+(?:\.\d{1,2})?)\s*$/i,
    );
    const match = pipe ?? explicit;
    if (!match) continue;
    const quantity = Number(match[2]);
    const price = Number(match[3].replaceAll(',', ''));
    if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    if (pipe && Math.abs(price * quantity - Number(pipe[4].replaceAll(',', ''))) > 0.005) continue;
    const key = productKey(match[1]);
    if (key) lines.push({ key, quantity });
  }
  const matches = items.map((item) => {
    if (!item.product_name || item.free || item.customer_price === 0) return undefined;
    const key = productKey(item.product_name);
    const exact = lines.filter((line) => line.key === key);
    // Model output sometimes omits "Suction". Only accept a unique substantial
    // name match, and reject two extracted products competing for the same line.
    const candidates = exact.length
      ? exact
      : lines.filter((line) =>
        key.length >= 8 && line.key.length >= 8 &&
        (line.key.includes(key) || key.includes(line.key))
      );
    return candidates.length === 1 ? candidates[0] : undefined;
  });
  return items.map((item, i) => {
    const line = matches[i];
    return line && matches.filter((match) => match === line).length === 1
      ? { ...item, quantity: line.quantity }
      : item;
  });
}
