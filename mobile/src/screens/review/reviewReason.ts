import type { BotInboundRow } from '@/services/bot';

/** parse_result shape we care about. The bot writes more than this; we type
 *  only the fields the review-fix screen actually surfaces. */
export type ParseResultShape = {
  source?: string;
  address?: {
    confidence?: string | null;
    matched_location_id?: string | null;
  };
  product?: {
    id?: string;
    client_id?: string;
    client_name?: string;
    product_name?: string;
    score?: number;
  } | null;
  extracted?: {
    quantity?: number;
    raw_address?: string;
    product_name?: string;
    customer_name?: string;
    customer_phone?: string;
    customer_price?: number;
  };
  agent_hint?: string | null;
  client_hint?: string | null;
  location_hint?: string | null;
  agent_resolution?: {
    reason?: string;
    agent_id?: string | null;
  };
  product_candidates?: Array<{
    id: string;
    client_id: string;
    client_name: string;
    product_name: string;
    score: number;
  }>;
};

/** Human-readable, non-technical one-liner describing why a row is in
 *  Needs Review. Used as the subtitle on the review-fix screen and as the
 *  hint badge on the list card. */
export function reviewReason(row: BotInboundRow): string {
  const p = (row.parse_result ?? {}) as ParseResultShape;
  const noLocation = !p.address?.matched_location_id;
  const candidates = p.product_candidates ?? [];
  const ambiguousProduct = !p.product && candidates.length > 1;

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
