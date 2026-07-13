// Dev-only Supabase egress instrumentation (audit Phase 0 — baseline).
//
// Wraps the fetch the supabase-js client uses and records the byte size of every
// response, keyed by request path (table / rpc / auth endpoint), so we can
// measure per-screen and per-journey egress before/after each optimization. It
// captures EVERYTHING the client sends — PostgREST selects, RPC calls, auth,
// realtime negotiation — with zero changes to any service.
//
// You DON'T need to touch the console: a few seconds after each burst of network
// activity settles, the accumulated "burst" table auto-prints to the Metro
// terminal (and the browser console on `expo start --web`). So the workflow is
// just: run the app, walk a screen/journey, pause, read the table that appears.
// A burst = whatever fired since the last quiet gap, which naturally lines up
// with one screen open or one journey if you pause between them.
//
// Manual controls are still there if you want precise segmentation:
//   __egress.report()   // print the full cumulative table so far
//   __egress.reset('x') // zero the counters before a journey
//
// NO-OP in production: instrumentedFetch() returns the real fetch untouched when
// __DEV__ is false, so release builds carry zero overhead and never clone a
// response body. This is a measurement aid, not exact wire size (it reads
// Content-Length, or the decoded body length as a fallback) — but it's a
// consistent yardstick for comparing before/after.

type Stat = { count: number; bytes: number; maxBytes: number };
type TableRow = { label: string; count: number; KB: string; maxKB: string; avgB: number };

// Auto-print the burst table this many ms after the last request settles.
const QUIET_MS = 4000;
// Flip to true to also log every single request inline (noisy).
const VERBOSE = false;

const total = new Map<string, Stat>(); // cumulative until reset()
const burst = new Map<string, Stat>(); // since the last auto-flush
let sessionBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Request URL → a stable, aggregatable label. Strips the PostgREST/auth prefix
// and the query string so "deliveries?select=…" and "deliveries?id=eq.…" fold
// under one "deliveries" key; RPCs read as "rpc/<fn>".
function labelFor(url: string, method: string): string {
  try {
    const u = new URL(url);
    let p = u.pathname
      .replace(/^\/rest\/v1\//, '')
      .replace(/^\/auth\/v1\//, 'auth/')
      .replace(/^\/realtime\/v1\//, 'realtime/')
      .replace(/^\/+/, '');
    if (!p) p = u.pathname || url;
    return `${method} ${p}`;
  } catch {
    return `${method} ${url}`;
  }
}

function bump(map: Map<string, Stat>, label: string, bytes: number): void {
  const s = map.get(label) ?? { count: 0, bytes: 0, maxBytes: 0 };
  s.count += 1;
  s.bytes += bytes;
  s.maxBytes = Math.max(s.maxBytes, bytes);
  map.set(label, s);
}

function tableFrom(map: Map<string, Stat>): TableRow[] {
  return [...map.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([label, s]) => ({
      label,
      count: s.count,
      KB: (s.bytes / 1024).toFixed(1),
      maxKB: (s.maxBytes / 1024).toFixed(1),
      avgB: Math.round(s.bytes / s.count),
    }));
}

function printTable(header: string, map: Map<string, Stat>): TableRow[] {
  const rows = tableFrom(map);
  // eslint-disable-next-line no-console
  console.log(header);
  if (typeof console.table === 'function') {
    // eslint-disable-next-line no-console
    console.table(rows);
  } else {
    // eslint-disable-next-line no-console
    rows.forEach((r) => console.log(`[egress] ${r.label}  ×${r.count}  ${r.KB}KB`));
  }
  return rows;
}

function flushBurst(): void {
  flushTimer = null;
  if (burst.size === 0) return;
  let bytes = 0;
  let reqs = 0;
  for (const s of burst.values()) {
    bytes += s.bytes;
    reqs += s.count;
  }
  printTable(
    `[egress] burst ≈ ${(bytes / 1024).toFixed(1)} KB (${reqs} requests) · session so far ${(
      sessionBytes / 1024
    ).toFixed(1)} KB`,
    burst,
  );
  burst.clear();
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBurst, QUIET_MS);
}

function record(label: string, bytes: number): void {
  bump(total, label, bytes);
  bump(burst, label, bytes);
  sessionBytes += bytes;
  scheduleFlush();
  if (VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(`[egress] ${label}  +${bytes}B`);
  }
}

function safeClone(res: Response): Response | null {
  try {
    return res.clone();
  } catch {
    return null;
  }
}

/** Wrap a fetch impl so every response's size is recorded by path. Returns the
 *  real fetch unchanged outside dev, so production is untouched. */
export function instrumentedFetch(realFetch: typeof fetch): typeof fetch {
  if (!__DEV__) return realFetch;
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ??
      (typeof input === 'object' && 'method' in input ? input.method : undefined) ??
      'GET'
    ).toUpperCase();

    const res = await realFetch(input, init);
    const label = labelFor(url, method);

    // Content-Length is present for normal (non-chunked) PostgREST/RPC responses
    // and lets us measure without touching the body. HEAD count requests carry
    // an empty body → ~0 bytes, which is correct (they're cheap). When it's
    // absent (chunked), clone BEFORE the caller consumes the body and read the
    // clone off to the side.
    const cl = res.headers.get('content-length');
    if (cl !== null && Number.isFinite(Number(cl))) {
      record(label, Number(cl));
    } else {
      const clone = safeClone(res);
      if (clone) {
        void clone
          .text()
          .then((t) => record(label, t.length))
          .catch(() => {});
      }
    }
    return res;
  };
}

/** Print the full cumulative egress table, biggest total first. */
export function egressReport(): TableRow[] {
  return printTable(`[egress] session total ≈ ${(sessionBytes / 1024).toFixed(1)} KB`, total);
}

/** Zero the counters — call at the start of a journey you want to measure. */
export function egressReset(label?: string): void {
  total.clear();
  burst.clear();
  sessionBytes = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // eslint-disable-next-line no-console
  if (label) console.log(`[egress] reset @ ${label}`);
}

// Expose on the global so the manual controls are callable straight from the RN
// dev console / browser console (`__egress.report()` / `__egress.reset('x')`),
// no import needed. Dev only.
if (__DEV__) {
  (globalThis as unknown as { __egress?: unknown }).__egress = {
    report: egressReport,
    reset: egressReset,
  };
}
