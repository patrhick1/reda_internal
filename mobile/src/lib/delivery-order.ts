type ActivityRow = { activity_at?: string | null; created_at?: string | null };

/** List queries and cross-date merges must use the same newest-activity order.
 * The views return fixed-format UTC ISO timestamps; ties keep input order. */
export function compareDeliveryActivity(a: ActivityRow, b: ActivityRow): number {
  const x = a.activity_at ?? a.created_at ?? '';
  const y = b.activity_at ?? b.created_at ?? '';
  return x < y ? 1 : x > y ? -1 : 0;
}
