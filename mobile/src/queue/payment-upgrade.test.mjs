import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverPaymentUpgradeJobs } from './payment-upgrade.ts';

test('upgrade replays only contract-blocked jobs with original identity and occurrence', () => {
  const blocked = {
    id: 'local-id',
    clientUuid: 'request-id',
    createdAt: 1234,
    enqueuedByUserId: 'rider',
    status: 'dead_letter',
    attempts: 8,
    nextAttemptAt: 2000,
    lastError: 'Update REDA before continuing. Rider payment rules have changed.',
    args: { deliveryId: 'order' },
  };
  const denied = { ...blocked, id: 'denied', lastError: 'permission denied' };
  const result = recoverPaymentUpgradeJobs([blocked, denied], 9000);
  assert.deepEqual(result[0], {
    ...blocked,
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextAttemptAt: 9000,
  });
  assert.equal(result[1], denied);
  assert.equal(blocked.status, 'dead_letter');
  assert.equal(recoverPaymentUpgradeJobs(result, 10000), result);
});
