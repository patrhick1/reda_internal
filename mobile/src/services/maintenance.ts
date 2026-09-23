import { rpcUntyped } from '@/lib/supabase';

export type MaintenanceKind = 'finish_day' | 'release' | 'close';
export type MaintenancePreview = {
  preview_id: string;
  kind: MaintenanceKind;
  date: string;
  target_date?: string;
  summary?: Record<string, number>;
  expires_at: string;
  total_orders: number;
  oversized_groups: number;
  rows: {
    id: string;
    customer_name: string;
    status: string;
    date: string;
    agent: string | null;
    carry: number;
    product_name?: string | null;
    quantity?: number | null;
    customer_price?: number | null;
    action: string;
    target_date?: string | null;
  }[];
};
export type MaintenanceHealth = {
  enabled: boolean;
  today: string;
  close_through: string;
  release_through: string;
  dispatch_at: string | null;
  worker_at: string | null;
  monitor_at: string | null;
  runs: {
    id: string;
    kind: MaintenanceKind;
    business_date: string;
    target_date?: string | null;
    status: string;
    remaining_groups: number;
    failed_groups: number;
    changed_groups: number;
    outcomes: Record<string, number>;
  }[];
  alerts: { key: string; message: string }[];
  failures: {
    id: number;
    status: string;
    attempts: number;
    error_message: string | null;
    delivery_ids: string[];
  }[];
  holds: { id: string; customer_name: string; date: string; reason: string }[];
  notification_failures: number;
};
export async function maintenanceHealth(): Promise<MaintenanceHealth> {
  const { data, error } = await rpcUntyped('maintenance_health', {});
  if (error) throw error;
  return data as MaintenanceHealth;
}
export async function prepareMaintenance(
  kind: MaintenanceKind,
  date: string,
): Promise<MaintenancePreview> {
  const { data, error } = await rpcUntyped(
    kind === 'finish_day' ? 'prepare_manual_eod' : 'prepare_maintenance',
    kind === 'finish_day' ? { p_for_date: date } : { p_kind: kind, p_date: date },
  );
  if (error) throw error;
  return data as MaintenancePreview;
}
export async function requestMaintenance(
  previewId: string,
  kind: MaintenanceKind,
): Promise<string> {
  const { data, error } = await rpcUntyped(
    kind === 'finish_day' ? 'request_manual_eod' : 'request_maintenance',
    { p_preview_id: previewId },
  );
  if (error) throw error;
  return data as string;
}
export async function manualPreviewPage(
  previewId: string,
  offset: number,
): Promise<MaintenancePreview['rows']> {
  const { data, error } = await rpcUntyped('manual_eod_preview_page', {
    p_preview_id: previewId,
    p_offset: offset,
    p_limit: 100,
  });
  if (error) throw error;
  return data as MaintenancePreview['rows'];
}
export type ManualEodResult = {
  complete: boolean;
  needs_attention: boolean;
  target_date: string;
  outcomes: Record<string, number>;
  problems: { id: string; customer_name: string; message: string }[];
};

export async function manualEodStatus(previewId: string): Promise<ManualEodResult> {
  const { data, error } = await rpcUntyped('manual_eod_status', { p_preview_id: previewId });
  if (error) throw error;
  return data as ManualEodResult;
}

export async function retryMaintenanceGroup(id: number): Promise<void> {
  const { error } = await rpcUntyped('retry_maintenance_group', { p_work_id: id });
  if (error) throw error;
}
export async function resolveMaintenanceHold(id: string, reason: string): Promise<void> {
  const { error } = await rpcUntyped('resolve_maintenance_hold', {
    p_delivery_id: id,
    p_resolution: reason,
  });
  if (error) throw error;
}
