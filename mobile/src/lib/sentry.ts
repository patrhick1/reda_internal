/**
 * Console-only error logger. We deliberately removed the @sentry/react-native
 * integration for v1 — no events leave the device. If you need remote crash
 * reporting later, restore the Sentry init from git history; the PII scrubbing
 * is still useful there.
 *
 * Exports a single `logError(scope, err, extra?)` that prints a structured
 * line to the device console. Call sites stay readable and we can swap the
 * implementation later without touching every screen.
 */

export function initSentry(): void {
  // Intentional no-op. Kept for backwards-compat with the existing call site
  // in app/_layout.tsx — removing this function would require an extra commit
  // there, and the indirection costs nothing.
}

export function logError(scope: string, err: unknown, extra?: Record<string, unknown>): void {
  const cleaned = extra ? scrub(extra) : undefined;
  // eslint-disable-next-line no-console
  console.error(`[reda:${scope}]`, err, cleaned ?? '');
}

const PII_KEYS = ['expo_push_token', 'push_token', 'customer_phone', 'phone', 'password', 'token'];

function scrub<T>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => scrub(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    if (PII_KEYS.some(p => lower.includes(p))) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = scrub(v);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as T;
}
