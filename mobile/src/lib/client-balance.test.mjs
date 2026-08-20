import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clientAmountPayable,
  clientBalanceDirection,
  displayedClientBalance,
} from './client-balance.ts';

test('legacy clients keep the selected range remit', () => {
  const row = { total_remit: -2_000, balance_tracking: false, current_balance: 99_000 };
  assert.equal(displayedClientBalance(row), -2_000);
  assert.equal(clientAmountPayable(row), 0);
  assert.equal(clientBalanceDirection(row), 'client_owes_reda');
});

test('tracked clients use carried balance and expose only positive amount as payable', () => {
  const row = {
    total_remit: 9_500,
    balance_tracking: true,
    balance_before_period: -2_000,
    period_activity: 9_500,
    current_balance: 7_500,
  };
  assert.equal(displayedClientBalance(row), 7_500);
  assert.equal(clientAmountPayable(row), 7_500);
  assert.equal(clientBalanceDirection(row), 'reda_owes_client');
});

test('partial payout leaves only the residual balance payable', () => {
  const row = {
    total_remit: 9_500,
    balance_tracking: true,
    payouts_in_period: 5_000,
    current_balance: 2_500,
  };
  assert.equal(clientAmountPayable(row), 2_500);
});

test('near-zero rounding differences are treated as clear', () => {
  assert.equal(
    clientBalanceDirection({ total_remit: 0, balance_tracking: true, current_balance: 0.004 }),
    'clear',
  );
});
