import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stockSignal, worstSignal, COMMITTED_STATUSES } from './stock-signal.ts';

test('remote confirmations change the warning when fresh coverage arrives', () => {
  const row = { on_hand_total: 7, qty_committed: 0, my_on_hand: 0 };
  assert.equal(stockSignal(row, 3, false), null);
  assert.equal(stockSignal({ ...row, qty_committed: 5 }, 3, false), 'committed');
  assert.equal(stockSignal({ ...row, on_hand_total: 0 }, 3, false), 'out');
});
test('personal stock remains sufficient regardless of fleet commitments', () => {
  const row = { on_hand_total: 7, qty_committed: 8, my_on_hand: 3 };
  assert.equal(stockSignal(row, 3, false), null);
  assert.equal(stockSignal({ ...row, my_on_hand: 2 }, 3, false), 'committed');
});
test('an order does not count its own confirmation against itself', () => {
  assert.deepEqual([...COMMITTED_STATUSES], ['available', 'available_evening']);
  const row = { on_hand_total: 3, qty_committed: 3, my_on_hand: 0 };
  assert.equal(stockSignal(row, 3, true), null);
  assert.equal(stockSignal(row, 3, false), 'committed');
});
test('unknown coverage remains silent; exhausted and negative fleet stock warn', () => {
  assert.equal(stockSignal(undefined, 3, false), null);
  for (const total of [0, -1])
    assert.equal(
      stockSignal({ on_hand_total: total, qty_committed: 0, my_on_hand: 0 }, 1, false),
      'out',
    );
});
test('multi-line warnings retain the strongest signal', () => {
  assert.equal(worstSignal([null, 'committed', 'out']), 'out');
  assert.equal(worstSignal([null, 'committed']), 'committed');
  assert.equal(worstSignal([null, null]), null);
});
