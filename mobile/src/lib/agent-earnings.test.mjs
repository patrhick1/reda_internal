import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeReplacementEarnings } from './agent-earnings.ts';

const pending = { agent_id: 'a', agent_name: 'Rider', deliveries_count: 2, total_quantity: 2,
  total_earnings: null, total_collected: 20000, total_remit: null, known_earnings: 3000, pending_pay_count: 1 };
test('replacement pay adds to known earnings without resolving pending ordinary pay', () => {
  const [row] = mergeReplacementEarnings([pending], [{ agent_id: 'a', agent_name: 'Rider',
    agent_payment: 500, payment_received_by: 'rider', customer_paid: 1000 }]);
  assert.equal(row.total_earnings, null);
  assert.equal(row.total_remit, null);
  assert.equal(row.known_earnings, 3500);
  assert.equal(row.total_collected, 21000);
  assert.equal(row.pending_pay_count, 1);
  assert.equal(pending.known_earnings, 3000);
});
test('replacement-only rider uses own rate and excludes money received by the vendor', () => {
  const [row] = mergeReplacementEarnings([], [{ agent_id: 'a', agent_name: 'Rider',
    agent_payment: 700, payment_received_by: 'vendor', customer_paid: 1000 }]);
  assert.equal(row.total_earnings, 700);
  assert.equal(row.known_earnings, 700);
  assert.equal(row.total_collected, 0);
  assert.equal(row.total_remit, -700);
  assert.equal(row.pending_pay_count, 0);
});
