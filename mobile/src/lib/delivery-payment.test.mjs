import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientFacingDeliveryNote,
  deliveredPaymentDisplayAmount,
  hasDeliveredPaymentMismatch,
} from './delivery-payment.ts';

test('vendor-direct adds Paid to vendor to a neutral client note', () => {
  assert.equal(clientFacingDeliveryNote({ paymentMethod: 'vendor_direct' }, '—'), 'Paid to vendor');
});

test('vendor-direct preserves a meaningful delivery note', () => {
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'vendor_direct' }, 'Bought 1'),
    'Paid to vendor · Bought 1',
  );
});

test('vendor-direct takes precedence over its by-construction outstanding', () => {
  // A vendor-direct row's outstanding is the whole order value (paid = 0) —
  // that is not a payment mismatch and must not read like one.
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'vendor_direct', outstanding: 19_500 }, '—'),
    'Paid to vendor',
  );
});

test('short payment is called out on a neutral note (card 2026-07-28)', () => {
  // 17,950 agreed, 17,500 paid → outstanding 450.
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: 450 }, '—'),
    'Customer paid ₦450 less',
  );
});

test('short payment composes with a meaningful note', () => {
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: 450 }, 'Delivered 1 of 2'),
    'Customer paid ₦450 less · Delivered 1 of 2',
  );
});

test('extra payment is called out too', () => {
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: -500 }, '—'),
    'Customer paid ₦500 extra',
  );
});

test('exact payment leaves the note untouched', () => {
  assert.equal(clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: 0 }, '—'), '—');
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'cash', outstanding: 0 }, 'Bought 1'),
    'Bought 1',
  );
});

test('unrecorded paid makes no claim', () => {
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: null }, '—'),
    '—',
  );
  assert.equal(clientFacingDeliveryNote({ paymentMethod: 'transfer' }, 'Bought 1'), 'Bought 1');
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
