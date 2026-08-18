import { rpcUntyped, supabase } from '@/lib/supabase';
import { ymdLagos } from '@/lib/date';

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

type ReplacementFinancialRow = {
  attempt_id: string;
  delivery_id: string;
  attempted_at: string;
  client_id: string;
  client_name: string;
  customer_name: string;
  outcome: string;
  client_charge: number;
  agent_payment: number;
  margin: number;
  agent_id: string | null;
  agent_name: string | null;
  notes: string | null;
};

type RepReplacementFinancialRow = {
  attempt_id: string;
  delivery_id: string;
  attempted_at: string;
  client_id: string;
  client_name: string;
  customer_name: string;
  outcome: string;
  remit: number;
  agent_name: string | null;
  notes: string | null;
};

type AgentReplacementFinancialRow = {
  attempt_id: string;
  delivery_id: string;
  attempted_at: string;
  agent_id: string;
  agent_name: string | null;
  agent_payment: number;
};

async function listReplacementFinancials(
  from: string,
  to: string,
  clientId?: string,
): Promise<ReplacementFinancialRow[]> {
  const { data, error } = await rpcUntyped<ReplacementFinancialRow[]>(
    'list_replacement_financials',
    { p_from: from, p_to: to, p_client_id: clientId ?? null },
  );
  if (error) throw error;
  return data ?? [];
}

async function listRepReplacementFinancials(
  from: string,
  to: string,
  clientId?: string,
): Promise<RepReplacementFinancialRow[]> {
  const { data, error } = await rpcUntyped<RepReplacementFinancialRow[]>(
    'list_replacement_financials_rep',
    { p_from: from, p_to: to, p_client_id: clientId ?? null },
  );
  if (error) throw error;
  return data ?? [];
}

async function listReplacementAgentFinancials(
  from: string,
  to: string,
): Promise<AgentReplacementFinancialRow[]> {
  const { data, error } = await rpcUntyped<AgentReplacementFinancialRow[]>(
    'list_replacement_agent_financials',
    { p_from: from, p_to: to },
  );
  if (error) throw error;
  return data ?? [];
}

export async function getReplacementAgentPayTotal(from: string, to: string): Promise<number> {
  const rows = await listReplacementAgentFinancials(from, to);
  return rows.reduce((sum, row) => sum + Number(row.agent_payment ?? 0), 0);
}

export async function listClientRemit(from: string, to: string): Promise<ClientRemitRow[]> {
  const [{ data, error }, replacementRows] = await Promise.all([
    supabase.rpc('client_remit_summary', { p_from: from, p_to: to }),
    listReplacementFinancials(from, to),
  ]);
  if (error) throw error;
  const rows = ((data ?? []) as ClientRemitRow[]).map((row) => ({ ...row }));
  const byClient = new Map(rows.map((row) => [row.client_id, row]));
  for (const replacement of replacementRows) {
    let row = byClient.get(replacement.client_id);
    if (!row) {
      row = {
        client_id: replacement.client_id,
        client_name: replacement.client_name,
        deliveries_count: 0,
        total_quantity: 0,
        total_customer_price: 0,
        total_paid: 0,
        outstanding: 0,
        total_reda_fee: 0,
        total_cash_pos_fee: 0,
        total_remit: 0,
      };
      rows.push(row);
      byClient.set(row.client_id, row);
    }
    row.deliveries_count += 1;
    row.total_reda_fee += Number(replacement.client_charge ?? 0);
    row.total_remit -= Number(replacement.client_charge ?? 0);
  }
  return [...byClient.values()];
}

