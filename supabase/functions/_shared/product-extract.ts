// _shared/product-extract.ts
// ---------------------------------------------------------------------------
// Multi-product line-item extraction — the SINGLE source of truth shared by
// the study bot (mybot-parse-message) and the live intake (bot-parse-message).
//
// WHY THIS EXISTS
// The study bot already proved an array-shaped extraction: one WhatsApp message
// (one customer, one address) -> many product line items. Feature A wires that
// same logic into live intake. The mybot code carries an explicit warning that
// a silent divergence between single- and multi-product matching corrupts data;
// factoring the schema + coercion + disambiguation here means both bots compute
// line items identically — there is one place to change, and no second copy to
// drift. (Ported verbatim from mybot-parse-message/index.ts:72-208.)
//
// GOLDEN INVARIANT: per-line customer_price is record-keeping only. It never
// feeds fee math — Reda's charge + agent pay stay per-delivery by location.
//
// This module is PURE (no I/O, no Supabase client). The HTTP call to OpenRouter
// and the per-line match_products_by_text RPC stay in each function's handler;
// this file owns the prompt, schema, types, coercion, and match disambiguation.
// ---------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any

// OpenAI-strict-style JSON schema. OpenRouter passes this through to providers
// that support strict structured outputs; for those that don't it degrades to
// plain json_object, so stripJsonFences() below stays as a safety net.
//   - Every property listed in `properties` is also in `required`.
//   - `additionalProperties: false` on every object.
//   - Nullable fields use the `[T, "null"]` union, not `nullable: true`.
export const PRODUCT_EXTRACTION_SCHEMA = {
  name:   'reda_extraction',
  strict: true,
  schema: {
    type:                 'object',
    additionalProperties: false,
    required: ['customer_name', 'customer_phone', 'customer_phone_alt', 'raw_address', 'instructions', 'client_rep', 'total_amount', 'products'],
    properties: {
      customer_name:      { type: ['string',  'null'] },
      customer_phone:     { type: ['string',  'null'] },
      customer_phone_alt: { type: ['string',  'null'] },
      raw_address:        { type: ['string',  'null'] },
      instructions:       { type: ['string',  'null'] },
      client_rep:         { type: ['string',  'null'] },
      total_amount:       { type: ['number',  'null'] },
      products: {
        type:  'array',
        items: {
          type:                 'object',
          additionalProperties: false,
          required: ['product_name', 'quantity', 'customer_price', 'free'],
          properties: {
            product_name:   { type: ['string',  'null'] },
            quantity:       { type: ['integer', 'null'] },
            customer_price: { type: ['number',  'null'] },
            free:           { type: 'boolean' },
          },
        },
      },
    },
  },
} as const;

