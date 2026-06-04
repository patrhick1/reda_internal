import { supabase } from '@/lib/supabase';
import { TERMINAL_STATUSES } from '@/lib/theme';

export type IssueType =
  | 'wrong_address'
  | 'cant_reach_client'
  | 'payment_dispute'
  | 'product_issue'
  | 'other';

export type AuthorRole = 'agent' | 'admin' | 'dispatcher' | 'rep';

export type DeliveryMessage = {
  id: string;
  delivery_id: string;
  author_id: string;
  author_name: string | null;
  author_role: AuthorRole;
  issue_type: IssueType | null;
  note: string | null;
  created_at: string;
  read_at: string | null;
  /** Derived: true when author_role is in the ops set (admin/dispatcher/rep). */
  fromOps: boolean;
};

type RawMessageRow = {
  id: string;
  delivery_id: string;
  author_id: string;
  author_role: AuthorRole;
  issue_type: IssueType | null;
  note: string | null;
  created_at: string;
  read_at: string | null;
  users?: { display_name: string | null } | null;
};

function shape(row: RawMessageRow): DeliveryMessage {
  return {
    id: row.id,
    delivery_id: row.delivery_id,
    author_id: row.author_id,
    author_name: row.users?.display_name ?? null,
    author_role: row.author_role,
    issue_type: row.issue_type,
    note: row.note,
    created_at: row.created_at,
    read_at: row.read_at,
    fromOps:
      row.author_role === 'admin' || row.author_role === 'dispatcher' || row.author_role === 'rep',
  };
}

export async function listMessages(deliveryId: string): Promise<DeliveryMessage[]> {
  const { data, error } = await supabase
    .from('delivery_messages')
    .select(
      'id, delivery_id, author_id, author_role, issue_type, note, created_at, read_at, users!author_id(display_name)',
    )
    .eq('delivery_id', deliveryId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as RawMessageRow[]).map(shape);
}

export type FlagDeliveryInput = {
  deliveryId: string;
  issueType: IssueType;
  note: string | null;
  newStatus: string | null;
  clientUuid: string;
};

