// Backtest the vendor classifier on LABELED HISTORY — the GO/NO-GO gate before
// we wire it into intake. For every past order on a product whose name is shared
// across vendors, we already KNOW the true vendor (bot_inbound_messages.delivery_id
// -> deliveries.client_id). We hide that label, give the classifier a few of each
// candidate vendor's EARLIER messages as style examples (temporal split — no
// leakage), and measure how often it picks the right vendor vs the "always guess
// the dominant vendor" baseline.
//
// Read-only. No prod impact.
//
// Run:
//   OPENROUTER_API_KEY=... SUPABASE_DB_URI=... \
//   deno run --allow-env --allow-run --allow-net tools/vendor-classify-backtest.ts
//
// Optional env: FEWSHOT_K (examples per vendor, default 5),
//               MAX_CASES (sample N cases, 0=all), CONCURRENCY (default 6).
import { classifyVendor, type VendorCandidate } from '../supabase/functions/_shared/vendor-classify.ts';

const dec = new TextDecoder();
const K = Number(Deno.env.get('FEWSHOT_K') ?? 5);
const MAX_CASES = Number(Deno.env.get('MAX_CASES') ?? 0); // 0 = all
const CONCURRENCY = Number(Deno.env.get('CONCURRENCY') ?? 6);

async function psql(sql: string): Promise<string> {
  const uri = Deno.env.get('SUPABASE_DB_URI');
  if (!uri) throw new Error('SUPABASE_DB_URI not set');
  const { code, stdout, stderr } = await new Deno.Command('psql', {
    args: [uri, '-At', '-c', sql], stdout: 'piped', stderr: 'piped',
  }).output();
  if (code !== 0) throw new Error(dec.decode(stderr));
  return dec.decode(stdout).trim();
}
// JSON round-trip keeps multi-line WhatsApp text intact (tabs/newlines are escaped
// inside the JSON string instead of breaking row/column splitting).
async function pullJson<T>(sql: string): Promise<T[]> {
  const out = await psql(`select coalesce(json_agg(row_to_json(t)), '[]') from (${sql}) t`);
  return out ? (JSON.parse(out) as T[]) : [];
}

// Inner subquery = the set of normalized product names sold by >1 vendor. It is
// self-contained (its own product_catalog scan, no outer alias). Callers apply it
// as: lower(btrim(pc.product_name)) in (${SHARED_NAMES})
const SHARED_NAMES = `select lower(btrim(product_name)) from public.product_catalog
  where is_active group by 1 having count(distinct client_id) > 1`;

type SharedRow = { pname: string; client_id: string; client_name: string };
type Case = { inbound_id: string; true_client_id: string; pname: string; epoch: number; raw_text: string };
type Example = { inbound_id: string; client_id: string; epoch: number; raw_text: string };