export async function listAgentEarningsSummary(
  from: string,
  to: string,
): Promise<AgentEarningsRow[]> {
  const [{ data, error }, replacementRows] = await Promise.all([
    supabase.rpc('agent_earnings_summary', { p_from: from, p_to: to }),
    listReplacementAgentFinancials(from, to),
  ]);
  if (error) throw error;
  const rows = ((data ?? []) as AgentEarningsRow[]).map((row) => ({ ...row }));
  const byAgent = new Map(rows.map((row) => [row.agent_id, row]));
  for (const replacement of replacementRows) {
    if (!replacement.agent_id || Number(replacement.agent_payment ?? 0) === 0) continue;
    let row = byAgent.get(replacement.agent_id);
    if (!row) {
      row = {
        agent_id: replacement.agent_id,
        agent_name: replacement.agent_name ?? 'Agent',
        deliveries_count: 0,
        total_quantity: 0,
        total_earnings: 0,
        total_collected: 0,
        total_remit: 0,
      };
      rows.push(row);
      byAgent.set(row.agent_id, row);
    }
    row.deliveries_count += 1;
    row.total_earnings += Number(replacement.agent_payment);
    row.total_remit -= Number(replacement.agent_payment);
  }
  return [...byAgent.values()];
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
  const [{ data, error }, replacements] = await Promise.all([
    supabase.rpc('client_remit_detail', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
    }),
    listReplacementFinancials(from, to, clientId),
  ]);
  if (error) throw error;
  const deliveryRows = (data ?? []) as ClientRemitDetailRow[];
  const replacementRows: ClientRemitDetailRow[] = replacements.map((row) => ({
    delivery_id: `${row.delivery_id}:${row.attempt_id}`,
    order_type: 'replacement',
    scheduled_date: ymdLagos(row.attempted_at) ?? row.attempted_at.slice(0, 10),
    customer_name: row.customer_name,
    customer_phone: null,
    client_rep: null,
    product_name: 'Replacement service',
    location_name: null,
    products: [],
    quantity_ordered: 0,
    quantity_delivered: 0,
    customer_price: 0,
    paid: 0,
    payment_method: null,
    reda_fee: Number(row.client_charge ?? 0),
    cash_pos_fee: 0,
    remit: -Number(row.client_charge ?? 0),
    agent_name: row.agent_name,
    note:
      row.notes ?? (row.outcome === 'completed' ? 'Replacement completed' : 'Replacement attempt'),
  }));
  return [...deliveryRows, ...replacementRows].sort((a, b) =>
    a.scheduled_date < b.scheduled_date ? 1 : a.scheduled_date > b.scheduled_date ? -1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Rep-facing reconcile. Reps give clients delivered-updates but must not see
// the Reda fee. These call the rep-safe RPCs (client_remit_summary_rep /
// client_remit_detail_rep) which return client-facing figures. The actual paid
// amount is included because the rep must tell the client what the customer
// paid; Reda's explicit fee remains server-gated to paidAndFee clients.
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
  /** What the customer actually paid. Used in the client-facing Note whenever
   *  it differs from the original order total. */
  paid?: number | null;
  /** [paidAndFee clients only — Karami] Reda's delivery fee (reda_fee).
   *  NULL for all non-paidAndFee clients. */
  reda_fee?: number | null;
};

export async function listRepClientRemit(from: string, to: string): Promise<RepClientRemitRow[]> {
  const [{ data, error }, replacements] = await Promise.all([
    supabase.rpc('client_remit_summary_rep', { p_from: from, p_to: to }),
    listRepReplacementFinancials(from, to),
  ]);
  if (error) throw error;
  const rows = ((data ?? []) as RepClientRemitRow[]).map((row) => ({ ...row }));
  const byClient = new Map(rows.map((row) => [row.client_id, row]));
  for (const replacement of replacements) {
    let row = byClient.get(replacement.client_id);
    if (!row) {
      row = {
        client_id: replacement.client_id,
        client_name: replacement.client_name,
        deliveries_count: 0,
        total_quantity: 0,
        total_remit: 0,
      };
      rows.push(row);
      byClient.set(row.client_id, row);
    }
    row.deliveries_count += 1;
    row.total_remit += Number(replacement.remit ?? 0);
  }
  return [...byClient.values()];
}

