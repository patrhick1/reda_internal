import { supabase } from '@/lib/supabase';

export type EditLockEntity = 'delivery' | 'bot_inbound';

export type AcquireLockResult = {
  heldBy: string;
  holderName: string;
  acquiredAt: string;
  isSelf: boolean;
};

/** Acquires (or refreshes) a lock for the caller on the given entity.
 *  If another user holds a fresh lock and `takeover=false`, the returned
 *  row describes the current holder and `isSelf=false`. Pass `takeover=true`
 *  to forcibly claim it (server writes an audit row). */
export async function acquireEditLock(
  entityType: EditLockEntity,
  entityId: string,
  takeover = false,
): Promise<AcquireLockResult> {
  const { data, error } = await supabase.rpc('acquire_edit_lock', {
    p_entity_type: entityType,
    p_entity_id:   entityId,
    p_takeover:    takeover,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('acquire_edit_lock returned no row');
  return {
    heldBy:      row.held_by as string,
    holderName:  row.holder_name as string,
    acquiredAt:  row.acquired_at as string,
    isSelf:      row.is_self as boolean,
  };
}

/** Releases the lock if this caller holds it. Safe no-op otherwise. */
export async function releaseEditLock(
  entityType: EditLockEntity,
  entityId: string,
): Promise<void> {
  const { error } = await supabase.rpc('release_edit_lock', {
    p_entity_type: entityType,
    p_entity_id:   entityId,
  });
  if (error) throw error;
}

/** Bumps `acquired_at` so the lock doesn't expire. Call every ~60s while the
 *  screen is mounted. Safe no-op if someone else holds the lock now. */
export async function heartbeatEditLock(
  entityType: EditLockEntity,
  entityId: string,
): Promise<void> {
  const { error } = await supabase.rpc('heartbeat_edit_lock', {
    p_entity_type: entityType,
    p_entity_id:   entityId,
  });
  if (error) throw error;
}
