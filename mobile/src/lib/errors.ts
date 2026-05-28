/**
 * Extract a human-readable message from any thrown value. Handles:
 *   - native Error instances (`.message`)
 *   - Supabase PostgrestError (plain object with `code`, `details`, `message`)
 *   - anything else (`String(value)`)
 *
 * PostgrestError is NOT an Error instance, so `e instanceof Error` is false
 * and `String(e)` returns "[object Object]". This helper avoids that.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message.trim()) return obj.message;
    if (typeof obj.details === 'string' && obj.details.trim()) return obj.details;
    if (typeof obj.hint === 'string' && obj.hint.trim()) return obj.hint;
  }
  const s = String(e);
  return s === '[object Object]' ? 'Unknown error' : s;
}

// ---------------------------------------------------------------------------
// Terminal-vs-retryable RPC error classification.
//
// Some Supabase RPC failures are permanent given the same inputs —
// `insufficient_stock` (P0001), check-constraint violations, RLS denies. The
// queue's default behaviour (8 retries with backoff, then dead-letter) wastes
// time and shows a misleading "Reconnecting" banner for these. We classify
// them up-front so the drain skips retries and the banner surfaces the actual
// reason immediately.
// ---------------------------------------------------------------------------

/** Postgres SQLSTATE codes that won't succeed on retry of the same payload.
 *  P0001  = RAISE EXCEPTION (our RPCs throw these for insufficient_stock,
 *           permission denied, invalid status transitions, etc.)
 *  23514  = check_violation
 *  23505  = unique_violation
 *  42501  = insufficient_privilege (RLS / role denial)
 *  22P02  = invalid_text_representation (e.g. bad UUID, bad enum) */
const TERMINAL_PG_CODES = new Set(['P0001', '23514', '23505', '42501', '22P02']);

/** A failure the queue should NOT retry — bad input or a server rule said no.
 *  Carries a human message and the original error for logging. */
export class TerminalError extends Error {
  readonly original: unknown;
  constructor(message: string, original: unknown) {
    super(message);
    this.name = 'TerminalError';
    this.original = original;
  }
}

/** Wrap a Supabase/Postgres error in TerminalError when the SQLSTATE marks it
 *  permanent; otherwise return the original so the caller's `throw` still
 *  triggers a normal retry. */
export function classifyRpcError(e: unknown): unknown {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const code = typeof obj.code === 'string' ? obj.code : null;
    if (code && TERMINAL_PG_CODES.has(code)) {
      return new TerminalError(humanizeRpcError(obj), e);
    }
  }
  return e;
}

/** Rewrite known machine-prefixed RPC messages into something an operator can
 *  read in a one-line banner. Falls back to the raw message for anything we
 *  don't recognise — the underlying RAISE text is usually already decent. */
function humanizeRpcError(obj: Record<string, unknown>): string {
  const message = typeof obj.message === 'string' ? obj.message : '';
  const hint = typeof obj.hint === 'string' ? obj.hint : '';

  // insufficient_stock: source has 0 units, transfer needs 3
  //   → Not enough stock — source has 0 units, needs 3
  if (message.startsWith('insufficient_stock:')) {
    return (
      'Not enough stock — ' +
      message.replace(/^insufficient_stock:\s*/, '').replace(/\btransfer needs\b/, 'needs')
    );
  }

  // permission denied — the SQL hint usually explains who can do what.
  if (message === 'permission denied') {
    return hint ? `Permission denied — ${hint}` : 'Permission denied';
  }

  return message || hint || 'Operation failed';
}
