import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientFacingDeliveryNote,
  deliveredPaymentDisplayAmount,
  hasDeliveredPaymentMismatch,
} from './delivery-payment.ts';

test('vendor-direct adds Paid to vendor to a neutral client note', () => {
  assert.equal(clientFacingDeliveryNote('vendor_direct', '—'), 'Paid to vendor');
});

test('vendor-direct preserves a meaningful delivery note', () => {
  assert.equal(clientFacingDeliveryNote('vendor_direct', 'Bought 1'), 'Paid to vendor · Bought 1');
});

test('vendor-direct displays the vendor-paid order value without a false shortfall', () => {
  const payment = {
    paymentMethod: 'vendor_direct',
    paid: 0,
    customerPrice: 19_500,
  };
  assert.equal(deliveredPaymentDisplayAmount(payment), 19_500);
  assert.equal(hasDeliveredPaymentMismatch(payment), false);
});

test('ordinary under-collection still shows a mismatch', () => {
  assert.equal(
    hasDeliveredPaymentMismatch({
      paymentMethod: 'transfer',
      paid: 13_500,
      customerPrice: 19_500,
    }),
    true,
  );
});
