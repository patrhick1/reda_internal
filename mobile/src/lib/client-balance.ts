/** Shared display/accounting helpers for client reconciliation. The database is
 * the authority for the running balance; these helpers only choose which figure
 * the UI should present while clients are migrated incrementally. */
export type ClientBalanceLike = {
  total_remit: number;
  balance_tracking?: boolean;
  balance_before_period?: number;
  period_activity?: number;
  payouts_in_period?: number;
  current_balance?: number;
};

/** Signed amount shown as the client's current position. Legacy clients retain
 * the old date-range remit until an opening balance is configured. */
export function displayedClientBalance(row: ClientBalanceLike): number {
  return row.balance_tracking ? Number(row.current_balance ?? 0) : Number(row.total_remit ?? 0);
}

/** Only a positive balance can be paid. Negative balances carry forward. */
export function clientAmountPayable(row: ClientBalanceLike): number {
  return Math.max(0, displayedClientBalance(row));
}

/** Whether to offer "Record payment received" for a tracked client: they close
 * the range owing Reda, OR they entered it owing (a same-day delivery may have
 * already netted a transfer that still needs recording — the closing figure
 * alone would hide it). The server computes the exact per-day cap
 * (client_payment_limit); this only decides whether to show the action. */
export function clientMayOweReda(row: ClientBalanceLike): boolean {
  if (!row.balance_tracking) return false;
  return (
    Number(row.current_balance ?? 0) < -0.005 || Number(row.balance_before_period ?? 0) < -0.005
  );
}

export type ClientBalanceDirection = 'reda_owes_client' | 'client_owes_reda' | 'clear';

export function clientBalanceDirection(row: ClientBalanceLike): ClientBalanceDirection {
  const amount = displayedClientBalance(row);
  if (amount > 0.005) return 'reda_owes_client';
  if (amount < -0.005) return 'client_owes_reda';
  return 'clear';
}
