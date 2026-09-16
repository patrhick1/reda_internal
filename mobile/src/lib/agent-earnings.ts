export type AgentEarningsRow = {
  agent_id: string;
  agent_name: string;
  deliveries_count: number;
  total_quantity: number;
  /** Flat per-delivery pay; null while any included earning needs review. */
  total_earnings: number | null;
  total_collected: number;
  total_remit: number | null;
  known_earnings: number;
  pending_pay_count: number;
};

type ReplacementEarning = {
  agent_id: string | null;
  agent_name: string | null;
  agent_payment: number;
  payment_received_by: string | null;
  customer_paid: number;
};

/** Replacements retain their own rates and never resolve pending ordinary pay. */
export function mergeReplacementEarnings(
  ordinary: AgentEarningsRow[],
  replacements: ReplacementEarning[],
): AgentEarningsRow[] {
  const byAgent = new Map(ordinary.map((row) => [row.agent_id, { ...row }]));
  for (const replacement of replacements) {
    if (!replacement.agent_id) continue;
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
        known_earnings: 0,
        pending_pay_count: 0,
      };
      byAgent.set(row.agent_id, row);
    }
    const pay = Number(replacement.agent_payment);
    const collected =
      replacement.payment_received_by === 'rider' ? Number(replacement.customer_paid ?? 0) : 0;
    row.deliveries_count += 1;
    row.known_earnings += pay;
    row.total_collected += collected;
    if (row.total_earnings != null) row.total_earnings += pay;
    if (row.total_remit != null) row.total_remit += collected - pay;
  }
  return [...byAgent.values()];
}