export const PRODUCT_EXTRACTION_PROMPT = `You are extracting a delivery order from a WhatsApp message that a Reda client forwarded.

A message contains one customer with one delivery address, but may contain multiple products (typically one per line, sometimes with a Total line at the bottom).

Return strict JSON with these fields (use null when missing):
  customer_name    : string  — the recipient's name. If the message has no name, use the customer_phone digits as the customer_name instead of returning null. Only return null if BOTH a name and a phone are missing.
  customer_phone   : string  — Nigerian phone, keep digits and optional leading 0/+234
  customer_phone_alt : string — a SECOND, distinct customer phone if the message lists one (e.g. "or call 0…", a second contact line). Phone numbers only — NEVER a bank/transfer/account number. null if there is only one number.
  raw_address      : string  — the delivery address, free-form, as-is from the message
  instructions     : string  — a SPECIAL DELIVERY/HANDLING note for the agent ONLY: how to reach the customer or hand over the order. Examples: "use the side gate", "call on arrival", "ask for the gateman", "don't ring the bell", "deliver after 5pm", "landmark: opposite the blue church". Return null when there is no such note. Do NOT put the address, the product, the price, the customer name/phone, or a payment instruction here — those belong in their own fields. Most messages have NO instruction → null.
  client_rep       : string  — the name of the CLIENT'S OWN SALES REP / CLOSER who forwarded this order, when the message ends with one. It is the person's name at the VERY END of the message, after the product/availability lines — NOT the customer. It usually appears on its own trailing line, often after an availability note or wrapped in parentheses or after an emoji. Examples: a final line "👤 Available for delivery Linda" → "Linda"; a trailing "(Cynthia)" → "Cynthia"; "Available... reach me on WhatsApp\n\n(Tola)" → "Tola". Return ONLY the bare human name (strip "Available for delivery", emojis, brackets, phone numbers). This name is NEVER the customer_name (that's at the top) and is NEVER a product or place. Most messages have no trailing rep name → null.
  total_amount     : number  — the "Total(X)" amount if present in the message, otherwise null
  products         : array   — one entry per DISTINCT product the customer receives, in the order they appear:
    {
      product_name   : string  — the CLEAN product name ONLY (apply the normalization rules below)
      quantity       : integer — total units of this product the customer receives, INCLUDING any free units; default 1 if implied
      customer_price : number  — the subtotal for this product line (the parenthesized amount), null if missing
      free           : boolean — true ONLY when the message explicitly marks THIS product as free/bonus/gift/complimentary — a giveaway the customer is NOT paying for ("1 Free Nose Trimmer", "+ a FREE perfume", "bonus sachet"). false for every normal product the customer pays for. NOTE: the bonus units of a "Buy N Get M FREE" of the SAME product are NOT a separate free line (rule 2 folds them into the one paid line, free:false) — "free" is only for a DISTINCT giveaway product.
    }

PRODUCT-NAME NORMALIZATION — return the real catalog product, never the marketing wrapper:
  1. Strip promo/tier LABELS. "Gold Package", "Standard Package", "VIP Package", "Bronze/Silver/Premium", "Combo", "Deal", "Offer", "Bundle" are price tiers, NOT products. The real product is the item named inside the offer.
  2. "Buy N <Product> Get M FREE" (same product) -> ONE line: product = <Product>, quantity = N + M.
       "Buy 2 Water Filter Get 1 FREE"                      -> [{product_name:"Water Filter", quantity:3}]
       "Gold Package - Buy 2 Fire Stop Spray Get 1 FREE"    -> [{product_name:"Fire Stop Spray", quantity:3}]
  3. "Set of <X> including N (FREE) <Y>" / "<X> with N free <Y>" / "<X> <qty> + M FREE <Y>" -> TWO lines (different products); the bonus <Y> is the giveaway, so free:true on it. CRITICAL: each line carries ONLY its OWN stated quantity — do NOT add the free product's count onto the main product. The main product's quantity is whatever the message states for IT alone (default 1). The "+ M FREE <Y>" describes <Y>, never <X>:
       "1 Set of OUD AL LAYL including 2 FREE Perfume Oil"  -> [{product_name:"Oud Al Layl", quantity:1, free:false},{product_name:"Perfume Oil", quantity:2, free:true}]
       "1 Pack of Shaving Device + 1 Free Nose Trimmer"     -> [{product_name:"Shaving Device", quantity:1, free:false},{product_name:"Nose Trimmer", quantity:1, free:true}]
       "A520 TWS Earbuds 1 PCS + 1 FREE Digital Bracelet"   -> [{product_name:"A520 TWS Earbuds", quantity:1, free:false},{product_name:"Digital Bracelet", quantity:1, free:true}]   (NOT earbuds quantity:2 — the free bracelet is a separate line, it does NOT raise the earbuds count)
  4. Strip quantities, prices, currency, and packaging/filler words ("Pack of", "Set of", "bottle(s)", "sachet", "tube", "carton", "piece(s)", "(One)", "units", "x2", parenthetical totals) from product_name — keep only the REAL product. A bare container/unit word ("bottle", "pack", "sachet") is NEVER the product; the product name often comes AFTER the quantity/container, and an "=price" may follow it.
       "1 Pack Of Double Arabian Tea"                       -> {product_name:"Double Arabian Tea", quantity:1}
       "1 bottle for a start Stand again=18500"             -> {product_name:"Stand again", quantity:1, customer_price:18500}
  5. Keep genuinely distinct products as separate lines.
       "1 Pack Arabian Tea Powder Mix and 1 Pack Double Arabian Tea" -> two lines.
  6. KNOWN 2-PRODUCT BUNDLE: "Opulent X Khamrah" (also written "Opulent Z Khamrah", "Opulent X Khakrah", "Opulent Oud X Khamrah Dukhan") is a bundle of TWO products, not one. Expand it to two lines — {product_name:"Opulent Oud", quantity:N} and {product_name:"Khamrah Dukhan", quantity:N}, where N is the bundle's quantity (default 1).
       "1 Opulent X Khamrah" -> [{product_name:"Opulent Oud", quantity:1},{product_name:"Khamrah Dukhan", quantity:1}]
       EXCEPTION — do NOT double-count: if the SAME message also spells out "Opulent Oud" and "Khamrah Dukhan" as their own line items (e.g. a header "OPULENT X KHAMRAH ORDER ..." followed by a body "1 OPULENT OUD + 1 KHAMRAH DUKHAN + ..."), then the "Opulent X Khamrah" text is just the order title — ignore it and use ONLY the itemized lines.

Do NOT include the Total line as a product. Do NOT invent products that aren't in the message.
Ignore order-reference / SKU-header lines — a product code or order label such as "OUD AL LAYL BROWN SINGLE WITH OIL 2246-U" or "OPULENT ORDER 252-O" is metadata, not a product line.
"FREE DELIVERY" / "FREE SHIPPING" is NOT a product — exclude it. A free PRODUCT (e.g. "FREE PACIFIC BLUE PERFUME") IS a product line: include it with quantity, free:true, and customer_price 0.

Message:
"""
{{TEXT}}
"""`;

