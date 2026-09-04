import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coverByProduct,
  coverLabel,
  isLowOnCover,
  isUrgentCover,
  needsRestock,
  restockStats,
  withOutOfStock,
} from '../lib/restock-signal.ts';

/** Minimal RestockRow. Only the fields the pure helpers read are meaningful. */
const row = (over = {}) => ({
  product_catalog_id: 'p1',
  product_name: 'Bubble Cleaner',
  client_name: 'Elite Store',
  warehouse_qty: 34,
  units_out: 470,
  selling_days: 24,
  qty_open: 7,
  rate_per_day: 19.58,
  days_cover: 1.74,
  tier: 'reorder',
  ...over,
});

const stockRow = (over = {}) => ({
  user_id: 'w1',
  user_email: '',
  user_display_name: 'Shomolu warehouse',
  user_role: 'warehouse',
  product_catalog_id: 'p1',
  product_name: 'Bubble Cleaner',
  client_id: 'c1',
  client_name: 'Elite Store',
  quantity_on_hand: 34,
  is_active: true,
  ...over,
});

test('a product is low on TIME, not on units', () => {
  // 34 units looks healthy; at ~20/day it is under two days out. This is the
  // case the flat "3 or fewer" rule could never see.
  assert.equal(isLowOnCover(row({ warehouse_qty: 34, days_cover: 1.74 })), true);
  // 1 unit of something selling once a month is 24 days of cover — not low.
  assert.equal(isLowOnCover(row({ warehouse_qty: 1, days_cover: 24, tier: 'ok' })), false);
});

test('a product with no recent sales is never "low" — nothing to reorder', () => {
  assert.equal(isLowOnCover(undefined), false);
  assert.equal(isUrgentCover(undefined), false);
  assert.equal(coverLabel(undefined), null);
});

test('out and critical are urgent; reorder can wait for the next order run', () => {
  assert.equal(isUrgentCover(row({ tier: 'out' })), true);
  assert.equal(isUrgentCover(row({ tier: 'critical' })), true);
  assert.equal(isUrgentCover(row({ tier: 'reorder' })), false);
  assert.equal(isUrgentCover(row({ tier: 'ok' })), false);
});

test('cover is phrased in days, and an empty shelf says so plainly', () => {
  assert.equal(coverLabel(row({ warehouse_qty: 0, tier: 'out' })), 'Nothing left');
  assert.equal(coverLabel(row({ warehouse_qty: 1, days_cover: 0.31 })), 'Under a day left');
  assert.equal(coverLabel(row({ warehouse_qty: 3, days_cover: 1.09 })), 'About a day left');
  assert.equal(coverLabel(row({ warehouse_qty: 34, days_cover: 1.74 })), 'About 2 days left');
});

test('restockStats leads with the worst row and counts urgency separately', () => {
  const rows = [
    row({ product_catalog_id: 'a', product_name: 'Date', tier: 'out', days_cover: 0 }),
    row({ product_catalog_id: 'b', product_name: 'Batana Oil', tier: 'critical', days_cover: 0.31 }),
    row({ product_catalog_id: 'c', product_name: 'Bubble Cleaner', tier: 'reorder' }),
    row({ product_catalog_id: 'd', product_name: 'Gallant Max', tier: 'ok', days_cover: 22 }),
  ];
  const stats = restockStats(rows);
  assert.equal(stats.total, 3, 'ok rows are not actionable');
  assert.equal(stats.urgent, 2, 'out + critical only');
  assert.equal(stats.topName, 'Date', 'the RPC returns worst-first; keep that order');
  assert.equal(needsRestock(rows).length, 3);
});

test('coverByProduct tolerates a missing signal', () => {
  assert.equal(coverByProduct(null).size, 0);
  assert.equal(coverByProduct(undefined).size, 0);
  assert.equal(coverByProduct([row()]).get('p1')?.tier, 'reorder');
});

// The regression this whole helper exists for: current_stock is
// `HAVING sum(quantity_delta) <> 0`, so a product at exactly zero has no row
// and would be missing from every stock list — the most urgent state, invisible.
test('out-of-stock products are re-admitted to a stock list', () => {
  const held = [stockRow()];
  const cover = [
    row(),
    row({ product_catalog_id: 'p2', product_name: 'Oud Al Layl', warehouse_qty: 0, tier: 'out' }),
  ];
  const merged = withOutOfStock(held, cover, { id: 'w1', role: 'warehouse' });
  assert.equal(merged.length, 2);
  const added = merged.find((r) => r.product_catalog_id === 'p2');
  assert.equal(added.quantity_on_hand, 0);
  assert.equal(added.product_name, 'Oud Al Layl');
  assert.equal(added.user_id, 'w1', 'must belong to the holder or the list filters it out');
});

test('re-admitting never duplicates a product the list already holds', () => {
  // A NEGATIVE balance does have a current_stock row and is also tier 'out'.
  const held = [stockRow({ quantity_on_hand: -2 })];
  const cover = [row({ warehouse_qty: -2, tier: 'out' })];
  const merged = withOutOfStock(held, cover, { id: 'w1', role: 'warehouse' });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity_on_hand, -2, 'the real row wins, not a synthetic zero');
});

test('only tier "out" is re-admitted — a reorder row is already in the list', () => {
  const merged = withOutOfStock([], [row({ tier: 'reorder' })], { id: 'w1', role: 'warehouse' });
  assert.equal(merged.length, 0);
});

test('an absent signal leaves the list exactly as it was', () => {
  const held = [stockRow()];
  assert.equal(withOutOfStock(held, null, { id: 'w1', role: 'warehouse' }), held);
});
