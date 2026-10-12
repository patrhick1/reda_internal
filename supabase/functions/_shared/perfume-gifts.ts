import type { LineItem, ProductMatch } from './product-extract.ts';

// Stable ID: Original Buy was renamed Zael NG. Never scope this by display name.
export const PERFUME_VENDOR_ID = '2740824b-4f65-4901-abd5-6635aec0f044';
export const PERFUME_GIFT_POLICY = 'zael-bundled-gifts-v1';
export type ProductResolution = { line: LineItem; match: ProductMatch | null; candidates: ProductMatch[] };
type Gift = { product_name: string; quantity: number };
const normalize = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Explicitly approved canonical identities. New variants safely remain in review.
const mainNames = new Set(['Opulent Oud', 'Khamrah Dukhan', 'Pacific Blue Perfume',
  'Khamrah Waha', '9pm Rebel', '9pm Night Out', 'Opulent Dubai', 'Suavage Deor',
  'Kingsman', 'Aswad (Black) Edition', 'Midnight (Blue) Edition',
  'Armaf Club de Nuit Intense', 'Armaf Club de Nuit Urban Man', 'Oud Stallion',
  'Oud Maracuja', 'Tubereuse Astrale', 'Club De Nuit Sillage', 'Oud Al Layl Perfume',
  'Midnight Blue Single', 'Oud Al Layl Aswad'].map(normalize));
const regularOud = '67f486ef-d7c5-4934-8f54-4916abda42df';
function sameProduct(name: string, match: ProductMatch): boolean {
  if (normalize(name) === normalize(match.product_name ?? '')) return true;
  // These are the catalog's explicit Brown bundle aliases, not fuzzy variants.
  return match.id === regularOud && /^oud al layl brown (single|double|triple) with oil$/.test(normalize(name));
}
function accessory(name: string, raw: string): string | null {
  const n = normalize(name);
  if (/^(touch )?perfume oils?$/.test(n)) return 'Perfume Oil';
  if (/^(perfume )?atomizers?$/.test(n)) return 'Atomizer';
  // Bare Oil cannot be allowed to match a bottle of perfume. Only explicit
  // source wording can disambiguate it; otherwise the caller forces review.
  if (/^oils?$/.test(n) && /\bperfume\s+oils?\b/i.test(raw)) return 'Perfume Oil';
  return null;
}

export function applyPerfumeGiftPolicy(input: ProductResolution[], raw: string) {
  const rows = input.map(r => ({ ...r, line: { ...r.line } }));
  const ignored: Gift[] = [];
  const reviewReasons: string[] = [];
  // Require at least one confidently resolved paid perfume before applying any
  // vendor-specific rule. A gift/unknown product cannot establish the vendor.
  const anchor = rows.some(r => !r.line.free && r.match?.client_id === PERFUME_VENDOR_ID
    && mainNames.has(normalize(r.match.product_name ?? ''))
    && sameProduct(r.line.product_name ?? '', r.match)
    && !accessory(r.line.product_name ?? '', raw));
  const vendorSeen = rows.some(r => r.match?.client_id === PERFUME_VENDOR_ID
    || r.candidates.some(c => c.client_id === PERFUME_VENDOR_ID));
  if (!vendorSeen) return { rows, ignored, reviewReasons, applied: false };

  for (const r of rows) {
    const name = r.line.product_name ?? '';
    const gift = accessory(name, raw);
    // A positive line price takes precedence over a contradictory LLM free flag.
    if (gift && Number(r.line.customer_price) > 0) r.line.free = false;
    if (anchor && gift && !(Number(r.line.customer_price) > 0)) {
      // Preserve malformed quantities for review rather than invent packing counts.
      if (!Number.isInteger(r.line.quantity) || (r.line.quantity ?? 0) <= 0) {
        reviewReasons.push('Confirm the included gift quantity.');
        r.match = null;
        continue;
      }
      ignored.push({ product_name: gift, quantity: r.line.quantity! });
      continue;
    }
    if (/^oils?$/.test(normalize(name)) && r.match?.client_id === PERFUME_VENDOR_ID) {
      r.match = null;
      reviewReasons.push('Oil is ambiguous; confirm the gift or product instead of booking perfume stock.');
    }
  }
  const kept = rows.filter(r => !(anchor && accessory(r.line.product_name ?? '', raw)
    && !(Number(r.line.customer_price) > 0) && Number.isInteger(r.line.quantity) && (r.line.quantity ?? 0) > 0));
  if (ignored.length) {
    // Review used to catch fuzzy wrong variants. Do not remove that protection
    // merely because the gifts are now understood. Free matched products also
    // affect stock, so their identities must be sound.
    for (const r of kept) {
      if (r.match?.client_id !== PERFUME_VENDOR_ID || !sameProduct(r.line.product_name ?? '', r.match)) {
        if (r.match || !r.line.free) reviewReasons.push('Confirm the main perfume variant before automatic creation.');
      }
      if (r.line.free && r.match) reviewReasons.push('Confirm whether the additional free product should affect stock.');
    }
    const ids = kept.filter(r => r.match).map(r => r.match!.id);
    if (new Set(ids).size !== ids.length) reviewReasons.push('The main perfume appears more than once; confirm the quantity.');
  }
  return { rows: kept, ignored, reviewReasons: [...new Set(reviewReasons)], applied: ignored.length > 0 };
}

export function giftPackingInstructions(instructions: string | null, gifts: Gift[]): string | null {
  if (!gifts.length) return instructions;
  const counts = new Map<string, number>();
  for (const g of gifts) counts.set(g.product_name, (counts.get(g.product_name) ?? 0) + g.quantity);
  return [instructions, `Included gifts: ${[...counts].map(([n, q]) => `${n} ×${q}`).join(', ')}.`].filter(Boolean).join('\n');
}
