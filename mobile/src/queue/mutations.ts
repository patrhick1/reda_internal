// Hook adapters that turn the existing mutation services into queue-backed
// fire-and-forget calls. Each `useEnqueueX` returns an `async (args) => void`
// with the same signature shape callers already expect, so screens don't have
// to learn the queue API.
//
// Resolving immediately after enqueue is intentional: the user gets instant
// feedback, and the queue handles retries + dead-lettering in the background.
// The next time the screen reloads (focus / pull-to-refresh), the server
// state catches up.

import { useCallback } from 'react';
import { useQueue } from './QueueProvider';
import type {
  AgentChangeDeliveryLocationArgs,
  ChangeDeliveryStatusArgs,
  CreateStockAdjustmentArgs,
  CreateStockTransferArgs,
  FlagDeliveryArgs,
  ReturnDeliveryLeftoverArgs,
} from './types';

// Each hook returns the queue job ID so callers (e.g. the delivery detail
// screen) can watch the job's lifecycle and clear optimistic UI when the
// job ends — succeeded (removed from queue) or dead-lettered (failed past
// the retry cap).

export function useEnqueueChangeStatus() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: ChangeDeliveryStatusArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'change_delivery_status', args, label });
    },
    [enqueue],
  );
}

export function useEnqueueFlagDelivery() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: FlagDeliveryArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'flag_delivery', args, label });
    },
    [enqueue],
  );
}

export function useEnqueueStockAdjustment() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: CreateStockAdjustmentArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'create_stock_adjustment', args, label });
    },
    [enqueue],
  );
}

export function useEnqueueStockTransfer() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: CreateStockTransferArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'create_stock_transfer', args, label });
    },
    [enqueue],
  );
}

export function useEnqueueReturnLeftover() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: ReturnDeliveryLeftoverArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'return_delivery_leftover', args, label });
    },
    [enqueue],
  );
}

export function useEnqueueAgentChangeLocation() {
  const { enqueue } = useQueue();
  return useCallback(
    async (args: AgentChangeDeliveryLocationArgs, label: string): Promise<string> => {
      return await enqueue({ kind: 'agent_change_delivery_location', args, label });
    },
    [enqueue],
  );
}
