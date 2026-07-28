const NEUTRAL_DELIVERY_NOTE = '—';

/**
 * Add payment context to the client-facing delivery note. Vendor-direct orders
 * store `paid = 0` because Reda collected nothing, so the note must say where
 * the customer's payment went instead of leaving an unexplained negative remit.
 */
export function clientFacingDeliveryNote(
  paymentMethod: string | null | undefined,
  note: string,
): string {
  if (paymentMethod !== 'vendor_direct') return note;
  const trimmed = note.trim();
  if (!trimmed || trimmed === NEUTRAL_DELIVERY_NOTE) return 'Paid to vendor';
  return `Paid to vendor · ${trimmed}`;
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