// A limited-concurrency map so we don't hammer OpenRouter rate limits.
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1)}%`.padStart(6);
}

async function main() {
  if (!Deno.env.get('OPENROUTER_API_KEY')) throw new Error('OPENROUTER_API_KEY not set');
  const apiKey = Deno.env.get('OPENROUTER_API_KEY')!;

  console.log(`Loading labeled history…  (K=${K} examples/vendor, temporal split, concurrency=${CONCURRENCY})`);

  // 1. shared normalized name -> the vendors that sell it
  const shared = await pullJson<SharedRow>(`
    select lower(btrim(pc.product_name)) as pname, pc.client_id, coalesce(c.name,'') as client_name
    from public.product_catalog pc
    join public.clients c on c.id = pc.client_id
    where pc.is_active and lower(btrim(pc.product_name)) in (${SHARED_NAMES})
    group by 1,2,3`);
  const vendorsByName = new Map<string, { client_id: string; client_name: string }[]>();
  for (const r of shared) {
    const arr = vendorsByName.get(r.pname) ?? [];
    arr.push({ client_id: r.client_id, client_name: r.client_name });
    vendorsByName.set(r.pname, arr);
  }
  const candidateVendorIds = [...new Set(shared.map((r) => r.client_id))];

  // 2. the labeled test cases (past orders on a shared-name product, with raw text)
  let cases = await pullJson<Case>(`
    select m.id as inbound_id, d.client_id as true_client_id,
           lower(btrim(pc.product_name)) as pname,
           extract(epoch from m.received_at)::bigint as epoch, m.raw_text
    from public.bot_inbound_messages m
    join public.deliveries d on d.id = m.delivery_id
    join public.product_catalog pc on pc.id = d.product_catalog_id
    where m.status = 'created_delivery' and d.deleted_at is null
      and m.raw_text is not null and length(btrim(m.raw_text)) > 0
      and lower(btrim(pc.product_name)) in (${SHARED_NAMES})
    order by m.received_at`);
  if (MAX_CASES > 0) cases = cases.slice(0, MAX_CASES);

  // 3. example pool: every labeled message from the candidate vendors
  const idList = candidateVendorIds.map((id) => `'${id}'`).join(',');
  const pool = await pullJson<Example>(`
    select m.id as inbound_id, d.client_id,
           extract(epoch from m.received_at)::bigint as epoch, m.raw_text
    from public.bot_inbound_messages m
    join public.deliveries d on d.id = m.delivery_id
    where m.status = 'created_delivery' and d.deleted_at is null
      and m.raw_text is not null and length(btrim(m.raw_text)) > 0
      and d.client_id in (${idList})`);
  const poolByVendor = new Map<string, Example[]>();
  for (const e of pool) {
    const arr = poolByVendor.get(e.client_id) ?? [];
    arr.push(e);
    poolByVendor.set(e.client_id, arr);
  }
  for (const arr of poolByVendor.values()) arr.sort((a, b) => b.epoch - a.epoch); // newest first

  const examplesFor = (clientId: string, beforeEpoch: number, exclude: string): string[] =>
    (poolByVendor.get(clientId) ?? [])
      .filter((e) => e.epoch < beforeEpoch && e.inbound_id !== exclude)
      .slice(0, K)
      .map((e) => e.raw_text);

  console.log(`${cases.length} labeled cases · ${candidateVendorIds.length} candidate vendors · pool ${pool.length} msgs\n`);

  type Outcome = {
    pname: string; trueId: string; predId: string | null; confidence: number;
    coldStart: boolean; correct: boolean; decided: boolean;
  };
  const results = await mapPool(cases, CONCURRENCY, async (c) => {
    const vendors = vendorsByName.get(c.pname) ?? [];
    const candidates: VendorCandidate[] = vendors.map((v) => ({
      client_id: v.client_id,
      client_name: v.client_name,
      examples: examplesFor(v.client_id, c.epoch, c.inbound_id),
    }));
    const coldStart = candidates.some((cd) => cd.examples.length === 0);
    const res = await classifyVendor(c.raw_text, candidates, apiKey);
    const decided = res.client_id !== null;
    const o: Outcome = {
      pname: c.pname, trueId: c.true_client_id, predId: res.client_id, confidence: res.confidence,
      coldStart, correct: res.client_id === c.true_client_id, decided,
    };
    return o;
  });

  // --- baseline: always guess the dominant vendor for that product name -------
  const domByName = new Map<string, string>();
  for (const [pname] of vendorsByName) {
    const counts = new Map<string, number>();
    for (const r of results) if (r.pname === pname) counts.set(r.trueId, (counts.get(r.trueId) ?? 0) + 1);
    let best = '', bestN = -1;
    for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
    domByName.set(pname, best);
  }
  const baselineCorrect = results.filter((r) => r.trueId === domByName.get(r.pname)).length;

  // --- report -----------------------------------------------------------------
  const N = results.length;
  const cold = results.filter((r) => r.coldStart).length;
  const decidedAll = results.filter((r) => r.decided);
  const correctAll = results.filter((r) => r.correct).length;

  const line = (s: string) => console.log(s);
  line('════════════════════════ VENDOR CLASSIFIER BACKTEST ════════════════════════');
  line(`cases: ${N}   cold-start (a vendor had 0 prior examples): ${cold}`);
  line('');
  line(`BASELINE  "always pick the dominant vendor":  ${pct(baselineCorrect, N)}   (${baselineCorrect}/${N})`);
  line(`CLASSIFIER overall correct (abstains count as wrong): ${pct(correctAll, N)}   (${correctAll}/${N})`);
  line('');
  line('By confidence threshold — what happens if we only auto-resolve at/above t,');
  line('and send everything below to needs_review (today ALL of these go to review):');
  line('  thresh │ decided │ coverage │ precision │  correct  wrong');
  line('  ───────┼─────────┼──────────┼───────────┼─────────────────');
  for (const t of [0.0, 0.5, 0.7, 0.8, 0.9]) {
    const dec2 = decidedAll.filter((r) => r.confidence >= t);
    const correct = dec2.filter((r) => r.correct).length;
    const wrong = dec2.length - correct;
    line(`   ${t.toFixed(2)}  │  ${String(dec2.length).padStart(5)}  │  ${pct(dec2.length, N)}  │  ${pct(correct, dec2.length)}   │   ${String(correct).padStart(4)}   ${String(wrong).padStart(4)}`);
  }
  line('');
  line('Per shared product name:');
  line('  product name        │ cases │ classifier │ baseline');
  line('  ────────────────────┼───────┼────────────┼─────────');
  for (const [pname] of vendorsByName) {
    const rs = results.filter((r) => r.pname === pname);
    if (rs.length === 0) { line(`  ${pname.padEnd(19)} │   0   │    —       │   —`); continue; }
    const cc = rs.filter((r) => r.correct).length;
    const bb = rs.filter((r) => r.trueId === domByName.get(pname)).length;
    line(`  ${pname.padEnd(19)} │ ${String(rs.length).padStart(4)}  │  ${pct(cc, rs.length)}    │ ${pct(bb, rs.length)}`);
  }
  line('');
  const wrongDecisions = decidedAll.filter((r) => !r.correct);
  line(`Confident-but-WRONG decisions (would mis-attribute the vendor): ${wrongDecisions.length}`);
  const wrongHi = wrongDecisions.filter((r) => r.confidence >= 0.8).length;
  line(`  …of which at confidence ≥ 0.80: ${wrongHi}   (these are the ones that matter for the threshold choice)`);
  line('═════════════════════════════════════════════════════════════════════════════');
}

await main();
