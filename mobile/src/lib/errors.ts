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
    if (typeof obj.hint    === 'string' && obj.hint.trim())    return obj.hint;
  }
  const s = String(e);
  return s === '[object Object]' ? 'Unknown error' : s;
}
