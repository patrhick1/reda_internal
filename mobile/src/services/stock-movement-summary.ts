export type MovementSummaryReason =
  | 'bulk_intake'
  | 'warehouse_issue'
  | 'warehouse_return'
  | 'transfer'
  | 'correction'
  | 'loss'
  | 'theft'
  | 'damaged'
  | 'found'
  | 'delivered'
  | 'delivery_returned';

/**
 * One period/reason total from `stock_movement_summary`.
 *
 * `qty` is always the signed change to stock for the selected scope.
 * `activity_qty` is populated for company-wide internal movements so paired
 * holder legs remain visible even though their signed `qty` is zero.
 */
export type MovementSummaryRow = {
  period_start: string;
  reason: MovementSummaryReason;
  qty: number;
  activity_qty?: number | null;
};

export type MovementPeriod = {
  period_start: string;
  received: number;
  delivered: number;
  deliveryReversed: number;
  warehouseReturns: number;
  warehouseIssues: number;
  transfers: number;
  adjustments: number;
  net: number;
};

type MovementMetric = keyof Omit<MovementPeriod, 'period_start' | 'net'>;

const REASON_BUCKET: Record<MovementSummaryReason, MovementMetric> = {
  bulk_intake: 'received',
  found: 'received',
  delivered: 'delivered',
  delivery_returned: 'deliveryReversed',
  warehouse_return: 'warehouseReturns',
  warehouse_issue: 'warehouseIssues',
  transfer: 'transfers',
  correction: 'adjustments',
  loss: 'adjustments',
  theft: 'adjustments',
  damaged: 'adjustments',
};

const INTERNAL_REASONS = new Set<MovementSummaryReason>([
  'warehouse_issue',
  'warehouse_return',
  'transfer',
]);

const emptyPeriod = (period_start: string): MovementPeriod => ({
  period_start,
  received: 0,
  delivered: 0,
  deliveryReversed: 0,
  warehouseReturns: 0,
  warehouseIssues: 0,
  transfers: 0,
  adjustments: 0,
  net: 0,
});

/**
 * Fold raw RPC rows into display periods and a range total.
 *
 * For a company-wide summary, paired holder movements use `activity_qty` for
 * display while their signed `qty` (normally zero) drives the net. A
 * holder-scoped summary continues to display and net that holder's signed leg.
 */
export function groupMovementSummary(
  rows: MovementSummaryRow[],
  companyWide = false,
): {
  periods: MovementPeriod[];
  total: MovementPeriod;
} {
  const byPeriod = new Map<string, MovementPeriod>();
  const total = emptyPeriod('');

  for (const row of rows) {
    const netQty = Number(row.qty) || 0;
    const shownQty =
      companyWide && INTERNAL_REASONS.has(row.reason) ? Number(row.activity_qty) || 0 : netQty;

    // During a staggered rollout, the old RPC has no activity_qty and returns
    // no useful display/net value for a zeroed pair. Keep that transient row
    // from producing a misleading empty period card.
    if (shownQty === 0 && netQty === 0) continue;

    let period = byPeriod.get(row.period_start);
    if (!period) {
      period = emptyPeriod(row.period_start);
      byPeriod.set(row.period_start, period);
    }

    const bucket = REASON_BUCKET[row.reason];
    period[bucket] += shownQty;
    period.net += netQty;
    total[bucket] += shownQty;
    total.net += netQty;
  }

  const periods = [...byPeriod.values()].sort((a, b) =>
    b.period_start.localeCompare(a.period_start),
  );
  return { periods, total };
}