export async function listRepClientRemitDetail(
  clientId: string,
  from: string,
  to: string,
): Promise<RepClientRemitDetailRow[]> {
  const [{ data, error }, replacements] = await Promise.all([
    supabase.rpc('client_remit_detail_rep', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
    }),
    listRepReplacementFinancials(from, to, clientId),
  ]);
  if (error) throw error;
  const deliveryRows = (data ?? []) as RepClientRemitDetailRow[];
  const replacementRows: RepClientRemitDetailRow[] = replacements.map((row) => ({
    delivery_id: `${row.delivery_id}:${row.attempt_id}`,
    order_type: 'replacement',
    scheduled_date: ymdLagos(row.attempted_at) ?? row.attempted_at.slice(0, 10),
    customer_name: row.customer_name,
    customer_phone: null,
    client_rep: null,
    product_name: 'Replacement service',
    location_name: null,
    quantity_ordered: 0,
    quantity_delivered: 0,
    products: [],
    outstanding: 0,
    remit: Number(row.remit ?? 0),
    agent_name: row.agent_name,
    payment_method: null,
    cash_pos_fee: 0,
    note:
      row.notes ?? (row.outcome === 'completed' ? 'Replacement completed' : 'Replacement attempt'),
    paid: 0,
  }));
  return [...deliveryRows, ...replacementRows].sort((a, b) =>
    a.scheduled_date < b.scheduled_date ? 1 : a.scheduled_date > b.scheduled_date ? -1 : 0,
  );
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
  const { data, error } = await rpcUntyped<EodPreviewRow[]>(
    'preview_eod_rollover',
    forDate ? { p_for_date: forDate } : {},
  );
  if (error) throw error;
  return data ?? [];
}

export type TodayDeliveryRate = {
  /** Orders delivered today. */
  delivered: number;
  /** Orders that EVER reached `available` / `available_evening` in their status
   *  history, OR are delivered — the "Available" hero chip and the rate
   *  denominator. delivered ⊆ available, so rate = delivered / available ≤ 100%. */
  available: number;
};

/** Admin home "Available" + "Rate" hero. Both are measured against orders the
 *  customer was actually engaged on — every delivery that EVER reached Available in
 *  its status history — NOT the raw order count, and NOT the soft-fail queue
 *  (customers the vendor never convinced, who never made it to Available). This is
 *  the ~70%+ figure clients see in their weekly/monthly reports, not the old ~30%
 *  that counted unreachable leads against us. Server-side RPC (reads status
 *  history); see scripts/today-delivery-rate.sql. Defaults to Lagos-today. Client
 *  computes the percentage so it owns rounding and the empty state. */
export async function getTodayDeliveryRate(forDate?: string): Promise<TodayDeliveryRate> {
  const { data, error } = await rpcUntyped<TodayDeliveryRate[]>(
    'today_delivery_rate',
    forDate ? { p_for_date: forDate } : {},
  );
  if (error) throw error;
  const row = data?.[0];
  return { delivered: row?.delivered ?? 0, available: row?.available ?? 0 };
}

export type RateHistoryDay = {
  /** ISO date (YYYY-MM-DD), Africa/Lagos. */
  day: string;
  delivered: number;
  /** Denominator: ever reached Available (or delivered). See getTodayDeliveryRate. */
  available: number;
};

/** Per-day delivery-rate series for the home 7-day strip and the history screen's
 *  30-day average. Same metric as getTodayDeliveryRate, one row per day. Reads
 *  immutable status history, so past days are stable. Only days that had orders are
 *  returned (no-order days are absent). `from`/`to` are inclusive ISO dates;
 *  defaults server-side to the last 30 days. See scripts/delivery-rate-history.sql. */
export async function getDeliveryRateHistory(
  from?: string,
  to?: string,
): Promise<RateHistoryDay[]> {
  const args: Record<string, string> = {};
  if (from) args.p_from = from;
  if (to) args.p_to = to;
  const { data, error } = await rpcUntyped<RateHistoryDay[]>('delivery_rate_history', args);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    day: r.day,
    delivered: r.delivered ?? 0,
    available: r.available ?? 0,
  }));
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

export type BulkSettleAgentsResult = {
  batch_id: string;
  settled_count: number;
  expected_amount: number;
  settlements: {
    agent_id: string;
    settlement_id: string;
    expected_amount: number;
  }[];
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

/**
 * Freeze several agent-day handovers in one atomic, idempotent database action.
 * The caller must keep the same requestId when retrying an ambiguous response.
 */
export async function bulkSettleAgents(
  agentIds: string[],
  periodDate: string,
  note: string | null,
  requestId: string,
): Promise<BulkSettleAgentsResult> {
  const { data, error } = await rpcUntyped<BulkSettleAgentsResult>('bulk_settle_agents', {
    p_request_id: requestId,
    p_agent_ids: agentIds,
    p_period_date: periodDate,
    p_note: note,
  });
  if (error) throw error;
  if (!data) throw new Error('Bulk handover returned no result');
  return data;
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
