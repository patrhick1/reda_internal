// Lagos-timezone date helpers. Reda operates entirely in Africa/Lagos (UTC+1,
// no DST), so a simple fixed offset is correct year-round and avoids pulling
// in a full timezone library.

const LAGOS_OFFSET_MS = 60 * 60 * 1000; // +1 hour

function lagosNow(): Date {
  return new Date(Date.now() + LAGOS_OFFSET_MS);
}

/** ISO date `YYYY-MM-DD` for "today" in Lagos. Stable for use in SQL date params. */
export function todayLagos(): string {
  return lagosNow().toISOString().slice(0, 10);
}

/** ISO date `YYYY-MM-DD` for "yesterday" in Lagos. */
export function yesterdayLagos(): string {
  return daysAgoLagos(1);
}

/** ISO date `YYYY-MM-DD` for N days before today in Lagos. */
export function daysAgoLagos(days: number): string {
  const d = lagosNow();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** True when `value` parses as a strict `YYYY-MM-DD` (10 chars, valid month/day).
 *  Used to gate RPC calls that take `date` params so that partial input
 *  (e.g. while the user is typing into a From/To field) doesn't fire a
 *  request that PostgREST rejects with 22007 `invalid input syntax for type date`. */
export function isYmd(value: string | null | undefined): value is string {
  if (!value || value.length !== 10) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Reject impossible day/month combos (Date wraps invalid dates silently).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Human-friendly Lagos-locale date (e.g. "14 May 2026") from an ISO `YYYY-MM-DD`. */
export function formatDateLagos(iso: string): string {
  // Parse as UTC to avoid local-time drift; format using en-GB which gives
  // "14 May 2026" without weekday or comma.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Human-friendly range string used in share headers and AppBar subtitles. */
export function formatRangeLagos(from: string, to: string): string {
  if (from === to) return formatDateLagos(from);
  return `${formatDateLagos(from)} → ${formatDateLagos(to)}`;
}