export type LineItem = {
  product_name:   string | null;
  quantity:       number | null;
  customer_price: number | null;
  // true when the message marks this line as a free gift/bonus the customer
  // isn't paying for. The caller uses this (NOT customer_price) to decide that
  // an unmatched line is a droppable freebie vs a real product → needs_review.
  free:           boolean;
};

export type ExtractedProducts = {
  customer_name:      string | null;
  customer_phone:     string | null;
  customer_phone_alt: string | null;
  raw_address:        string | null;
  instructions:       string | null;
  // The client's own sales rep / closer named at the END of the forward (NOT the
  // customer). Optional — null on most orders. Captured for reconciliation so a
  // follow-up to the client can address the rep who placed the order.
  client_rep:         string | null;
  total_amount:       number | null;
  products:           LineItem[];
};

// --- defensive coercion -----------------------------------------------------
// Even with response_format=json_schema, providers may emit "55,000" as a
// string or wrap output in markdown fences. Coerce so a degraded response
// doesn't poison downstream consumers.

export function toStr(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return String(v);
}

export function toNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[,_₦\s]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function toInt(v: any): number | null {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

export function coerceLineItem(v: any): LineItem | null {
  if (!v || typeof v !== 'object') return null;
  const name = toStr(v.product_name)?.trim() || null;
  if (!name) return null; // drop items without a product name — not useful as line items
  return {
    product_name:   name,
    quantity:       toInt(v.quantity),
    customer_price: toNum(v.customer_price),
    free:           v.free === true,
  };
}

export function coerceExtractedProducts(obj: any): ExtractedProducts | null {
  if (!obj || typeof obj !== 'object') return null;
  const products: LineItem[] = Array.isArray(obj.products)
    ? obj.products.map(coerceLineItem).filter((li: LineItem | null): li is LineItem => li !== null)
    : [];
  return {
    customer_name:      toStr(obj.customer_name),
    customer_phone:     toStr(obj.customer_phone),
    customer_phone_alt: toStr(obj.customer_phone_alt),
    raw_address:        toStr(obj.raw_address),
    instructions:       toStr(obj.instructions)?.trim() || null,
    client_rep:         toStr(obj.client_rep)?.trim() || null,
    total_amount:       toNum(obj.total_amount),
    products,
  };
}

// Some models wrap their answer in markdown code fences even with
// response_format set — strip them before JSON.parse. No-op on clean JSON.
export function stripJsonFences(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json|jsonc)?\s*\n?/i, '');
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

