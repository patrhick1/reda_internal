const NEUTRAL_DELIVERY_NOTE = '—';

// Local mirror of lib/format's formatNaira for the non-null case. This file
// stays import-free on purpose: delivery-payment.test.mjs runs it under plain
// `node --test` (no Metro, no '@/' alias, no extensionless ESM resolution).
function naira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/** Payment facts for annotating the client-facing note. `outstanding` is used
 *  only to decide whether a payment note is needed; when it is, the note states
 *  the amount the customer actually paid rather than framing the difference as
 *  money still owed. */
export type ClientNotePayment = {
  paymentMethod: string | null | undefined;
  /** Amount actually collected from the customer. */
  paid?: number | null;
  /** customer_price − paid. Null/undefined = paid never recorded (no claim). */
  outstanding?: number | null;
};

/**
 * Add payment context to the client-facing delivery note.
 * - Vendor-direct orders store `paid = 0` because Reda collected nothing, so the
 *   note must say where the customer's payment went instead of leaving an
 *   unexplained negative remit. (Checked first: a vendor-direct row's
 *   outstanding is the whole order value by construction, not a mismatch.)
 * - Otherwise, when the amount differs from the original order total, state
 *   what the customer actually paid. This is neutral for partial purchases:
 *   "Customer paid ₦35,500 · Bought 3", not "paid ₦11,000 less".
 */
export function clientFacingDeliveryNote(payment: ClientNotePayment, note: string): string {
  if (payment.paymentMethod === 'vendor_direct') {
    const trimmed = note.trim();
    if (!trimmed || trimmed === NEUTRAL_DELIVERY_NOTE) return 'Paid to vendor';
    return `Paid to vendor · ${trimmed}`;
  }
  const diff = payment.outstanding == null ? 0 : Number(payment.outstanding);
  if (diff === 0) return note;
  const paid = payment.paid == null ? null : Number(payment.paid);
  if (paid == null || !Number.isFinite(paid)) return note;
  const mismatch = `Customer paid ${naira(paid)}`;
  const trimmed = note.trim();
  if (!trimmed || trimmed === NEUTRAL_DELIVERY_NOTE) return mismatch;
  return `${mismatch} · ${trimmed}`;
}

/** The amount shown beside a delivered payment method on Delivery Detail. */
export function deliveredPaymentDisplayAmount(input: {
  paymentMethod: string | null | undefined;
  paid: number | null | undefined;
  customerPrice: number | null | undefined;
}): number | null {
  if (input.paymentMethod === 'vendor_direct') {
    return input.customerPrice == null ? null : Number(input.customerPrice);
  }
  return input.paid == null ? null : Number(input.paid);
}

/**
 * Whether Delivery Detail should show an under/over-collection warning.
 * Vendor-direct deliberately stores zero collected by Reda, so it can never be
 * an under-collection against the order value.
 */
export function hasDeliveredPaymentMismatch(input: {
  paymentMethod: string | null | undefined;
  paid: number | null | undefined;
  customerPrice: number | null | undefined;
}): boolean {
  if (
    input.paymentMethod === 'vendor_direct' ||
    input.paid == null ||
    input.customerPrice == null
  ) {
    return false;
  }
  return Number(input.paid) !== Number(input.customerPrice);
}
