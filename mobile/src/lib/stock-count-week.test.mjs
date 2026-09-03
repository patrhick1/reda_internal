import test from 'node:test';
import assert from 'node:assert/strict';
import { stockCountWeek, shiftCountWeek } from './stock-count-week.ts';

test('Saturday starts a new count cycle; Sunday through Friday belong to it', () => {
  assert.equal(stockCountWeek('2026-08-29'), '2026-08-29');
  assert.equal(stockCountWeek('2026-08-30'), '2026-08-29');
  assert.equal(stockCountWeek('2026-09-04'), '2026-08-29');
  assert.equal(stockCountWeek('2026-09-05'), '2026-09-05');
});
test('count weeks cross month and year boundaries without local timezone drift', () => {
  assert.equal(stockCountWeek('2027-01-01'), '2026-12-26');
  assert.equal(shiftCountWeek('2026-12-26', 1), '2027-01-02');
  assert.equal(shiftCountWeek('2027-01-02', -1), '2026-12-26');
});
