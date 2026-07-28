const NEUTRAL_DELIVERY_NOTE = '—';

// Local mirror of lib/format's formatNaira for the non-null case. This file
// stays import-free on purpose: delivery-payment.test.mjs runs it under plain
// `node --test` (no Metro, no '@/' alias, no extensionless ESM resolution).
function naira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/** Payment facts for annotating the client-facing note. `outstanding` is
 *  customer_price − paid — the one figure BOTH reconcile paths can supply.
 *  The rep RPC deliberately strips `paid` itself (paid − remit − cash_pos_fee
 *  would let a rep derive the Reda fee); the difference derives nothing, so the
 *  admin and rep share messages stay byte-identical without widening the rep's
 *  view. */
export type ClientNotePayment = {
  paymentMethod: string | null | undefined;
  /** customer_price − paid. Null/undefined = paid never recorded (no claim). */
  outstanding?: number | null;
};

/**
 * Add payment context to the client-facing delivery note.
 * - Vendor-direct orders store `paid = 0` because Reda collected nothing, so the
 *   note must say where the customer's payment went instead of leaving an
 *   unexplained negative remit. (Checked first: a vendor-direct row's
 *   outstanding is the whole order value by construction, not a mismatch.)
 * - Otherwise, a customer who paid less/more than the order total must be
 *   called out — the vendor sees the changed remit and needs to know why.
 */
export function clientFacingDeliveryNote(payment: ClientNotePayment, note: string): string {
  if (payment.paymentMethod === 'vendor_direct') {
    const trimmed = note.trim();
    if (!trimmed || trimmed === NEUTRAL_DELIVERY_NOTE) return 'Paid to vendor';
    return `Paid to vendor · ${trimmed}`;
  }
  const diff = payment.outstanding == null ? 0 : Number(payment.outstanding);
  if (diff === 0) return note;
  const mismatch =
    diff > 0 ? `Customer paid ${naira(diff)} less` : `Customer paid ${naira(-diff)} extra`;
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
