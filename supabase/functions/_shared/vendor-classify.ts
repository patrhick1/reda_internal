// Vendor disambiguation for shared product names.
//
// When two vendors sell a product with the SAME name, match_products_by_text
// returns candidates that span >1 client_id with near-tied scores, so pickMatch
// cannot pick a SKU (it returns null -> needs_review). Historically the
// contractor's `client_hint` broke the tie; once we run intake ourselves there is
// no hint, so we recover the vendor from HOW THE MESSAGE IS WRITTEN — each vendor
// has a recognisable message format. This module:
//   - isCrossVendorTie(pool)      detect exactly the "same name, different vendor"
//                                 case (NOT a genuine no-match, NOT a multi-line
//                                 bundle spanning vendors).
//   - vendorContenders(pool)      the distinct candidate vendors in contention.
//   - classifyVendor(text, cands) a second, small LLM call that picks the vendor
//                                 from few-shot examples, or returns null when the
//                                 styles don't clearly distinguish (never guesses).
//
// classifyVendor mirrors the OpenRouter call pattern in bot-parse-message's
// openrouterExtractProducts (same model, temperature 0, strict json_schema,
// 30s timeout, fence-strip + defensive coercion).

import { stripJsonFences, sanitizeMessageText, type ProductMatch } from './product-extract.ts';

export const VENDOR_CLASSIFIER_MODEL = 'openai/gpt-4.1-mini';
export const VENDOR_CLASSIFIER_VERSION = 'vendor-classify-v1-gpt-4.1-mini';
const REQUEST_TIMEOUT_MS = 30_000;

// A cross-vendor tie needs the top candidate to be a real match (>= floor) and
// the best OTHER-vendor candidate to sit within `band` of it — i.e. the top does
// not clearly out-score the rival vendor. `band` mirrors pickMatch's 0.15
// cross-client gate; `floor` keeps genuine no-matches (all low score) out.
export const CROSS_VENDOR_FLOOR = 0.45;
export const CROSS_VENDOR_BAND = 0.15;

export type CrossVendorOpts = { floor?: number; band?: number };

// True only for the "same product name, different vendor" ambiguity: the pool
// spans >= 2 client_ids and the top SKU does not clearly beat the best SKU from a
// different vendor. Assumes `pool` is sorted by descending score (as
// match_products_by_text returns it).
export function isCrossVendorTie(pool: ProductMatch[], opts: CrossVendorOpts = {}): boolean {
  const floor = opts.floor ?? CROSS_VENDOR_FLOOR;
  const band = opts.band ?? CROSS_VENDOR_BAND;
  if (!Array.isArray(pool) || pool.length < 2) return false;
  const top = pool[0];
  if (!top || top.score < floor) return false;
  const otherVendorBest = pool.find((m) => m.client_id !== top.client_id);
  if (!otherVendorBest) return false; // all one vendor -> not a cross-vendor case
  return otherVendorBest.score + band > top.score;
}

export type VendorContender = { client_id: string; client_name: string; best_score: number };

// The distinct vendors genuinely in contention: every client whose best-scoring
// SKU is >= floor AND within `band` of the pool's top score. These are the ones
// worth asking the classifier to choose between (usually exactly 2).
export function vendorContenders(pool: ProductMatch[], opts: CrossVendorOpts = {}): VendorContender[] {
  const floor = opts.floor ?? CROSS_VENDOR_FLOOR;
  const band = opts.band ?? CROSS_VENDOR_BAND;
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const topScore = pool[0].score;
  const byClient = new Map<string, VendorContender>();
  for (const m of pool) {
    if (m.score < floor) continue;
    if (m.score + band <= topScore) continue; // clearly beaten -> not a contender
    const prev = byClient.get(m.client_id);
    if (!prev || m.score > prev.best_score) {
      byClient.set(m.client_id, {
        client_id: m.client_id,
        client_name: m.client_name ?? '',
        best_score: m.score,
      });
    }
  }
  return [...byClient.values()].sort((a, b) => b.best_score - a.best_score);
}

// One candidate vendor plus a few recent example messages that vendor is known to
// have sent (the "style" signal). The caller populates `examples` from history.
export type VendorCandidate = {
  client_id: string;
  client_name: string;
  examples: string[];
};

export type VendorClassifyResult = {
  client_id: string | null; // chosen vendor, or null when the classifier is unsure
  confidence: number; // 0..1
  reason: string;
  raw?: unknown; // provider response envelope, for audit/debug
};

