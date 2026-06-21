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
  scheduled_date: string;
  customer_name: string;
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
  scheduled_date: string;
  customer_name: string;
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

/** Roll every non-terminal delivery for the given date forward one day. */
export async function runEodRollover(forDate: string): Promise<number> {
  const { data, error } = await supabase.rpc('run_eod_rollover', { p_for_date: forDate });
  if (error) throw error;
  return (data ?? 0) as number;
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
