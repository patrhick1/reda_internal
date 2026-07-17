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

/** Colour band for a rate % (Greg's scale): <50 red, 50–74 orange, 75–89
 *  green, 90+ light green. Shared by the home hero/strip and the history
 *  screen so every rate surface grades identically. */
export type RateBand = 'low' | 'mid' | 'good' | 'great';

export function rateBand(pct: number): RateBand {
  if (pct < 50) return 'low';
  if (pct < 75) return 'mid';
  if (pct < 90) return 'good';
  return 'great';
}

/** Band colours per background. `dark` = the black hero/chart cards (brighter
 *  light-green pops there); `light` = white cards, where the 90+ tier uses a
 *  deeper light-green so bold 13-14px text stays readable. Base tiers reuse
 *  the theme palette (red / warning / success). */
export const RATE_BAND_COLORS: Record<'light' | 'dark', Record<RateBand, string>> = {
  light: { low: '#E63027', mid: '#F59E0B', good: '#16A34A', great: '#22C55E' },
  dark: { low: '#E63027', mid: '#F59E0B', good: '#16A34A', great: '#4ADE80' },
};

/** Convenience: colour for a (possibly null) rate on a given background.
 *  Null (no rateable orders) falls back to the caller-supplied neutral. */
export function rateColor(pct: number | null, theme: 'light' | 'dark', neutral: string): string {
  return pct == null ? neutral : RATE_BAND_COLORS[theme][rateBand(pct)];
}
