import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMovementSummary } from './stock-movement-summary.ts';

test('company-wide paired movements remain visible without changing company net', () => {
  const { periods, total } = groupMovementSummary(
    [
      {
        period_start: '2026-07-13',
        reason: 'warehouse_issue',
        qty: 0,
        activity_qty: 2,
      },
      {
        period_start: '2026-07-14',
        reason: 'warehouse_return',
        qty: 0,
        activity_qty: 1,
      },
      {
        period_start: '2026-07-17',
        reason: 'warehouse_issue',
        qty: 0,
        activity_qty: 1,
      },
      {
        period_start: '2026-07-18',
        reason: 'warehouse_return',
        qty: 0,
        activity_qty: 1,
      },
    ],
    true,
  );

  assert.equal(total.warehouseIssues, 3);
  assert.equal(total.warehouseReturns, 2);
  assert.equal(total.net, 0);
  assert.deepEqual(
    periods.map((period) => period.period_start),
    ['2026-07-18', '2026-07-17', '2026-07-14', '2026-07-13'],
  );
});

test('delivery reversals are separate from warehouse returns', () => {
  const { total } = groupMovementSummary(
    [
      { period_start: '2026-07-15', reason: 'bulk_intake', qty: 1, activity_qty: 0 },
      { period_start: '2026-07-15', reason: 'delivered', qty: -21, activity_qty: 0 },
      {
        period_start: '2026-07-15',
        reason: 'delivery_returned',
        qty: 1,
        activity_qty: 0,
      },
      {
        period_start: '2026-07-15',
        reason: 'warehouse_return',
        qty: 0,
        activity_qty: 9,
      },
    ],
    true,
  );

  assert.equal(total.received, 1);
  assert.equal(total.delivered, -21);
  assert.equal(total.deliveryReversed, 1);
  assert.equal(total.warehouseReturns, 9);
  assert.equal(total.net, -19);
});

test('holder-scoped summaries use the holder signed quantity', () => {
  const { total } = groupMovementSummary(
    [
      {
        period_start: '2026-07-18',
        reason: 'warehouse_return',
        qty: 2,
        activity_qty: 0,
      },
      {
        period_start: '2026-07-18',
        reason: 'warehouse_issue',
        qty: -1,
        activity_qty: 0,
      },
    ],
    false,
  );

  assert.equal(total.warehouseReturns, 2);
  assert.equal(total.warehouseIssues, -1);
  assert.equal(total.net, 1);
});

test('old-RPC zero rows do not create misleading empty period cards', () => {
  const { periods, total } = groupMovementSummary(
    [{ period_start: '2026-07-18', reason: 'warehouse_return', qty: 0 }],
    true,
  );

  assert.deepEqual(periods, []);
  assert.equal(total.net, 0);
});
