import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryPayLabel } from './delivery-pay.ts';

test('unresolved and reversed pay never becomes zero earned pay', () => {
  assert.equal(deliveryPayLabel({ state: 'pending', amount: null }), 'Pending review');
  assert.equal(deliveryPayLabel({ state: 'reversed', amount: null }), 'Reversed');
  assert.equal(deliveryPayLabel({ state: 'not_earned', amount: null }), 'Not earned by you');
  assert.equal(deliveryPayLabel({ state: 'legacy', amount: null }), 'Not set');
  assert.equal(deliveryPayLabel({ state: 'ready', amount: 0 }), null);
  assert.equal(deliveryPayLabel(undefined), null);
});