export const VENDOR_CLASSIFIER_SCHEMA = {
  name: 'vendor_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['vendor_number', 'confidence', 'reason'],
    properties: {
      // 1-based index into the candidate list; 0 means "cannot tell".
      vendor_number: { type: 'integer' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
  },
};

export const VENDOR_CLASSIFIER_PROMPT = `You are identifying WHICH VENDOR (business) a forwarded WhatsApp delivery order came from.

Two or more vendors sell a product with the SAME name, so the product alone cannot tell them apart. Decide from HOW THE MESSAGE IS WRITTEN — its formatting, field labels, the order the fields appear in, punctuation, emoji, capitalisation, phrasing, and any recurring header/footer or wording. Compare the new order against each vendor's example messages and pick the vendor whose writing style it matches.

Rules:
- Choose EXACTLY ONE vendor_number from the list, OR return 0 when the examples do not clearly distinguish which vendor wrote it. Never guess — 0 is the correct answer when you are not sure.
- confidence is 0..1: how sure you are. Use a value below 0.5 when the styles look similar or the evidence is thin.
- reason: one short sentence naming the concrete formatting cues you used.

Candidate vendors:
{{CANDIDATES}}

New order to classify:
"""
{{TEXT}}
"""`;

// Render the numbered candidate block the prompt interpolates.
export function buildCandidateBlock(candidates: VendorCandidate[]): string {
  return candidates
    .map((c, i) => {
      const header = `[${i + 1}] Vendor: ${c.client_name || c.client_id}`;
      const examples = c.examples.length === 0
        ? '    (no example messages available)'
        : c.examples
          .map((ex, j) => `    --- example ${j + 1} ---\n${indent(sanitizeMessageText(ex))}`)
          .join('\n');
      return `${header}\n  Example messages from this vendor:\n${examples}`;
    })
    .join('\n\n');
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function coerceClassification(
  obj: unknown,
): { vendor_number: number; confidence: number; reason: string } | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const vn = Number(o.vendor_number);
  if (!Number.isFinite(vn)) return null;
  const conf = Number(o.confidence);
  return {
    vendor_number: Math.trunc(vn),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

export type ClassifyVendorOpts = { model?: string; timeoutMs?: number };

// Ask the LLM to pick the vendor. Returns { client_id: null } (never throws) on
// any failure — timeout, non-ok response, unparseable output, out-of-range choice
// — so the caller falls back to needs_review exactly as it does today.
export async function classifyVendor(
  rawText: string,
  candidates: VendorCandidate[],
  apiKey: string,
  opts: ClassifyVendorOpts = {},
): Promise<VendorClassifyResult> {
  const model = opts.model ?? VENDOR_CLASSIFIER_MODEL;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (candidates.length < 2) {
    // Nothing to disambiguate.
    return { client_id: candidates[0]?.client_id ?? null, confidence: 0, reason: 'no contest' };
  }

  const prompt = VENDOR_CLASSIFIER_PROMPT
    .replace('{{CANDIDATES}}', buildCandidateBlock(candidates))
    .replace('{{TEXT}}', sanitizeMessageText(rawText));
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: VENDOR_CLASSIFIER_SCHEMA },
  };

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://reda.app',
        'X-Title': 'Reda vendor-classify',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      console.error('vendor-classify timeout', { timeout_ms: timeoutMs, model });
      return { client_id: null, confidence: 0, reason: 'timeout', raw: { error: 'request timeout' } };
    }
    console.error('vendor-classify network error', err, { model });
    return { client_id: null, confidence: 0, reason: 'network error', raw: { error: String(err) } };
  }
  if (!res.ok) {
    const errText = await res.text();
    console.error('vendor-classify error', res.status, errText);
    return { client_id: null, confidence: 0, reason: 'provider error', raw: { error: errText, status: res.status } };
  }

  const json = await res.json();
  const textOut = json?.choices?.[0]?.message?.content;
  let parsed: ReturnType<typeof coerceClassification> = null;
  if (typeof textOut === 'string' && textOut.length > 0) {
    try {
      parsed = coerceClassification(JSON.parse(stripJsonFences(textOut)));
    } catch {
      /* fall through — parsed stays null */
    }
  }
  const rawEnvelope = { ...json, _version: VENDOR_CLASSIFIER_VERSION, _model: model };
  if (!parsed) {
    return { client_id: null, confidence: 0, reason: 'unparseable', raw: rawEnvelope };
  }

  // vendor_number is 1-based; 0 or out-of-range means "unsure".
  const idx = parsed.vendor_number - 1;
  const chosen = idx >= 0 && idx < candidates.length ? candidates[idx] : null;
  return {
    client_id: chosen ? chosen.client_id : null,
    confidence: chosen ? parsed.confidence : 0,
    reason: parsed.reason,
    raw: rawEnvelope,
  };
}
