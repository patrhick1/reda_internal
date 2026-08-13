import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';

export type ClientNotification = {
  statusHistoryId: string;
  deliveryId: string;
  notifiedByUserId: string;
  notifiedAt: string;
  holderName: string;
  isSelf: boolean;
};

/** Tags one status-history row as "client notified on WhatsApp" for the
 *  caller. First-tap wins server-side: if a peer already tagged this row,
 *  the returned record describes them (isSelf=false) so the UI can
 *  switch to the held-by-peer display without an extra refetch. */
export async function markClientNotified(statusHistoryId: string): Promise<ClientNotification> {
  const { data, error } = await supabase.rpc('mark_client_notified', {
    p_status_history_id: statusHistoryId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('mark_client_notified returned no row');
  return {
    statusHistoryId: row.status_history_id as string,
    deliveryId: row.delivery_id as string,
    notifiedByUserId: row.notified_by_user_id as string,
    notifiedAt: row.notified_at as string,
    holderName: row.holder_name as string,
    isSelf: row.is_self as boolean,
  };
}

/** Outcome of tagging a selection. `notified` = rows this caller claimed;
 *  `alreadyTagged` = a peer had already tagged them (first-tap-wins server-side,
 *  which is a no-op, not an error); `failed` = rows the server refused. */
export type BulkNotifyCounts = {
  notified: number;
  alreadyTagged: number;
  failed: number;
  firstError: string | null;
};

/** How many rows are in flight at once. `mark_client_notified` is a per-row
 *  RPC, so a "select all visible" of 100 would be 100 round trips; a small
 *  window keeps a big selection quick without flooding the box. */
const NOTIFY_CONCURRENCY = 5;

/** Tag SEVERAL status-history rows in one action — the list's select-mode
 *  counterpart to the single tap on a delivery's Detail screen.
 *
 *  There is no bulk RPC: `mark_client_notified` is already idempotent and
 *  first-tap-wins per row, so this loops it the same way bulk Transfer and
 *  Receive loop their per-line endpoints. Rows are independent — one refusal
 *  never voids the rest, and the counts say exactly what landed. */
export async function bulkMarkClientNotified(
  statusHistoryIds: string[],
): Promise<BulkNotifyCounts> {
  const counts: BulkNotifyCounts = {
    notified: 0,
    alreadyTagged: 0,
    failed: 0,
    firstError: null,
  };
  const queue = [...statusHistoryIds];

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        const row = await markClientNotified(id);
        if (row.isSelf) counts.notified += 1;
        else counts.alreadyTagged += 1;
      } catch (e) {
        counts.failed += 1;
        // errorMessage, not `e.message` — the RPC rejects with a PostgrestError,
        // a plain object, so instanceof/String would yield "[object Object]".
        if (!counts.firstError) counts.firstError = errorMessage(e);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(NOTIFY_CONCURRENCY, queue.length) }, () => worker()),
  );
  return counts;
}

export type ClientNotificationRow = {
  statusHistoryId: string;
  notifiedByUserId: string;
  notifiedAt: string;
  holderName: string;
};

/** All notification tags for one delivery, keyed by status_history_id.
 *  Returns a Map so HistoryRow rendering is an O(1) lookup. */
export async function listClientNotificationsForDelivery(
  deliveryId: string,
): Promise<Map<string, ClientNotificationRow>> {
  const { data, error } = await supabase
    .from('delivery_client_notifications')
    .select(
      'status_history_id, notified_by_user_id, notified_at, notifier:users!notified_by_user_id(display_name)',
    )
    .eq('delivery_id', deliveryId);
  if (error) throw error;
  const map = new Map<string, ClientNotificationRow>();
  for (const raw of data ?? []) {
    const row = raw as {
      status_history_id: string;
      notified_by_user_id: string;
      notified_at: string;
      notifier: { display_name: string } | null;
    };
    map.set(row.status_history_id, {
      statusHistoryId: row.status_history_id,
      notifiedByUserId: row.notified_by_user_id,
      notifiedAt: row.notified_at,
      holderName: row.notifier?.display_name ?? '—',
    });
  }
  return map;
}