// --- deterministic trailing-rep fallback ------------------------------------
// client_rep is normally extracted by the LLM (it also reliably returns null on
// the MANY messages that carry no trailing rep — something a regex can't judge,
// which is why we don't run this as a backstop on the LLM path). This is the
// fallback for the ONE path where the LLM isn't called at all: a contractor
// payload that's complete enough to skip extraction.
//
// We match ONLY the explicit, high-context "Available for delivery <Name>" tail
// — that phrase itself announces a PERSON. We deliberately do NOT accept a lone
// parenthesised token like "(Cynthia)": structurally it is identical to a place,
// a landmark or a note — "(Ikorodu)", "(Chevron)", "(Monday)" — and no regex can
// tell a name from those. The LLM (the normal path) disambiguates that with
// context; this best-effort fallback stays conservative and skips it, accepting
// that it will miss a bare "(Name)" rather than mis-store a place as a rep.
const REP_STOPWORDS = new Set([
  'available', 'delivery', 'whatsapp', 'please', 'call', 'pay', 'paid', 'transfer',
  'account', 'address', 'phone', 'number', 'customer', 'product', 'order', 'total',
  'free', 'lagos', 'thanks', 'thank',
]);

function repNameOrNull(s: string): string | null {
  const t = s.trim().replace(/[).,:;]+$/, '').replace(/^[(.\-•·\s]+/, '').trim();
  if (!t) return null;
  const words = t.split(/\s+/);
  if (words.length < 1 || words.length > 2) return null;
  for (const w of words) {
    if (!/^[A-Z][a-zA-Z'’-]+$/.test(w)) return null; // Title-case alpha, no digits/symbols
    if (REP_STOPWORDS.has(w.toLowerCase())) return null;
  }
  return words.join(' ');
}

/** Best-effort trailing rep/closer name from the raw message. Scans the last few
 *  lines bottom-up for the single high-context "Available for delivery <Name>"
 *  shape. Returns null when nothing clean is found (the common case). */
export function extractTrailingRep(rawText: string | null | undefined): string | null {
  if (!rawText) return null;
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    // Only the "Available for delivery <Name>" tail (any leading emoji/bullet is
    // fine — the phrase is matched anywhere in the line). Capture 1–2 alpha words
    // right after the phrase; repNameOrNull then enforces a clean Title-case name.
    const avail = lines[i].match(
      /available\s+for\s+delivery\s*:?\s*([A-Za-z][A-Za-z'’-]+(?:\s+[A-Za-z][A-Za-z'’-]+)?)/i,
    );
    if (avail) { const n = repNameOrNull(avail[1]); if (n) return n; }
  }
  return null;
}

// --- known multi-SKU combos -------------------------------------------------
// A few catalog products were SPLIT into separate SKUs (e.g. "Oratox Capsule" +
// "Oratox Powder"), but clients still order the SET as one line ("Oratox
// Capsule and Powder ... 1 unit"). The LLM is inconsistent about splitting that
// into two line items, so it often records only ONE variant — the other never
// leaves stock and is missing from the client's delivery report.
//
// expandKnownCombos deterministically forces the two member SKUs whenever the
// RAW message (the one signal the LLM can't silently drop) contains the combo
// phrase. It is a TIGHT allowlist anchored on the exact base name + BOTH variant
// words joined by and/&/+/,/slash — it NEVER generic-splits on "and"/"/", so it
// cannot touch another client's product (e.g. "D&N Arabian Tea", "Wine
// Opener/Beer Opener") and leaves a single-variant order (just "Oratox Capsule",
// no "...and powder") untouched. Each canonical part name matches its SKU at 1.0.
type KnownCombo = { rx: RegExp; belongsTo: RegExp; parts: [string, string] };

const COMBO_SEP = String.raw`\s*(?:and|&|\+|/|,)\s*`;
const COMBO_GAP = String.raw`[ \t.\-]*`;
function comboRx(base: string, v1: string, v2: string): RegExp {
  // base immediately followed (small gap) by the two variant words in EITHER
  // order, joined by a separator — kept tight so it can't span unrelated lines.
  return new RegExp(
    String.raw`\b${base}\b${COMBO_GAP}(?:\b${v1}\b${COMBO_SEP}\b${v2}\b|\b${v2}\b${COMBO_SEP}\b${v1}\b)`,
    'i',
  );
}

