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

test('short payment states the amount actually paid on a neutral note', () => {
  // 17,950 agreed, 17,500 paid → outstanding 450.
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', paid: 17_500, outstanding: 450 }, '—'),
    'Customer paid ₦17,500',
  );
});

test('partial purchase states actual payment and quantity bought (card 2026-08-13)', () => {
  assert.equal(
    clientFacingDeliveryNote(
      { paymentMethod: 'transfer', paid: 35_500, outstanding: 11_000 },
      'Bought 3',
    ),
    'Customer paid ₦35,500 · Bought 3',
  );
});

test('extra payment also states the amount actually paid', () => {
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', paid: 18_450, outstanding: -500 }, '—'),
    'Customer paid ₦18,450',
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
  assert.equal(
    clientFacingDeliveryNote({ paymentMethod: 'transfer', outstanding: 450 }, 'Bought 1'),
    'Bought 1',
  );
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
