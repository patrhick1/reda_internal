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

export type ClientRemitDetailRow = {
  delivery_id: string;
  scheduled_date: string;
  customer_name: string;
  product_name: string | null;
  location_name: string | null;
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

/** Roll every non-terminal delivery for the given date forward one day. */
export async function runEodRollover(forDate: string): Promise<number> {
  const { data, error } = await supabase.rpc('run_eod_rollover', { p_for_date: forDate });
  if (error) throw error;
  return (data ?? 0) as number;
}
