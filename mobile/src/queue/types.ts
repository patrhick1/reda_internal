// Phase 9 — mutation queue types.
//
// Why these specific kinds: PRD §5.16 exit criterion calls out status updates,
// payment recording, and stock adjustments. Everything else (catalog CRUD,
// create-delivery, EOD rollover) is admin-only and happens at a desk on wifi.
// Adding those later is just a matter of registering an executor.

export type JobKind =
  | 'change_delivery_status'
  | 'create_stock_adjustment'
  | 'create_stock_transfer';

export type ChangeDeliveryStatusArgs = {
  deliveryId: string;
  toStatus: string;
  reason: string | null;
  notes: string | null;
  quantityDelivered: number | null;
  paid: number | null;
  paymentMethod: 'cash' | 'transfer' | null;
  /** YYYY-MM-DD. Only meaningful when toStatus = 'postponed' — the server
   *  ignores it otherwise. Required by the UI for postponed transitions;
   *  null for every other status. */
  newScheduledDate: string | null;
};

export type CreateStockAdjustmentArgs = {
  agentId: string;
  productCatalogId: string;
  quantityDelta: number;
  reason: 'loss' | 'theft' | 'damaged' | 'found' | 'correction' | 'bulk_intake';
  notes: string | null;
};

export type CreateStockTransferArgs = {
  fromUserId: string;
  toUserId: string;
  productCatalogId: string;
  quantity: number;
  reason: 'transfer' | 'warehouse_return' | 'warehouse_issue';
  notes: string | null;
};

export type JobArgs =
  | { kind: 'change_delivery_status'; args: ChangeDeliveryStatusArgs }
  | { kind: 'create_stock_adjustment'; args: CreateStockAdjustmentArgs }
  | { kind: 'create_stock_transfer';   args: CreateStockTransferArgs };

export type JobStatus = 'pending' | 'in_flight' | 'failed_retrying' | 'dead_letter';

/** A single queued mutation. `clientUuid` makes server-side retries safe;
 *  re-enqueuing the same job with the same uuid is a no-op on the server. */
export type Job = {
  id: string;                 // local UUID — distinct from clientUuid for dedup logs
  clientUuid: string;         // sent to the RPC for idempotency
  kind: JobKind;
  args: JobArgs['args'];
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  /** ms since epoch. Set to enqueue time, updated on each retry. */
  nextAttemptAt: number;
  /** ms since epoch. Used in UI ("queued 2m ago"). */
  createdAt: number;
  /** Human label for the dead-letter UI. e.g. "Mark delivered · Mr Adeyemi". */
  label: string;
};

/** Backoff schedule. Cap at 8 retries → goes to dead_letter on 9th failure.
 *  Numbers chosen so a transient outage is invisible (<30s) but a real
 *  problem stops hammering the server within ~5 minutes. */
export const BACKOFF_MS = [
  1_000,    // attempt 1 → wait 1s
  3_000,    // attempt 2 → 3s
  8_000,    // attempt 3 → 8s
  20_000,   // attempt 4 → 20s
  60_000,   // attempt 5 → 1m
  120_000,  // attempt 6 → 2m
  300_000,  // attempt 7 → 5m
  600_000,  // attempt 8 → 10m
];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

export type QueueSnapshot = {
  jobs: Job[];
  online: boolean;
  draining: boolean;
};

export type EnqueueInput<K extends JobKind> = {
  kind: K;
  args: Extract<JobArgs, { kind: K }>['args'];
  label: string;
};
