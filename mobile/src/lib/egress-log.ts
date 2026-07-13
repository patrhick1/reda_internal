// Dev-only Supabase egress instrumentation (audit Phase 0 — baseline).
//
// Wraps the fetch the supabase-js client uses and records the byte size of every
// response, keyed by request path (table / rpc / auth endpoint), so we can
// measure per-screen and per-journey egress before/after each optimization. It
// captures EVERYTHING the client sends — PostgREST selects, RPC calls, auth,
// realtime negotiation — with zero changes to any service.
//
// NO-OP in production: instrumentedFetch() returns the real fetch untouched when
// __DEV__ is false, so release builds carry zero overhead and never clone a
// response body. This is a measurement aid, not exact wire size (it reads
// Content-Length, or the decoded body length as a fallback) — but it's a
// consistent yardstick for comparing before/after.
//
// Usage (Metro / RN dev console, after signing in):
//   __egress.reset('dashboard')   // zero the counters before a journey
//   …walk the journey in the app…
//   __egress.report()             // print the table, biggest paths first

type Stat = { count: number; bytes: number; maxBytes: number };

const stats = new Map<string, Stat>();
let sessionBytes = 0;

// Flip to true to also log every request inline (noisy). The accumulator +
// report() is the primary tool; per-request logging is for spot debugging.
const VERBOSE = false;

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

function record(label: string, bytes: number): void {
  const s = stats.get(label) ?? { count: 0, bytes: 0, maxBytes: 0 };
  s.count += 1;
  s.bytes += bytes;
  s.maxBytes = Math.max(s.maxBytes, bytes);
  stats.set(label, s);
  sessionBytes += bytes;
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

type EgressReportRow = {
  label: string;
  count: number;
  KB: string;
  maxKB: string;
  avgB: number;
};

/** Print the accumulated egress table, biggest total first. */
export function egressReport(): EgressReportRow[] {
  const rows = [...stats.entries()]
    .map(([label, s]) => ({
      label,
      count: s.count,
      KB: (s.bytes / 1024).toFixed(1),
      maxKB: (s.maxBytes / 1024).toFixed(1),
      avgB: Math.round(s.bytes / s.count),
      _bytes: s.bytes,
    }))
    .sort((a, b) => b._bytes - a._bytes);
  const totalReqs = rows.reduce((n, r) => n + r.count, 0);
  // eslint-disable-next-line no-console
  console.log(
    `[egress] session ≈ ${(sessionBytes / 1024).toFixed(1)} KB across ${totalReqs} requests`,
  );
  const table = rows.map(({ _bytes, ...r }) => r);
  // eslint-disable-next-line no-console
  if (typeof console.table === 'function') console.table(table);
  // eslint-disable-next-line no-console
  else table.forEach((r) => console.log(`[egress] ${r.label}  ×${r.count}  ${r.KB}KB`));
  return table;
}

/** Zero the counters — call at the start of a journey you want to measure. */
export function egressReset(label?: string): void {
  stats.clear();
  sessionBytes = 0;
  // eslint-disable-next-line no-console
  if (label) console.log(`[egress] reset @ ${label}`);
}

// Expose on the global so it's callable straight from the RN dev console
// (`__egress.reset('x')` / `__egress.report()`), no import needed. Dev only.
if (__DEV__) {
  (globalThis as unknown as { __egress?: unknown }).__egress = {
    report: egressReport,
    reset: egressReset,
  };
}