export const KNOWN_COMBOS: KnownCombo[] = [
  {
    rx: comboRx('oratox', 'capsule', 'powder'),
    belongsTo: /\boratox\b/i,
    parts: ['Oratox Capsule', 'Oratox Powder'],
  },
  {
    rx: comboRx('clovofresh', 'capsule', 'spray'),
    belongsTo: /\bclovofresh\b/i,
    parts: ['Clovofresh Capsule', 'Clovofresh Spray'],
  },
];

/** If the raw message contains a known combo phrase, replace whatever the LLM
 *  produced for that product with EXACTLY its two member SKUs (carrying the
 *  combo line's quantity; price on line 1 only — record-keeping, fees are
 *  per-delivery). Lines for other products pass through untouched. Idempotent:
 *  if the LLM already split into the two variants, they're dropped and re-added,
 *  so there's no duplication. */
export function expandKnownCombos(products: LineItem[], rawText: string): LineItem[] {
  let out = products;
  for (const combo of KNOWN_COMBOS) {
    if (!combo.rx.test(rawText ?? '')) continue;
    const mine = out.filter((p) => p.product_name && combo.belongsTo.test(p.product_name));
    if (mine.length === 0) continue;
    const qty = Math.max(1, ...mine.map((m) => (m.quantity && m.quantity > 0 ? m.quantity : 1)));
    const price = mine.find((m) => m.customer_price != null)?.customer_price ?? null;
    const free = mine.every((m) => m.free === true);
    out = out.filter((p) => !mine.includes(p));
    out.push(
      { product_name: combo.parts[0], quantity: qty, customer_price: price, free },
      { product_name: combo.parts[1], quantity: qty, customer_price: null, free },
    );
  }
  return out;
}

// --- per-line match disambiguation -----------------------------------------
// Identical rules to today's single-product matcher, applied PER line item so
// multi-product rows behave exactly like single-product rows:
//   - exactly one candidate wins;
//   - if every candidate is the same client, the top-scored wins;
//   - else the top wins only if it leads the runner-up by >= 0.15 score;
//   - otherwise null -> the caller routes that line to needs_review.
// `candidates` is the result of match_products_by_text for ONE line, assumed
// sorted by descending score (as the RPC returns them). The RPC's row shape is
// TABLE(id uuid, client_id uuid, client_name text, product_name text, score real)
// — so `id` IS the product_catalog_id of the matched SKU.
export type ProductMatch = {
  id:           string;   // product_catalog_id of the matched SKU
  client_id:    string;
  client_name?: string;
  product_name?: string;
  score:        number;
};

export function pickMatch(candidates: ProductMatch[]): ProductMatch | null {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  const top = candidates[0];
  const sameClient = candidates.every((m) => m.client_id === top.client_id);
  if (sameClient) return top;
  if ((candidates[1]?.score ?? 0) + 0.15 <= top.score) return top;
  return null;
}

// Build the jsonb-compatible items array for bot_create_delivery(p_items) /
// _delivery_items_sig from matched lines. Caller supplies each line's resolved
// product_catalog_id (from pickMatch); unmatched lines should NOT be passed
// here — they force the whole order to needs_review upstream.
export type ResolvedItem = {
  product_catalog_id: string;
  quantity_ordered:   number;
  customer_price?:    number | null;
};

export function buildItemsPayload(
  lines: Array<{ match: ProductMatch | null; line: LineItem }>,
): ResolvedItem[] {
  const items: ResolvedItem[] = [];
  for (const { match, line } of lines) {
    if (!match) continue; // unmatched -> handled as needs_review by caller
    items.push({
      product_catalog_id: match.id,   // match_products_by_text returns the catalog id as `id`
      quantity_ordered:   line.quantity && line.quantity > 0 ? line.quantity : 1,
      customer_price:     line.customer_price ?? null,
    });
  }
  return items;
}
