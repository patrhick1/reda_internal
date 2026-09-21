import { rpcUntyped } from '@/lib/supabase';

export type MaintenanceKind = 'release' | 'close';
export type MaintenancePreview = {
  preview_id: string;
  kind: MaintenanceKind;
  date: string;
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
    action: string;
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
  const { data, error } = await rpcUntyped('prepare_maintenance', { p_kind: kind, p_date: date });
  if (error) throw error;
  return data as MaintenancePreview;
}
export async function requestMaintenance(previewId: string): Promise<string> {
  const { data, error } = await rpcUntyped('request_maintenance', { p_preview_id: previewId });
  if (error) throw error;
  return data as string;
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
