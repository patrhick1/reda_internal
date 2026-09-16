export type DeliveryPay = {
  delivery_id: string;
  mode: 'legacy' | 'final';
  state: 'legacy' | 'ready' | 'pending' | 'reversed' | 'not_earned';
  amount: number | null;
  /** Returned only to admins. */
  margin: number | null;
  business_date: string | null;
  multiplier: number | null;
  manual_exception: boolean;
};

/** Keep missing, reversed and someone else's earnings distinct from zero. */
export function deliveryPayLabel(pay: DeliveryPay | null | undefined): string | null {
  if (!pay) return null;
  if (pay.state === 'pending') return 'Pending review';
  if (pay.state === 'reversed') return 'Reversed';
  if (pay.state === 'not_earned') return 'Not earned by you';
  if (pay.amount == null) return 'Not set';
  return null;
}