export async function flagDelivery(input: FlagDeliveryInput): Promise<DeliveryMessage> {
  // Supabase's type generator marks RPC args as non-null even when the SQL
  // function accepts NULL. p_note and p_new_status are intentionally nullable.
  const { data, error } = await supabase.rpc('flag_delivery_issue', {
    p_delivery_id: input.deliveryId,
    p_issue_type: input.issueType,
    p_note: input.note as string,
    p_new_status: input.newStatus as string,
    p_client_uuid: input.clientUuid,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as RawMessageRow | null;
  if (!row) throw new Error('flag_delivery_issue returned no row');
  return shape(row);
}

export type PostReplyInput = {
  deliveryId: string;
  text: string;
  clientUuid: string;
};

export async function postReply(input: PostReplyInput): Promise<DeliveryMessage> {
  const { data, error } = await supabase.rpc('reply_to_delivery', {
    p_delivery_id: input.deliveryId,
    p_text: input.text,
    p_client_uuid: input.clientUuid,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as RawMessageRow | null;
  if (!row) throw new Error('reply_to_delivery returned no row');
  return shape(row);
}

export async function markRead(deliveryId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_messages_read', {
    p_delivery_id: deliveryId,
  });
  if (error) throw error;
}

export type OpenIssueRow = {
  delivery_id: string;
  issue_type: IssueType | null;
  note: string | null;
  created_at: string;
  customer_name: string | null;
  current_status: string | null;
  agent_name: string | null;
};

/** Lists unread agent-authored messages whose parent delivery is still open.
 *  Powers the admin home "Open issues from agents" attention block. */
export async function listOpenIssuesForOps(): Promise<OpenIssueRow[]> {
  const { data, error } = await supabase
    .from('delivery_messages')
    .select(
      `
      delivery_id, issue_type, note, created_at,
      delivery:deliveries!inner(customer_name, current_status, assigned_agent_id,
        agent:users!deliveries_assigned_agent_id_fkey(display_name))
    `,
    )
    .eq('author_role', 'agent')
    .is('read_at', null)
    .in('issue_type', ACTIONABLE_ISSUE_TYPES)
    .order('created_at', { ascending: false });
  if (error) throw error;
  type Raw = {
    delivery_id: string;
    issue_type: IssueType | null;
    note: string | null;
    created_at: string;
    delivery: {
      customer_name: string | null;
      current_status: string | null;
      assigned_agent_id: string | null;
      agent: { display_name: string | null } | null;
    } | null;
  };
  return ((data ?? []) as Raw[])
    .filter((r: Raw) => r.delivery && !TERMINAL_STATUSES.has(r.delivery.current_status ?? ''))
    .map((r: Raw) => ({
      delivery_id: r.delivery_id,
      issue_type: r.issue_type,
      note: r.note,
      created_at: r.created_at,
      customer_name: r.delivery!.customer_name,
      current_status: r.delivery!.current_status,
      agent_name: r.delivery!.agent?.display_name ?? null,
    }));
}

export const ISSUE_LABELS: Record<IssueType, string> = {
  wrong_address: 'Wrong address',
  cant_reach_client: "Can't reach client",
  payment_dispute: 'Payment dispute',
  product_issue: 'Product issue',
  other: 'Other',
};

/** Default soft-status transition for each chip. `null` means "no change by default".
 *  Mirrors the table in the plan file (Context section). */
export const ISSUE_DEFAULT_STATUS: Record<IssueType, string | null> = {
  cant_reach_client: 'not_answering',
  wrong_address: 'follow_up',
  payment_dispute: 'follow_up',
  product_issue: 'follow_up',
  other: null,
};

/** Override options for chips where the default doesn't fit every case.
 *  Empty array = no override picker shown. */
export const ISSUE_STATUS_OVERRIDES: Record<IssueType, string[]> = {
  cant_reach_client: ['not_answering', 'number_busy', 'switched_off'],
  wrong_address: [],
  payment_dispute: [],
  product_issue: [],
  other: ['follow_up'],
};

/** Inverse of ISSUE_DEFAULT_STATUS / ISSUE_STATUS_OVERRIDES — when an agent
 *  picks one of these statuses via UpdateStatusSheet (not the caution flag),
 *  the sheet routes through `flag_delivery_issue` instead of
 *  `change_delivery_status` so a thread gets seeded automatically. The map
 *  intentionally only covers the customer-unreachable subset of soft_failure;
 *  customer-deferral statuses (tomorrow / postponed / will_call_back) and
 *  in-transit statuses (picked_up / waybilled) keep using the plain status
 *  RPC because they don't need ops escalation. */
export const STATUS_AUTO_ISSUE: Record<string, IssueType> = {
  not_answering: 'cant_reach_client',
  not_around: 'cant_reach_client',
  not_available: 'cant_reach_client',
  not_connecting: 'cant_reach_client',
  number_busy: 'cant_reach_client',
  switched_off: 'cant_reach_client',
};

/** Issue types that genuinely need an admin to take action — the home
 *  "Needs Attention" feed only shows these. Anything in STATUS_AUTO_ISSUE's
 *  range is excluded because the "soft-failed today" card already surfaces
 *  the underlying delivery; surfacing the auto-seeded message thread there
 *  too would just double-count the same row. Derived (not hardcoded) so that
 *  if STATUS_AUTO_ISSUE grows, the home filter narrows automatically. */
const AUTO_SEEDED_ISSUE_TYPES = new Set<IssueType>(
  Object.values(STATUS_AUTO_ISSUE) as IssueType[],
);
export const ACTIONABLE_ISSUE_TYPES: IssueType[] = (
  Object.keys(ISSUE_LABELS) as IssueType[]
).filter((t) => !AUTO_SEEDED_ISSUE_TYPES.has(t));
