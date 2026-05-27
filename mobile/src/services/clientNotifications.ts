import { supabase } from '@/lib/supabase';

export type ClientNotification = {
  statusHistoryId:  string;
  deliveryId:       string;
  notifiedByUserId: string;
  notifiedAt:       string;
  holderName:       string;
  isSelf:           boolean;
};

/** Tags one status-history row as "client notified on WhatsApp" for the
 *  caller. First-tap wins server-side: if a peer already tagged this row,
 *  the returned record describes them (isSelf=false) so the UI can
 *  switch to the held-by-peer display without an extra refetch. */
export async function markClientNotified(
  statusHistoryId: string,
): Promise<ClientNotification> {
  const { data, error } = await supabase.rpc('mark_client_notified', {
    p_status_history_id: statusHistoryId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('mark_client_notified returned no row');
  return {
    statusHistoryId:  row.status_history_id   as string,
    deliveryId:       row.delivery_id         as string,
    notifiedByUserId: row.notified_by_user_id as string,
    notifiedAt:       row.notified_at         as string,
    holderName:       row.holder_name         as string,
    isSelf:           row.is_self             as boolean,
  };
}

export type ClientNotificationRow = {
  statusHistoryId:  string;
  notifiedByUserId: string;
  notifiedAt:       string;
  holderName:       string;
};

/** All notification tags for one delivery, keyed by status_history_id.
 *  Returns a Map so HistoryRow rendering is an O(1) lookup. */
export async function listClientNotificationsForDelivery(
  deliveryId: string,
): Promise<Map<string, ClientNotificationRow>> {
  const { data, error } = await supabase
    .from('delivery_client_notifications')
    .select('status_history_id, notified_by_user_id, notified_at, notifier:users!notified_by_user_id(display_name)')
    .eq('delivery_id', deliveryId);
  if (error) throw error;
  const map = new Map<string, ClientNotificationRow>();
  for (const raw of data ?? []) {
    const row = raw as {
      status_history_id:   string;
      notified_by_user_id: string;
      notified_at:         string;
      notifier:            { display_name: string } | null;
    };
    map.set(row.status_history_id, {
      statusHistoryId:  row.status_history_id,
      notifiedByUserId: row.notified_by_user_id,
      notifiedAt:       row.notified_at,
      holderName:       row.notifier?.display_name ?? '—',
    });
  }
  return map;
}
