import type { BotInboundRow } from '@/services/bot';

/** A single product candidate (SKU) the matcher considered. */
export type ProductCandidate = {
  id: string;
  client_id: string;
  client_name: string;
  product_name: string;
  score: number;
};

/** [Feature A] one extracted order line + its SKU match + considered candidates. */
export type ProductMatch = {
  line?: { quantity?: number; product_name?: string; customer_price?: number | null };
  matched?: ProductCandidate | null;
  candidates?: ProductCandidate[];
};

/** parse_result shape we care about. The bot writes more than this; we type
 *  only the fields the review-fix screen actually surfaces. */
export type ParseResultShape = {
  source?: string;
  address?: {
    confidence?: string | null;
    matched_location_id?: string | null;
  };
  // Legacy single-product keys (rows parsed before Feature A, 2026-06-16).
  product?: {
    id?: string;
    client_id?: string;
    client_name?: string;
    product_name?: string;
    score?: number;
  } | null;
  product_candidates?: ProductCandidate[];
  // [Feature A] per-line matches — the bot now ALWAYS self-extracts products[],
  // so this is the live shape for every bot row; `product`/`product_candidates`
  // above are only present on pre-Feature-A rows.
  product_matches?: ProductMatch[];
  extracted?: {
    quantity?: number; // legacy single-product
    customer_price?: number; // legacy single-product
    total_amount?: number; // [Feature A] order total
    products?: Array<{ quantity?: number; product_name?: string; customer_price?: number | null }>;
    raw_address?: string;
    instructions?: string | null;
    product_name?: string;
    customer_name?: string;
    customer_phone?: string;
  };
  agent_hint?: string | null;
  client_hint?: string | null;
  location_hint?: string | null;
  agent_resolution?: {
    reason?: string;
    agent_id?: string | null;
  };
};

/** The fix-review form is single-line. Surface the FIRST product line, reading
 *  the Feature-A multi-product shape (`product_matches[0]`) and falling back to
 *  the legacy single-product keys for rows parsed before 2026-06-16. `lineCount`
 *  lets the screen warn when an order has more lines than the form can hold. */
export function primaryProduct(parse: ParseResultShape): {
  clientId: string | null;
  productCatalogId: string | null;
  quantity: number | null;
  candidates: ProductCandidate[];
  matched: boolean;
  lineCount: number;
} {
  const matches = parse.product_matches ?? [];
  const first = matches[0];
  const matched = first?.matched ?? null;
  const legacyQty = typeof parse.extracted?.quantity === 'number' ? parse.extracted.quantity : null;
  return {
    clientId: matched?.client_id ?? parse.product?.client_id ?? null,
    productCatalogId: matched?.id ?? parse.product?.id ?? null,
    quantity: first?.line?.quantity ?? parse.extracted?.products?.[0]?.quantity ?? legacyQty,
    candidates: first?.candidates ?? parse.product_candidates ?? [],
    matched: !!(matched ?? parse.product),
    lineCount: matches.length || (parse.product || parse.extracted?.product_name ? 1 : 0),
  };
}

/** Order total for the delivery. Feature A: `extracted.total_amount`; falls back
 *  to the first line price, then the legacy single `extracted.customer_price`. */
export function primaryPrice(parse: ParseResultShape): number | null {
  const e = parse.extracted ?? {};
  if (typeof e.total_amount === 'number') return e.total_amount;
  const lineProduct = e.products?.[0]?.customer_price;
  if (typeof lineProduct === 'number') return lineProduct;
  if (typeof e.customer_price === 'number') return e.customer_price;
  return null;
}

/** Human-readable, non-technical one-liner describing why a row is in
 *  Needs Review. Used as the subtitle on the review-fix screen and as the
 *  hint badge on the list card. */
export function reviewReason(row: BotInboundRow): string {
  const p = (row.parse_result ?? {}) as ParseResultShape;
  const noLocation = !p.address?.matched_location_id;
  const prod = primaryProduct(p);
  const candidates = prod.candidates;
  const ambiguousProduct = !prod.matched && candidates.length > 1;

  if (ambiguousProduct) {
    const clients = Array.from(new Set(candidates.map((c) => c.client_name))).slice(0, 2);
    if (clients.length >= 2) {
      return `Two clients carry "${p.extracted?.product_name ?? candidates[0]?.product_name ?? 'this product'}" — pick the right one.`;
    }
    return 'The bot saw more than one matching product — pick the right one.';
  }
  if (noLocation && p.location_hint) {
    return `"${p.location_hint}" isn't in the catalog yet — pick the closest match or leave Location empty.`;
  }
  if (noLocation) {
    return `We couldn't match the address. Pick the closest location, or leave it empty.`;
  }
  return 'Fill in what the bot missed, then create the delivery.';
}

/** Split a customer_phone string like "08036... or 08150..." into the first
 *  number and any alternate. Returns the original as `primary` and null
 *  alternate when there's no " or "/" / "-separator. */
export function splitPhone(raw: string | null | undefined): {
  primary: string;
  alternate: string | null;
} {
  if (!raw) return { primary: '', alternate: null };
  const splitters = [/\s+or\s+/i, /\s*\/\s*/];
  for (const re of splitters) {
    const parts = raw
      .split(re)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return { primary: parts[0]!, alternate: parts[1]! };
    }
  }
  return { primary: raw.trim(), alternate: null };
}
