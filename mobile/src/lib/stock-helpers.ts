// Stock-related pure helpers shared between the Stock Overview, warehouse
// home, agent My-stock tab, and any future stock surface. Centralising the
// "low" threshold + status predicates here prevents drift — without this,
// any tweak to LOW_STOCK_THRESHOLD has to be made in three places and
// inevitably one gets missed.
import type { StockMatrixRow } from '@/services/stock';
import { isWarehousePlace, type AppUser } from '@/services/users';

/** Rows at or below this on-hand count render in the "low" amber colour
 *  and are counted on the hero LOW chip. 0 is intentionally NOT low — it
 *  represents "nothing to issue", which is a different problem (no stock
 *  to give) vs. low (some stock, restock soon). Negative is its own bucket. */
export const LOW_STOCK_THRESHOLD = 3;

export function isLow(qty: number): boolean {
  return qty > 0 && qty <= LOW_STOCK_THRESHOLD;
}

export function isNegative(qty: number): boolean {
  return qty < 0;
}

export type HolderStats = {
  totalUnits: number;
  productCount: number;
  lowCount: number;
  negativeCount: number;
  /** Top N "needs attention" items, ordered: negative first (worst gap,
   *  most negative), then low (smallest qty first). Drives the per-card
   *  problem chip strip. Empty when the holder has no issues. */
  topProblems: { product_name: string; product_catalog_id: string; quantity_on_hand: number }[];
};

export function getHolderStats(rows: StockMatrixRow[], holderId: string, topN = 3): HolderStats {
  let totalUnits = 0;
  let lowCount = 0;
  let negativeCount = 0;
  const products = new Set<string>();
  const problems: HolderStats['topProblems'] = [];

  for (const r of rows) {
    if (r.user_id !== holderId) continue;
    totalUnits += r.quantity_on_hand;
    products.add(r.product_catalog_id);
    if (isNegative(r.quantity_on_hand)) {
      negativeCount += 1;
      problems.push({
        product_name: r.product_name,
        product_catalog_id: r.product_catalog_id,
        quantity_on_hand: r.quantity_on_hand,
      });
    } else if (isLow(r.quantity_on_hand)) {
      lowCount += 1;
      problems.push({
        product_name: r.product_name,
        product_catalog_id: r.product_catalog_id,
        quantity_on_hand: r.quantity_on_hand,
      });
    }
  }

  // Sort: most-negative first, then ascending qty (smallest-low first).
  // Pure compare — no mutation outside the local array.
  problems.sort((a, b) => a.quantity_on_hand - b.quantity_on_hand);

  return {
    totalUnits,
    productCount: products.size,
    lowCount,
    negativeCount,
    topProblems: problems.slice(0, topN),
  };
}

/** Aggregate stats across the whole matrix — drives the Stock Overview
 *  hero card. Rows are pre-filtered to non-zero by listCurrentStock so
 *  productCount here = (holder, product) tuples that hold any stock. */
export type OverviewStats = {
  totalUnits: number;
  lowCount: number;
  negativeCount: number;
  /** Number of HOLDERS (not rows) that have at least one low item. */
  lowHolderCount: number;
  /** Number of HOLDERS with at least one negative row. */
  negativeHolderCount: number;
};

export function getOverviewStats(rows: StockMatrixRow[]): OverviewStats {
  let totalUnits = 0;
  let lowCount = 0;
  let negativeCount = 0;
  const lowHolders = new Set<string>();
  const negHolders = new Set<string>();
  for (const r of rows) {
    totalUnits += r.quantity_on_hand;
    if (isNegative(r.quantity_on_hand)) {
      negativeCount += 1;
      negHolders.add(r.user_id);
    } else if (isLow(r.quantity_on_hand)) {
      lowCount += 1;
      lowHolders.add(r.user_id);
    }
  }
  return {
    totalUnits,
    lowCount,
    negativeCount,
    lowHolderCount: lowHolders.size,
    negativeHolderCount: negHolders.size,
  };
}

/** Resolved warehouse holder, or a reason the warehouse-scope stock screens
 *  should block submission. */
export type WarehouseHolder =
  | { ok: true; holderId: string; placeName: string }
  | { ok: false; reason: string };

/**
 * Resolve the warehouse PLACE that a warehouse user acts on, for the
 * warehouse-scope stock screens (Transfer / Receive / Adjust).
 *
 * The holder the server sees must be the PLACE — never a staff member's own
 * user id. Warehouse STAFF (users.warehouse_id set) hold no stock; the place
 * is always the holder (agent_id). Sending a staff member's own id makes
 * create_stock_transfer / create_stock_adjustment raise 42501 (permission
 * denied) — the server gate requires `from = coalesce(warehouse_id, self)`.
 * That rejection is the "transferring stock just spins, so we use the
 * dispatcher account instead" report: a silent fall-back to `currentUser.userId`
 * sent the wrong holder.
 *
 * We resolve against the loaded `users` list (the authoritative warehouse_id),
 * with the auth-provided `warehouseId` as a fallback, and refuse to guess when
 * the place can't be determined — fail loud rather than enqueue a transfer the
 * server will reject.
 */
export function resolveWarehouseHolder(
  currentUser: { userId: string; warehouseId: string | null; displayName: string },
  users: AppUser[] | undefined,
): WarehouseHolder {
  const selfRow = (users ?? []).find((u) => u.id === currentUser.userId);
  // Most-trusted source first: the loaded self row's warehouse_id (staff → their
  // place), then the auth-provided warehouseId (same value; covers users not yet
  // loaded), then — only if the user IS a place — themselves.
  const placeId =
    selfRow?.warehouse_id ??
    currentUser.warehouseId ??
    (selfRow && isWarehousePlace(selfRow) ? selfRow.id : null);

  if (!placeId) {
    return {
      ok: false,
      reason: "Couldn't determine your warehouse — update the app or contact an admin.",
    };
  }

  // When the users list is loaded, confirm the resolved holder is an active
  // warehouse place (not a deactivated or mis-linked row).
  const placeRow = (users ?? []).find((u) => u.id === placeId);
  if (placeRow && !(placeRow.is_active && isWarehousePlace(placeRow))) {
    return { ok: false, reason: "Your warehouse isn't set up correctly — contact an admin." };
  }

  const placeName =
    placeId === currentUser.userId
      ? currentUser.displayName
      : (placeRow?.display_name ?? 'your warehouse');

  return { ok: true, holderId: placeId, placeName };
}
