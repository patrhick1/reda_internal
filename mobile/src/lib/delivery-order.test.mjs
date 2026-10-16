import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareDeliveryActivity } from './delivery-order.ts';

test('recent postponed activity ranks above an older ordinary order', () => {
  const rows = [
    { id: 'older', activity_at: '2026-10-16T08:00:00Z' },
    { id: 'postponed', activity_at: '2026-10-16T10:00:00Z', created_at: '2026-10-15T10:00:00Z' },
  ];
  assert.deepEqual(rows.sort(compareDeliveryActivity).map(r => r.id), ['postponed', 'older']);
});
test('activity wins over creation date and carries across calendar boundaries', () => {
  const rows = [
    { id: 'created-newer', created_at: '2026-10-16T08:00:00Z', activity_at: '2026-10-16T08:00:00Z' },
    { id: 'message-newer', created_at: '2026-10-15T08:00:00Z', activity_at: '2026-10-17T00:00:00Z' },
  ];
  assert.deepEqual(rows.sort(compareDeliveryActivity).map(r => r.id), ['message-newer', 'created-newer']);
});
test('missing activity falls back to creation; missing dates sort last', () => {
  const rows = [{ id: 'missing' }, { id: 'fallback', activity_at: null, created_at: '2026-10-16T09:00:00Z' }, { id: 'older', activity_at: '2026-10-16T08:00:00Z' }];
  assert.deepEqual(rows.sort(compareDeliveryActivity).map(r => r.id), ['fallback', 'older', 'missing']);
});
test('equal timestamps retain stable input order', () => {
  const rows = ['a', 'b', 'c'].map(id => ({ id, activity_at: '2026-10-16T08:00:00Z' }));
  assert.deepEqual(rows.sort(compareDeliveryActivity).map(r => r.id), ['a', 'b', 'c']);
});
