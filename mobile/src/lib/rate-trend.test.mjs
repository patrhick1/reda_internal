import assert from 'node:assert/strict';
import test from 'node:test';

import { isRedaWorkingDay, workingDayWindowStart } from './rate-trend.ts';

test('Sunday is excluded from Reda working days', () => {
  assert.equal(isRedaWorkingDay('2026-08-16'), false);
  assert.equal(isRedaWorkingDay('2026-08-17'), true);
  assert.equal(isRedaWorkingDay('2026-08-18'), true);
});

test('seven-day home window pulls in the previous working day instead of Sunday', () => {
  assert.equal(workingDayWindowStart('2026-08-18', 7), '2026-08-11');
});

test('a Sunday endpoint still finds the previous seven working days', () => {
  assert.equal(workingDayWindowStart('2026-08-16', 7), '2026-08-08');
});
