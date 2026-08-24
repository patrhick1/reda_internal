import assert from 'node:assert/strict';
import test from 'node:test';

import { isRedaWorkingDay, workingDayWindowStart } from './rate-trend.ts';

test('Sunday is excluded from Reda working days', () => {
  assert.equal(isRedaWorkingDay('2026-08-16'), false);
  assert.equal(isRedaWorkingDay('2026-08-17'), true);
  assert.equal(isRedaWorkingDay('2026-08-18'), true);
});

test('six-day home window keeps six separate working days', () => {
  assert.equal(workingDayWindowStart('2026-08-18', 6), '2026-08-12');
});

test('Monday shows the prior Tuesday-Saturday plus today as six daily bars', () => {
  assert.equal(workingDayWindowStart('2026-08-24', 6), '2026-08-18');
});

test('a Sunday endpoint still finds the previous six working days', () => {
  assert.equal(workingDayWindowStart('2026-08-16', 6), '2026-08-10');
});
