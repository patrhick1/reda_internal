import { supabase } from '@/lib/supabase';

// Phase 6.3 reconciliation RPCs. Types intentionally hand-written for now; will
// regenerate via `npm run gen:types` once the SQL is applied. The @ts-expect-
// error suppressions disappear at that point.

export type ClientRemitRow = {
  client_id: string;
  client_name: string;
  deliveries_count: number;
  total_quantity: number;
  /** What customers were supposed to pay (sum of customer_price). */
  total_customer_price: number;
  /** What customers actually paid (sum of paid). */
  total_paid: number;
  /** Customer short-pay = customer_price − paid. Always positive when customers underpay. */
  outstanding: number;
  /** Reda's per-delivery delivery fees (sum of charged_snapshot). */
  total_reda_fee: number;
  /** POS fees Reda pays to bank customer cash (sum of cash_pos_fee_snapshot).
   *  Passed through to the client — they absorb the cost because their
   *  customer paid cash. NULL on pre-2026-05-29 rows. */
  total_cash_pos_fee: number;
  /** What Reda owes the client = paid − Reda fee − cash POS fee. */
  total_remit: number;
};

export type AgentEarningsRow = {
  agent_id: string;
  agent_name: string;
  deliveries_count: number;
  total_quantity: number;
  /** What Reda pays the rider (sum of agent_payment_snapshot × quantity_delivered).
   *  Payroll, money Reda → rider. Still used by the Summary tab's margin math. */
  total_earnings: number;
  /** Gross cash + transfer the rider collected from customers (sum of paid). */
  total_collected: number;
  /** NET the rider owes Reda = total_collected − total_earnings (rider keeps
   *  their own delivery pay and remits the rest). Drives the "By agent" view. */
  total_remit: number;
};

/** One product line within a delivery, from the reconcile RPC's `products`
 *  jsonb. Multi-product deliveries return N of these; the legacy single product
 *  is wrapped into a 1-element array for pre-Feature-A rows. */
export type RemitProduct = {
  product_name: string | null;
  quantity_ordered: number | null;
  quantity_delivered: number | null;
};

export type ClientRemitDetailRow = {
  delivery_id: string;
  order_type: string | null;
  scheduled_date: string;
  customer_name: string;
  customer_phone: string | null;
  client_rep: string | null;
  product_name: string | null;
  location_name: string | null;
  /** [Feature A] True per-product breakdown (multi-product safe). The legacy
   *  product_name / quantity_delivered above collapse a multi-product order to
   *  one name + the summed qty, so the display + share message read this. */
  products: RemitProduct[] | null;
  /** Units originally ordered. Used to derive a "delivered fewer than ordered" note. */
  quantity_ordered: number;
  quantity_delivered: number;
  /** What the customer was supposed to pay for this delivery. */
  customer_price: number;
  /** What the customer actually paid. */
  paid: number | null;
  payment_method: string | null;
  /** Reda's delivery fee for this trip (= charged_snapshot, from rate_card at create time). */
  reda_fee: number;
  /** ₦500 when the customer paid cash; 0 for transfer. Snapshotted at
   *  delivered-time so historical rows stay immutable. */
  cash_pos_fee: number;
  /** What Reda owes the client for this delivery = paid − reda_fee − cash_pos_fee. */
  remit: number;
  agent_name: string | null;
  /** Pickup/waybill charge breakdown (the create_waybill note: type fee + each
   *  pickup extra). Null for normal deliveries — the share report uses it only
   *  for waybill rows. */
  note: string | null;
};

export async function listClientRemit(from: string, to: string): Promise<ClientRemitRow[]> {
  const { data, error } = await supabase.rpc('client_remit_summary', { p_from: from, p_to: to });
  if (error) throw error;
  return (data ?? []) as ClientRemitRow[];
}

export async function listAgentEarningsSummary(
  from: string,
  to: string,
): Promise<AgentEarningsRow[]> {
  const { data, error } = await supabase.rpc('agent_earnings_summary', { p_from: from, p_to: to });
  if (error) throw error;
  return (data ?? []) as AgentEarningsRow[];
}

/** Total operational cost of delivered pickup/waybill records for the period.
 * These rows have no assigned agent, so agent_earnings_summary correctly omits
 * them from rider payroll. Reconciliation's Reda-margin summary subtracts this
 * amount separately so Uber/driver/storekeeper costs are not lost. */
