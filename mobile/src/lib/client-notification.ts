export type ClosureKind = 'duplicate' | 'client_policy' | null;
const exempt = new Set([
  'pending',
  'delivered',
  'rolled_over',
  'agent_cancelled',
  'deferred_to_client',
  'unserious',
  'picked_up',
  'waybilled',
  'replacement_completed',
]);

export function awaitsClientNotification(row: {
  current_status?: string | null;
  latest_notified?: boolean | null;
  notification_required?: boolean | null;
  client_auto_cancel_soft_fails?: boolean | null;
}): boolean {
  if (row.latest_notified || !row.current_status) return false;
  if (typeof row.notification_required === 'boolean') return row.notification_required;
  // Conservative compatibility fallback: a mutable vendor setting does not
  // establish why this particular failure happened.
  return !exempt.has(row.current_status);
}

export function closureLabel(status: string, kind?: ClosureKind): string | undefined {
  if (status === 'cancelled' && kind === 'duplicate') return 'Closed — duplicate';
  if (status === 'failed_delivery' && kind === 'client_policy') return 'Closed — client policy';
  return undefined;
}

export function agentCanSelectStatus(status: string): boolean {
  return status !== 'cancelled' && status !== 'failed_delivery';
}
