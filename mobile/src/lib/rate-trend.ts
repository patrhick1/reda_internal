// Pure helpers for the delivery-rate trend (home 7-day strip + history screen).
// Kept framework-free so both surfaces compute rates and labels identically.

export type RateDay = { day: string; delivered: number; available: number };

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Weekday abbreviation for an ISO `YYYY-MM-DD`. Parsed at UTC noon so the label
 *  never shifts a day across timezones. */
export function weekdayShort(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return WEEKDAY[d.getUTCDay()] ?? '';
}

/** "Jul 16" for an ISO `YYYY-MM-DD` (string-parsed — no Date/timezone surprises). */
export function monthDayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map((n) => Number(n));
  return `${MONTH[(m ?? 1) - 1]} ${d}`;
}

/** Shift an ISO `YYYY-MM-DD` by n days (negative = past). UTC-noon anchored so it
 *  never drifts a day. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** One day's rate as an integer percent, or null when the day had no available
 *  orders (denominator 0 — nothing to rate). */
export function dayRatePct(d: Pick<RateDay, 'delivered' | 'available'>): number | null {
  if (!d.available) return null;
  return Math.round((d.delivered / d.available) * 100);
}

/** Volume-weighted (pooled) rate across days: Σdelivered / Σavailable. The right
 *  average for a headline — a light 2-order day can't swing it the way a mean of
 *  daily rates would. Null when no available orders in the window. */
export function pooledRatePct(days: RateDay[]): {
  pct: number | null;
  delivered: number;
  available: number;
} {
  const delivered = days.reduce((s, d) => s + d.delivered, 0);
  const available = days.reduce((s, d) => s + d.available, 0);
  return {
    pct: available ? Math.round((delivered / available) * 100) : null,
    delivered,
    available,
  };
}