export async function getWaybillPaidOutTotal(from: string, to: string): Promise<number> {
  const { data, error } = await supabase
    .from('deliveries_admin')
    .select('agent_payment_snapshot')
    .eq('order_type', 'waybill')
    .eq('current_status', 'delivered')
    .gte('scheduled_date', from)
    .lte('scheduled_date', to);
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.agent_payment_snapshot ?? 0), 0);
}

export async function listClientRemitDetail(
  clientId: string,
  from: string,
  to: string,
): Promise<ClientRemitDetailRow[]> {
  const { data, error } = await supabase.rpc('client_remit_detail', {
    p_client_id: clientId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return (data ?? []) as ClientRemitDetailRow[];
}

// ---------------------------------------------------------------------------
// Rep-facing reconcile. Reps give clients delivered-updates but must not see
// the Reda fee. These call the rep-safe RPCs (client_remit_summary_rep /
// client_remit_detail_rep) which return ONLY client-facing figures — the fee,
// cash POS fee, customer paid and customer price never leave the server, so
// the Reda cut can't be seen or back-calculated on the device. `outstanding`
// (customer balance) is client-facing and feeds the share Note.
// ---------------------------------------------------------------------------

export type RepClientRemitRow = {
  client_id: string;
  client_name: string;
  deliveries_count: number;
  total_quantity: number;
  /** What Reda owes the client (sum of net remit). */
  total_remit: number;
};

export type RepClientRemitDetailRow = {
  delivery_id: string;
  order_type: string | null;
  scheduled_date: string;
  customer_name: string;
  customer_phone: string | null;
  client_rep: string | null;
  product_name: string | null;
  location_name: string | null;
  quantity_ordered: number;
  quantity_delivered: number;
  /** [Feature A] True per-product breakdown (multi-product safe) — see
   *  ClientRemitDetailRow.products. */
  products: RemitProduct[] | null;
  /** Customer balance = customer_price − paid (customer ↔ vendor; informational). */
  outstanding: number;
  /** What Reda remits the client for this delivery (net of Reda fee). */
  remit: number;
  agent_name: string | null;
  /** How the customer paid ('cash' | 'transfer' | 'vendor_direct'). Client-facing
   *  (the client is told this in the share message); exposed by the rep RPC
   *  passthrough alongside cash_pos_fee. */
  payment_method: string | null;
  /** ₦500 cash-banking fee passed through to the client (0 for transfer).
   *  Client-facing — not Reda's own cut. */
  cash_pos_fee: number;
  /** Pickup/waybill charge breakdown (the create_waybill note). Null for normal
   *  deliveries — the share report uses it only for waybill rows. Client-facing. */
  note: string | null;
  /** [paidAndFee clients only — Karami] What the customer paid. The rep RPC
   *  releases this ONLY for clients on the paidAndFee format; NULL (stripped) for
   *  every other client, so the rep-fee-privacy boundary holds elsewhere. */
  paid?: number | null;
  /** [paidAndFee clients only — Karami] Reda's delivery fee (reda_fee). Same
   *  server-side gate as `paid` — NULL for all non-paidAndFee clients. */
  reda_fee?: number | null;
};

export async function listRepClientRemit(from: string, to: string): Promise<RepClientRemitRow[]> {
  const { data, error } = await supabase.rpc('client_remit_summary_rep', {
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return (data ?? []) as RepClientRemitRow[];
}

export async function listRepClientRemitDetail(
  clientId: string,
  from: string,
  to: string,
): Promise<RepClientRemitDetailRow[]> {
  const { data, error } = await supabase.rpc('client_remit_detail_rep', {
    p_client_id: clientId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  return (data ?? []) as RepClientRemitDetailRow[];
}

/** The full end-of-day operation (same as the nightly cron): releases postponed
 *  orders coming due into the unassigned pool, then rolls every stuck date's
 *  non-terminal deliveries forward one day. Resilient — a single bad date is
 *  skipped, not fatal — and catch-up safe, so running it by hand recovers a
 *  failed/missed nightly run (including the postponed release). Returns the
 *  number of deliveries rolled forward. */
export async function runEodRolloverAllStuck(): Promise<number> {
  const { data, error } = await supabase.rpc('run_eod_rollover_all_stuck', {});
  if (error) throw error;
  return (data ?? 0) as number;
}

/** One still-open delivery plus the verdict end-of-day will apply to it. Comes
 *  from `preview_eod_rollover`, which reads the SAME `_eod_classify` the nightly
 *  rollover executes — so the screen shows exactly what will happen (a `roll`
 *  carries forward; every other action closes the row out), and can never drift
 *  from the job the way the old "everything non-terminal = roll" list did. */
export type EodPreviewRow = {
  delivery_id: string;
  customer_name: string | null;
  product_name: string | null;
  quantity_ordered: number | null;
  customer_price: number | null;
  current_status: string | null;
  assigned_agent_name: string | null;
  /** What the rollover will do: 'roll' | 'close_followup' | 'close_disinterest'
   *  | 'close_policy' | 'cap_unserious' | 'dedup_same_agent' | 'dedup_cross_agent'
   *  | 'sibling_resolved'. Only 'roll' carries forward; the rest close out. */
  action: string;
  /** The status the row ends in ('rolled_over' | 'deferred_to_client' |
   *  'unserious' | 'failed_delivery' | 'cancelled'). */
  to_status: string;
};

/** Preview what end-of-day will do to each still-open delivery for a date
 *  (defaults to today, Lagos). Admin/dispatcher only — returns [] for others. */
export async function previewEodRollover(forDate?: string): Promise<EodPreviewRow[]> {
  // preview_eod_rollover isn't in database.gen.ts until `npm run gen:types` runs
  // at cutover (same as the reconcile RPCs above), so reach it through an untyped
  // rpc handle and assert the row shape ourselves.
  // .bind(supabase) is REQUIRED — SupabaseClient.rpc is a prototype method whose
  // body is `return this.rest.rpc(...)`. Extracted unbound into a variable,
  // `this` is undefined and the call throws `TypeError: ... (reading 'rest')`
  // before any request goes out, so this screen's preview always failed. Fixed
  // 2026-07-15; verified against @supabase/supabase-js 2.105.4.
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc('preview_eod_rollover', forDate ? { p_for_date: forDate } : {});
  if (error) throw error;
  return (data ?? []) as EodPreviewRow[];
}

// ---------------------------------------------------------------------------
// Settlement / period-lock (§14-2). Freezes one subject-day's figures so a
// later edit can't silently rewrite a period that was already paid out.
//   * client settlement = Uzo's manual bank transfer of `total_remit`.
//   * agent settlement  = rider handed over `total_remit` (paid − their pay).
// The RPCs snapshot the numbers; the reconcile page compares the snapshot
// `expected_amount` to its own live total to flag drift.
// ---------------------------------------------------------------------------

export type SubjectType = 'client' | 'agent';

export type SettlementRow = {
  settlement_id: string;
  subject_type: SubjectType;
  subject_id: string;
  /** The total frozen at settle time. Drift = live total − expected_amount. */
  expected_amount: number;
  deliveries_count: number;
  settled_at: string;
  settled_by_name: string | null;
  note: string | null;
};

/** Freeze one (subject, day). Admin only. Returns the settlement id. */
export async function settlePeriod(
  subjectType: SubjectType,
  subjectId: string,
  periodDate: string,
  note: string | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('settle_period', {
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_period_date: periodDate,
    p_note: note as unknown as string,
  });
  if (error) throw error;
  return data as string;
}

/** Soft-undo a settlement (admin only, reason required). */
export async function voidSettlement(settlementId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('void_settlement', {
    p_settlement_id: settlementId,
    p_reason: reason,
  });
  if (error) throw error;
}

/** Active settlements for a single day, keyed `${subject_type}:${subject_id}`. */
export async function listSettlementsForDate(
  periodDate: string,
): Promise<Map<string, SettlementRow>> {
  const { data, error } = await supabase.rpc('list_settlements_for_date', {
    p_period_date: periodDate,
  });
  if (error) throw error;
  const map = new Map<string, SettlementRow>();
  for (const row of (data ?? []) as SettlementRow[]) {
    map.set(`${row.subject_type}:${row.subject_id}`, row);
  }
  return map;
}
