import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesDeliverySearch, phoneSearchKey, deliverySearchFilter } from './delivery-search.ts';

const formats = [
  '08033165485',
  '+234 803 316 5485',
  '2348033165485',
  '8033165485',
  '0803-316-5485',
  '(0803) 316 5485',
  '00234 8033165485',
  '+234 (0) 8033165485',
];
test('all Nigerian representations match primary and alternate contacts', () => {
  for (const saved of formats)
    for (const query of formats) {
      assert.equal(
        matchesDeliverySearch({ customer_phone: saved }, query),
        true,
        `${saved}: ${query}`,
      );
      assert.equal(
        matchesDeliverySearch({ customer_phone: '09099999999', customer_phone_alt: saved }, query),
        true,
      );
      assert.equal(phoneSearchKey(saved), '8033165485');
    }
});
test('partial digits, names and empty searches retain useful behaviour', () => {
  const row = { customer_name: 'Ada Okoro', customer_phone: '+234 803 316 5485' };
  for (const query of ['803', '033', '65485', ' ADA ', 'okoro', ''])
    assert(matchesDeliverySearch(row, query));
  for (const query of ['08033165486', '80', 'xyz'])
    assert.equal(matchesDeliverySearch(row, query), false);
  assert(matchesDeliverySearch({ customer_phone: '08031234000' }, '031'));
  assert(matchesDeliverySearch({ customer_phone: '08031234000' }, '234'));
  assert.equal(matchesDeliverySearch({ customer_phone: null }, '234'), false);
});
test('PostgREST grammar characters cannot add filter clauses', () => {
  const filter = deliverySearchFilter('Ada%_,()"\\*');
  assert.equal(filter, 'customer_name.ilike.%Ada%');
  assert.match(
    deliverySearchFilter('+234 (803) 316-5485'),
    /customer_phone_search\.ilike\.%8033165485%/,
  );
  assert.match(
    deliverySearchFilter('08033165485'),
    /customer_phone_alt_search\.ilike\.%8033165485%/,
  );
});
