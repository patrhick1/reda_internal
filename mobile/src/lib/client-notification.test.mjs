import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitsClientNotification,
  closureLabel,
  agentCanSelectStatus,
} from './client-notification.ts';
test('automatic causes are excluded across callers of the shared predicate', () => {
  for (const status of ['cancelled', 'failed_delivery'])
    assert.equal(
      awaitsClientNotification({
        current_status: status,
        latest_notified: false,
        notification_required: false,
      }),
      false,
    );
});
test('genuine cancellations/failures remain actionable irrespective of client toggle', () => {
  for (const status of ['cancelled', 'failed_delivery'])
    for (const policy of [true, false])
      assert.equal(
        awaitsClientNotification({
          current_status: status,
          notification_required: true,
          client_auto_cancel_soft_fails: policy,
        }),
        true,
      );
});
test('event already notified is hidden; later unnotified event reappears', () => {
  const row = { current_status: 'cancelled', notification_required: true };
  assert.equal(awaitsClientNotification({ ...row, latest_notified: true }), false);
  assert.equal(awaitsClientNotification({ ...row, latest_notified: false }), true);
});
test('older projections conservatively preserve actionable failures and exempt pending/delivered', () => {
  assert.equal(
    awaitsClientNotification({
      current_status: 'failed_delivery',
      client_auto_cancel_soft_fails: true,
    }),
    true,
  );
  for (const s of ['pending', 'delivered', 'rolled_over'])
    assert.equal(awaitsClientNotification({ current_status: s }), false);
});
test('closure labels distinguish bookkeeping without relabeling genuine cancellation', () => {
  assert.equal(closureLabel('cancelled', 'duplicate'), 'Closed — duplicate');
  assert.equal(closureLabel('failed_delivery', 'client_policy'), 'Closed — client policy');
  assert.equal(closureLabel('cancelled', null), undefined);
  assert.equal(closureLabel('available', 'duplicate'), undefined);
});
test('agents cannot select cancelled/failed, but normal statuses remain available', () => {
  assert.equal(agentCanSelectStatus('cancelled'), false);
  assert.equal(agentCanSelectStatus('failed_delivery'), false);
  for (const s of ['available', 'tomorrow', 'postponed', 'follow_up'])
    assert.equal(agentCanSelectStatus(s), true);
});
