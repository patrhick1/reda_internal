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
  // Aligned plain-text rows print cleanly in BOTH the Metro terminal (Hermes has
  // no reliable console.table) and the browser console. One block per table.
  const w = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const lines = rows.map(
    (r) =>
      `  ${r.label.padEnd(w)}  ×${String(r.count).padStart(3)}  ${r.KB.padStart(8)} KB` +
      `  (max ${r.maxKB} KB)`,
  );
  // eslint-disable-next-line no-console
  console.log([header, ...lines].join('\n'));
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

/** @param quiet Count the bytes but DON'T re-arm the burst auto-print. For
 *  background protocol chatter that would otherwise make an idle app print a
 *  near-empty table forever (see isWsDataFrame). Quiet bytes still land in the
 *  next burst that real activity triggers, so nothing is lost — only the
 *  spurious flush is suppressed. */
function record(label: string, bytes: number, quiet = false): void {
  bump(total, label, bytes);
  bump(burst, label, bytes);
  sessionBytes += bytes;
  if (!quiet) scheduleFlush();
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

// ---------------------------------------------------------------------------
// Realtime (websocket) egress — audit Phase 4 measurement gap.
//
// instrumentedFetch above only sees HTTP, so every number this audit has ever
// printed is PostgREST-only. Supabase counts Realtime as egress too: the
// delivery_messages subscription is deliberately unfiltered (any ops user must
// see any agent's reply), so EVERY message row change is pushed to EVERY
// connected ops device — and none of it showed up in any burst table.
//
// Hooked in via realtime's `transport` option — createClient(…, { realtime: {
// transport } }). realtime-js resolves it as
//     result.transport = options?.transport ?? WebSocketFactory.getWebSocketConstructor()
// i.e. a supplied transport WINS and the native-WebSocket factory is only the
// fallback. So this stays scoped to Supabase's own socket: no monkey-patching of
// globalThis.WebSocket (which would affect any other socket user and impose an
// install-before-createClient ordering trap).
//
// This is pure observation: we subclass the platform WebSocket, attach a
// listener, and change nothing about the data flow. (The alternative —
// realtime's `decode` option — REPLACES the serializer, so a mistake there
// breaks realtime outright. Not worth it for a measurement aid.)
//
// Only INBOUND frames are counted: egress is data leaving Supabase. Frames the
// client sends (heartbeats, subscribe) are ingress and are ignored.
// ---------------------------------------------------------------------------

type WsCtor = new (url: string, protocols?: string | string[]) => WebSocket;

/** True for frames carrying actual application data. Phoenix protocol chatter
 *  (`phx_reply` to the 25-second heartbeat — realtime-js CONNECTION_TIMEOUTS
 *  .HEARTBEAT_INTERVAL = 25000 — plus phx_join/close/error) is counted but must
 *  never re-arm the burst auto-print: otherwise an idle app prints a table
 *  containing nothing but `WS phx_reply` every 25s, forever, burying the real
 *  measurements. */
function isWsDataFrame(label: string): boolean {
  return (
    label.startsWith('WS pg/') ||
    label.startsWith('WS broadcast') ||
    label.startsWith('WS presence')
  );
}

/** Realtime wire frame → a stable label. The phoenix protocol puts an ARRAY on
 *  the wire — [join_ref, ref, topic, event, payload] — see realtime-js
 *  lib/serializer.js `decode`. postgres_changes frames are labelled by table +
 *  operation so the cost of each subscription is attributable; everything else
 *  (phx_reply, heartbeat, presence) folds under its event name. */
function labelForWsFrame(data: unknown): string {
  if (typeof data !== 'string') return 'WS binary';
  try {
    const arr = JSON.parse(data) as unknown[];
    if (!Array.isArray(arr)) return 'WS frame';
    const event = typeof arr[3] === 'string' ? arr[3] : 'unknown';
    const payload = arr[4] as { data?: { table?: string; type?: string } } | undefined;
    if (event === 'postgres_changes' && payload?.data?.table) {
      return `WS pg/${payload.data.table}/${payload.data.type ?? '?'}`;
    }
    return `WS ${event}`;
  } catch {
    return 'WS frame';
  }
}

function wsFrameBytes(data: unknown): number {
  if (typeof data === 'string') return data.length;
  if (data && typeof data === 'object' && 'byteLength' in data) {
    return Number((data as { byteLength: number }).byteLength) || 0;
  }
  return 0;
}

/** A WebSocket subclass that counts inbound realtime frames into the same burst
 *  tables as HTTP. Pass to createClient as `realtime: { transport }`. Returns
 *  undefined outside dev (and where the platform has no WebSocket), so callers
 *  simply omit the option and realtime-js resolves its own default. */
export function countingWebSocketTransport(): WsCtor | undefined {
  if (!__DEV__) return undefined;
  const Real = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  if (!Real) return undefined;
  return class extends (Real as WsCtor) {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      try {
        this.addEventListener('message', (ev: MessageEvent) => {
          const label = labelForWsFrame(ev.data);
          record(label, wsFrameBytes(ev.data), !isWsDataFrame(label));
        });
      } catch {
        // Platform without addEventListener on WebSocket — skip measuring
        // rather than risk touching onmessage, which realtime-js owns.
      }
    }
  } as unknown as WsCtor;
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
