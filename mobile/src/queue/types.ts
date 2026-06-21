// Phase 9 — mutation queue types.
//
// Why these specific kinds: PRD §5.16 exit criterion calls out status updates,
// payment recording, and stock adjustments. Everything else (catalog CRUD,
// create-delivery, EOD rollover) is admin-only and happens at a desk on wifi.
// Adding those later is just a matter of registering an executor.

import type { IssueType } from '@/services/delivery-messages';

export type JobKind =
  | 'change_delivery_status'
  | 'flag_delivery'
  | 'create_stock_adjustment'
  | 'create_stock_transfer'
  | 'return_delivery_leftover'
  | 'agent_change_delivery_location';

export type ChangeDeliveryStatusArgs = {
  deliveryId: string;
  toStatus: string;
  reason: string | null;
  notes: string | null;
  quantityDelivered: number | null;
  paid: number | null;
  paymentMethod: 'cash' | 'transfer' | 'vendor_direct' | null;
  /** YYYY-MM-DD. Only meaningful when toStatus = 'postponed' — the server
   *  ignores it otherwise. Required by the UI for postponed transitions;
   *  null for every other status. */
  newScheduledDate: string | null;
  /** [Feature A] Per-line delivered quantities for 'delivered' on multi-product
   *  orders. Omitted on single-product / non-delivered transitions; the server
   *  then fans quantityDelivered onto the order's lone line. */
  itemQuantities?: { productCatalogId: string; quantityDelivered: number }[];
};

/** Args for the `flag_delivery_issue` RPC. Used when UpdateStatusSheet
 *  detects an intervention-class status and routes the agent's submit
 *  through the flag path so ops get a thread automatically. */
export type FlagDeliveryArgs = {
  deliveryId: string;
  issueType: IssueType;
  note: string | null;
  newStatus: string | null;
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

/** Args for `return_delivery_leftover` — hands a partial delivery's leftover
 *  (quantity_ordered − quantity_delivered) back to the warehouse. Enqueued
 *  right after the mark-delivered job; the queue drains FIFO so the delivery
 *  is already 'delivered' by the time this runs (and the RPC retries if not). */
export type ReturnDeliveryLeftoverArgs = {
  deliveryId: string;
  /** null => return the full leftover the server computes. */
  quantity: number | null;
  notes: string | null;
};

/** Args for `agent_change_delivery_location` — the assigned agent records the
 *  ACTUAL delivery zone (customer was delivered elsewhere). The server re-snaps
 *  the rate and either auto-applies (pay not raised) or holds for a manager
 *  (pay raised). Enqueued alongside the mark-delivered job; order-independent
 *  because the RPC accepts both pre-delivery and delivered rows. */
export type AgentChangeDeliveryLocationArgs = {
  deliveryId: string;
  toLocationId: string;
  reason: string;
};

export type JobArgs =
  | { kind: 'change_delivery_status'; args: ChangeDeliveryStatusArgs }
  | { kind: 'flag_delivery'; args: FlagDeliveryArgs }
  | { kind: 'create_stock_adjustment'; args: CreateStockAdjustmentArgs }
  | { kind: 'create_stock_transfer'; args: CreateStockTransferArgs }
  | { kind: 'return_delivery_leftover'; args: ReturnDeliveryLeftoverArgs }
  | { kind: 'agent_change_delivery_location'; args: AgentChangeDeliveryLocationArgs };

export type JobStatus = 'pending' | 'in_flight' | 'failed_retrying' | 'dead_letter';

/** A single queued mutation. `clientUuid` makes server-side retries safe;
 *  re-enqueuing the same job with the same uuid is a no-op on the server. */
export type Job = {
  id: string; // local UUID — distinct from clientUuid for dedup logs
  clientUuid: string; // sent to the RPC for idempotency
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
  /** The `users.id` of whoever signed in when this job was enqueued. The
   *  drain refuses to replay any job whose enqueuer doesn't match the
   *  current session — defense-in-depth on top of per-user storage keying,
   *  so a future bug crossing the storage boundary still can't fire an
   *  RPC under the wrong user. */
  enqueuedByUserId: string;
};

/** Backoff schedule. Cap at 8 retries → goes to dead_letter on 9th failure.
 *  Numbers chosen so a transient outage is invisible (<30s) but a real
 *  problem stops hammering the server within ~5 minutes. */
export const BACKOFF_MS = [
  1_000, // attempt 1 → wait 1s
  3_000, // attempt 2 → 3s
  8_000, // attempt 3 → 8s
  20_000, // attempt 4 → 20s
  60_000, // attempt 5 → 1m
  120_000, // attempt 6 → 2m
  300_000, // attempt 7 → 5m
  600_000, // attempt 8 → 10m
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
