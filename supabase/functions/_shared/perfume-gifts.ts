import type { LineItem, ProductMatch } from './product-extract.ts';

// Stable ID: Original Buy was renamed Zael NG. Never scope this by display name.
export const PERFUME_VENDOR_ID = '2740824b-4f65-4901-abd5-6635aec0f044';
export const PERFUME_GIFT_POLICY = 'zael-bundled-gifts-v2';
export type ProductResolution = { line: LineItem; match: ProductMatch | null; candidates: ProductMatch[] };
type Gift = { product_name: string; quantity: number };
const normalize = (name: string) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The same approved perfumes as v1, keyed by stable catalog identity. Display
// name changes must not disable an already approved product's gift policy.
const mainIds = new Set([
  '125334f2-d69a-4431-8356-47b15687a7d5', // Opulent Oud
  'cff5cf56-bf06-4990-b0a3-615d78c8e3e6', // Khamrah Dukhan
  'd36c6537-3d12-40ac-b14d-aaf46c805932', // Pacific Blue
  '3d914f96-7f61-4189-b994-a6414bed6234', // Khamrah Waha
  'dd338e48-cb5a-4f75-998a-89c63205a9be', // 9pm Rebel
  '3a7302fd-d886-4023-a437-d230b7326496', // 9pm Night Out
  'd36f1982-79b3-4096-9580-9c199615d9c3', // Opulent Dubai
  '6ab31a65-bf24-48ff-ac04-42de6f635e3b', // Suavage Deor
  '0e2a402f-d940-4eda-879a-9c1fb3c14e4e', // Kingsman
  '2e407b83-e00e-4e2b-9137-48fedfc2ac0e', // Aswad (Black) Edition
  '58ed5caf-a6a8-47a6-a492-5d7b1f4b6157', // Midnight (Blue) Edition
  'ac7b6acc-05b1-4291-94eb-c65f5cb1fc29', // Armaf Club de Nuit Intense
  '60866728-da10-4292-b1a7-420b24c67978', // Armaf Club de Nuit Urban Man
  'af413a21-ebe2-4c62-9f88-e1fd35a257a2', // Oud Stallion
  'a7a32ced-e3db-41d0-8506-35361726eb5c', // Oud Maracuja
  '86a1bc6c-a094-4efa-a230-893475038039', // Tubereuse Astrale
  '9af28720-b281-4f3e-a119-8837490aa099', // Club De Nuit Sillage
  '67f486ef-d7c5-4934-8f54-4916abda42df', // Oud Al Layl
  '2c8c2d37-8612-41ad-91bc-c56cdd90dd31', // Midnight Blue Single
  '5bd093a5-fbf8-4c8c-b6ac-7b5fff32fcb5', // Oud Al Layl Aswad
]);
const regularOud = '67f486ef-d7c5-4934-8f54-4916abda42df';
function sameProduct(name: string, match: ProductMatch): boolean {
  const n = normalize(name);
  if (n === normalize(match.product_name ?? '')) return true;
  // Verified old/new names belong to these exact SKUs. Keep other variants
  // (especially Aswad and different bottle sizes) in review, even if fuzzy
  // matching selected this product. Do not loosen the general matcher.
  if (match.id === regularOud) {
    return n === 'oud al layl perfume'
      || /^oud al layl brown (single|double|triple) with oil$/.test(n)
      || /^arabiyat oud al layl edp(?: 100 ?ml)?(?: perfume)?(?: for men and women)?$/.test(n);
  }
  return match.id === 'd36c6537-3d12-40ac-b14d-aaf46c805932'
    && (n === 'pacific blue perfume' || n === 'maison alhambra pacific blue edp');
}
function accessory(name: string, raw: string): string | null {
  const n = normalize(name);
  if (/^(touch )?perfume oils?$/.test(n)) return 'Perfume Oil';
  if (/^touch concentrated perfume oils?(?: 5 ?ml)?(?: alcohol free)?$/.test(n)) return 'Perfume Oil';
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
    && mainIds.has(r.match.id)
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
