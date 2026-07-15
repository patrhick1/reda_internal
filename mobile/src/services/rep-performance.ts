import { rpcUntyped } from '@/lib/supabase';

// Rep performance (Phase 1) — read-only admin reporting. Types are hand-written
// for now; will regenerate via `npm run gen:types` once the SQL is applied.
// Backs mobile/app/(admin)/rep-performance.tsx. RPCs: rep_activity_summary,
// rep_notify_coverage (see tools/live-defs/rep-performance.sql). Both are
// admin-gated server-side (is_admin → 42501) on top of the (admin) route group.

/** One leaderboard row — per active, non-test rep. */
export type RepActivityRow = {
  rep_id: string;
  display_name: string;
  /** Client notifications authored in range — the primary KPI. */
  notifies: number;
  /** Thread messages posted as a rep in range. */
  messages: number;
  /** Calls initiated in range. */
  calls: number;
  /** Max timestamp across the three signals; null when fully idle in range. */
  last_active_at: string | null;
};

/** Team-wide coverage / SLA snapshot (single row). */
export type RepCoverage = {
  /** Notifiable status transitions in range (To-notify pill set, per-transition). */
  notifiable_updates: number;
  /** Of those, how many got a client notification. */
  notified: number;
  pct_notified: number;
  not_notified: number;
  /** Median minutes from status change to notification; null when none notified. */
  median_minutes_to_notify: number | null;
  /** Un-notified notifiable transitions whose delivery is still non-terminal (all-time). */
  backlog_open: number;
  /** Age in minutes of the oldest open backlog item; null when backlog empty. */
  oldest_open_update_age_minutes: number | null;
  /** Most recent notification across ALL reps, all-time — the live indicator. */
  last_team_notify_at: string | null;
};

// The RPCs take timestamptz; the UI works in Lagos calendar days. Convert a
// [from, to] inclusive day range into the half-open [start-of-from, start-of-day
// -after-to) timestamptz window the SQL expects. Lagos is a fixed UTC+1 (no DST).
const LAGOS_OFFSET = '+01:00';

function nextYmd(ymd: string): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function lagosRange(from: string, to: string): { p_from: string; p_to: string } {
  return {
    p_from: `${from}T00:00:00${LAGOS_OFFSET}`,
    p_to: `${nextYmd(to)}T00:00:00${LAGOS_OFFSET}`,
  };
}

// These RPCs are not in database.gen.ts until the SQL is applied + types are
// regenerated (`npm run gen:types`); until then the generated rpc() overloads
// reject the names. rpcUntyped (@/lib/supabase) is the shared handle — it binds
// `this` correctly; see its docs for why that matters.

export async function listRepActivity(from: string, to: string): Promise<RepActivityRow[]> {
  const { data, error } = await rpcUntyped('rep_activity_summary', lagosRange(from, to));
  if (error) throw error;
  return (data ?? []) as RepActivityRow[];
}

export async function getRepCoverage(from: string, to: string): Promise<RepCoverage | null> {
  const { data, error } = await rpcUntyped('rep_notify_coverage', lagosRange(from, to));
  if (error) throw error;
  const rows = (data ?? []) as RepCoverage[];
  return rows[0] ?? null;
}
