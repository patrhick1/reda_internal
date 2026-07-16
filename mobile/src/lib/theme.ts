// Reda design tokens — translated from the brand kit. Keep this file as the
// single source of truth; never inline hex colors or font names in screens.

import { formatYmdShort } from './format';

export const colors = {
  red: '#E63027',
  redDim: '#C42821',
  redSoft: '#FEE2E0',
  black: '#0A0A0A',
  white: '#FFFFFF',
  surface: '#F5F5F5',
  surfaceAlt: '#FAFAFA',
  border: '#E5E5E5',
  borderStrong: '#D4D4D4',
  textPrimary: '#0A0A0A',
  textSecondary: '#7A7A7A',
  textTertiary: '#A3A3A3',
  success: '#16A34A',
  successSoft: '#DCFCE7',
  successDark: '#166534',
  warning: '#F59E0B',
  warningSoft: '#FEF3C7',
  warningDark: '#92400E',
  warningDarker: '#78350F',
  closed: '#7A7A7A',
  closedSoft: '#F0F0F0',
  info: '#2563EB',
  infoSoft: '#EFF6FF',
  infoBorder: '#BFDBFE',
  infoDark: '#1E40AF',
} as const;

export const radii = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 14,
  card: 14,
  sheet: 20,
  pill: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
} as const;

export const fonts = {
  regular: 'Montserrat_400Regular',
  medium: 'Montserrat_500Medium',
  semibold: 'Montserrat_600SemiBold',
  bold: 'Montserrat_700Bold',
  extrabold: 'Montserrat_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export type Tone = 'red' | 'blue' | 'amber' | 'green' | 'gray';

// Status taxonomy — mirrors `delivery_status_defs` rows in the DB and the
// pill-color choice from the design kit.
export const STATUS_META: Record<
  string,
  { label: string; tone: Tone; desc: string; warning?: string }
> = {
  pending: { label: 'Pending', tone: 'red', desc: 'Awaiting agent' },
  available: { label: 'Available', tone: 'blue', desc: 'Customer reachable' },
  available_evening: {
    label: 'Available (evening)',
    tone: 'blue',
    desc: 'Customer reachable in the evening',
  },
  not_answering: { label: 'Not picking', tone: 'amber', desc: 'Not picking calls' },
  number_busy: { label: 'Number busy', tone: 'amber', desc: 'Line busy' },
  switched_off: { label: 'Switched off', tone: 'amber', desc: 'Phone off' },
  not_connecting: { label: 'Number not reachable', tone: 'amber', desc: 'Number not reachable' },
  not_around: {
    label: 'Not around',
    tone: 'gray',
    desc: "Customer doesn't want it — closes the order",
    warning:
      'Closes the whole order — every agent racing this customer is cancelled. Use only when the customer does not want the product. If they want it later, use Postponed instead.',
  },
  will_call_back: { label: 'Will call back', tone: 'amber', desc: 'Customer asked to call later' },
  not_available: { label: 'Not available', tone: 'amber', desc: "Customer can't take it now" },
  tomorrow: { label: 'Tomorrow', tone: 'amber', desc: 'Customer rescheduled' },
  postponed: { label: 'Postponed', tone: 'amber', desc: 'Pushed later' },
  follow_up: { label: 'Follow up', tone: 'amber', desc: 'Needs follow-up' },
  picked_up: { label: 'Picked up', tone: 'blue', desc: 'Customer collected order' },
  waybilled: { label: 'Waybilled', tone: 'blue', desc: 'Shipped via waybill' },
  delivered: { label: 'Delivered', tone: 'green', desc: 'Done' },
  cancelled: { label: 'Customer Cancelled', tone: 'gray', desc: 'Customer cancelled the order' },
  agent_cancelled: {
    label: 'Not my delivery',
    tone: 'gray',
    desc: 'Pass on this row — order stays open for other agents',
    warning:
      "Closes only your row. The order stays open for other agents in the race. You'll need a reason if you reopen it.",
  },
  failed_delivery: { label: 'Failed', tone: 'gray', desc: 'Could not deliver' },
  unserious: { label: 'Unserious', tone: 'gray', desc: 'Customer not serious' },
  no_product: { label: 'No product', tone: 'amber', desc: "Rider doesn't have the product" },
  abandoned: { label: 'Abandoned', tone: 'gray', desc: 'Gave up on this order' },
  deferred_to_client: {
    label: 'Deferred to client',
    tone: 'gray',
    desc: 'Returned to vendor to handle',
  },
  rolled_over: { label: 'Rolled over', tone: 'gray', desc: 'Carried to next day' },
};

/** Customer-facing phrase for a status, for the history timeline's reason line
 *  and the rep's one-tap "Copy note" → WhatsApp paste. Keyed by `to_status` so
 *  the displayed line is a function of the status, never the coarse issue-bucket
 *  stored in `status_history.reason` (e.g. `cant_reach_client`). Statuses NOT in
 *  this map deliberately carry no canned phrase — `will_call_back` / `follow_up`
 *  need rider-supplied context, so the rider's note is shown verbatim instead. */
export const STATUS_CLIENT_PHRASE: Record<string, string> = {
  not_answering: 'Not picking calls',
  not_connecting: 'Number not reachable',
  number_busy: 'Number busy',
  switched_off: 'Number switched off',
  not_around: "Customer said he's not around",
  not_available: "Customer said he's not available",
  available: 'Available',
  available_evening: 'Available in the evening',
  tomorrow: 'Said tomorrow',
  postponed: 'Customer postponed',
  cancelled: 'Customer cancelled the order',
};

/** The five coarse issue buckets stored verbatim in `status_history.reason` by
 *  flag_delivery_issue. They're redundant with the status pill and not
 *  customer-readable, so the history line never surfaces them raw — a status
 *  with a STATUS_CLIENT_PHRASE replaces them, and one without simply drops them.
 *  Genuine free-text reasons (dedup explanations, "reconciled from sheet", agent
 *  cancel notes) are NOT in this set and are always preserved. */
const ISSUE_BUCKET_REASONS = new Set<string>([
  'cant_reach_client',
  'wrong_address',
  'payment_dispute',
  'product_issue',
  'other',
]);

/** The reason line a history row should DISPLAY (and the rep should COPY) for a
 *  given (to_status, stored reason). Pure and shared by both detail screens'
 *  HistoryRow so the two never drift.
 *
 *  `status_history.reason` carries two very different things depending on the
 *  path that wrote the row:
 *    - flag_delivery_issue (cant-reach statuses) stores the coarse issue BUCKET
 *      in `reason` (`cant_reach_client` &c.) and the agent's typed note in
 *      `notes`. The bucket is redundant with the status pill and not
 *      customer-readable, so we swap it for the canned phrase.
 *    - change_delivery_status (postponed/cancelled/tomorrow/available, and every
 *      ops update) stores the agent's/ops's typed FREE-TEXT note directly in
 *      `reason` (with `notes` null). That note is the whole point of the agent
 *      writing it, so it must always win.
 *
 *  Precedence therefore: a genuine free-text reason is shown verbatim; only when
 *  the reason is empty or one of the coarse buckets do we fall back to the
 *  status's canned phrase (or nothing). */
export function historyReasonLine(
  toStatus: string,
  reason: string | null,
  scheduledDate?: string | null,
): string | null {
  const trimmed = reason?.trim();
  if (trimmed && !ISSUE_BUCKET_REASONS.has(trimmed)) return trimmed;
  const phrase = STATUS_CLIENT_PHRASE[toStatus] ?? null;
  // A postpone's most useful fact is WHEN it's coming back. Append the postpone-to
  // date to the canned "Customer postponed" phrase so the timeline line — and the
  // rep's one-tap "Copy note" — reads e.g. "Customer postponed to Thu, 10 Jul".
  // scheduledDate is the delivery's target date: correct for every single-postpone
  // row and the latest postpone of any delivery (only a re-postpone's earlier row
  // could show the newer target, which is rare). Free-text reasons (returned above)
  // are the agent's own words and already imply timing, so we leave those untouched.
  if (phrase === STATUS_CLIENT_PHRASE.postponed && scheduledDate) {
    return `${phrase} to ${formatYmdShort(scheduledDate)}`;
  }
  return phrase;
}

export const STATUS_GROUPS: Record<'active' | 'soft' | 'done' | 'closed', string[]> = {
  active: ['pending', 'available', 'available_evening'],
  soft: [
    'not_answering',
    'number_busy',
    'switched_off',
    'not_connecting',
    'will_call_back',
    'not_available',
    'tomorrow',
    'postponed',
    'follow_up',
    // no_product is a transient supply blocker (rider isn't carrying the
    // product), not an order outcome — a non-terminal soft-fail (Uzo,
    // 2026-06-22). Revertible once Uzo sends the product; never cascades.
    'no_product',
  ],
  done: ['delivered'],
  closed: [
    'cancelled',
    'agent_cancelled',
    // 'Not around' reclassified terminal (Uzo, 2026-06-22): saying "not around"
    // means the customer doesn't want the product, not "try later" — so it closes
    // the order outright and cascade-cancels open siblings (a customer who wants it
    // postpones instead). Mirrors delivery_status_defs.category='terminal'.
    'not_around',
    'failed_delivery',
    'unserious',
    'abandoned',
    'deferred_to_client',
    'rolled_over',
    // Special terminal hand-off states (goods already with agent/courier) —
    // reclassified terminal in delivery_status_defs (Uzo, 2026-06-11). Closed,
    // not editable, excluded from rollover. Still hidden from the status picker.
    'picked_up',
    'waybilled',
  ],
};

/** Statuses that close out a delivery — done + closed buckets. Used to hide
 *  edit/action affordances on screens that should only act on open work. */
export const TERMINAL_STATUSES = new Set<string>([...STATUS_GROUPS.done, ...STATUS_GROUPS.closed]);

/** Terminal statuses whose entry fires side effects: `delivered` triggers
 *  the sibling auto-cancel cascade + stock decrement via current_stock,
 *  `rolled_over` is set by EOD bookkeeping. The UpdateStatusSheet refuses
 *  these for everyone — agents get told to contact admin. Admin and
 *  dispatcher can revert a wrongly-`delivered` row via the dedicated
 *  `revert_delivery_to_pending` RPC, surfaced as a "Revert delivered"
 *  button on the Detail screen's Address card (nulls qty / paid /
 *  payment_method / cash POS fee, flips to pending, stock auto-recovers;
 *  cascade-cancelled siblings stay cancelled and the caller reviews
 *  separately). Rep is excluded by design. Reverting `rolled_over` is
 *  still unimplemented — EOD machinery owns that lifecycle. SQL anchor:
 *  scripts/revert-delivered.sql. */
export const FINAL_STATUSES = new Set<string>(['delivered', 'rolled_over']);

/** Statuses that should never appear in any user-driven status picker — the
 *  system still uses them (rolled_over via EOD, unserious via the 3-strike
 *  cap, picked_up / waybilled / deferred_to_client via internal workflows)
 *  but Uzo wants the Update Status / Bulk Status dropdowns kept to the
 *  options that actually make sense to a human picking from a list. The DB
 *  transitions table is unchanged so server-side machinery keeps working.
 *  Both `UpdateStatusSheet` and `BulkStatusSheet` filter their options
 *  through this set. */
export const STATUS_HIDDEN_FROM_PICKER = new Set<string>([
  'unserious',
  'rolled_over',
  'deferred_to_client',
  'picked_up',
  'waybilled',
  // 'Not my delivery' (agent_cancelled) retired from the picker (Uzo, 2026-06-20):
  // an agent who can't take an order now flags "Not my route" instead, and an
  // admin/dispatcher reassigns it — the order stays alive rather than being
  // terminally cancelled. DB transitions + status def kept intact for historical
  // rows and the rollover sibling-exclusion machinery.
  'agent_cancelled',
  // Agents cannot select 'No product' from either statuses or flags. Keep the
  // status for historical rows and ops-controlled recovery workflows only.
  'no_product',
]);

/** Per-CURRENT-status allow-list for the AGENT status picker only. When an
 *  order's current status is a key here AND the picker is opened from an agent
 *  surface (UpdateStatusSheet `restrictToAgentSet`), the dropdown shows ONLY
 *  these to_status options (still minus `delivered` + STATUS_HIDDEN_FROM_PICKER).
 *  Ops/admin/dispatcher/rep on the ops Detail screen are unaffected. Rationale
 *  (Uzo, 2026-07-09): once an order is `available` (customer reachable) the only
 *  moves that make sense to an agent are reschedule / postpone / follow-up /
 *  fail / customer-cancel — Mark Delivered is its own button. Like
 *  STATUS_HIDDEN_FROM_PICKER this is a UI trim only; the DB transitions table is
 *  unchanged so server-side machinery keeps working. */
export const PICKER_ALLOWED_FROM: Record<string, string[]> = {
  available: ['tomorrow', 'postponed', 'follow_up', 'failed_delivery', 'cancelled'],
};

/** The status options an Update Status picker should offer, given the DB
 *  transitions available from `currentStatus`. Always drops `delivered` (it has
 *  its own MarkDelivered button/sheet) and everything in STATUS_HIDDEN_FROM_PICKER;
 *  on agent surfaces (`restrictToAgentSet`) it also applies the
 *  PICKER_ALLOWED_FROM allow-list for the current status. Pure + generic over the
 *  transition row shape so both UpdateStatusSheet and its tests use one code path. */
export function pickerTransitions<T extends { to_status: string }>(
  transitions: T[],
  currentStatus: string,
  restrictToAgentSet: boolean,
): T[] {
  const allow = restrictToAgentSet ? PICKER_ALLOWED_FROM[currentStatus] : undefined;
  return transitions.filter(
    (t) =>
      t.to_status !== 'delivered' &&
      !STATUS_HIDDEN_FROM_PICKER.has(t.to_status) &&
      (!allow || allow.includes(t.to_status)),
  );
}

export function statusBucket(s: string | null | undefined): keyof typeof STATUS_GROUPS {
  if (!s) return 'active';
  for (const k of Object.keys(STATUS_GROUPS) as (keyof typeof STATUS_GROUPS)[]) {
    if (STATUS_GROUPS[k].includes(s)) return k;
  }
  return 'active';
}

/** "Active" in the ops sense = open work an agent is actually holding.
 *  Deliberately stricter than `statusBucket(s) === 'active'`: an unassigned
 *  pending order is queue work (it belongs under the "Unassigned" segment),
 *  not active work. Centralised here so the deliveries list and any future
 *  dashboard agree on one definition instead of drifting apart. */
export function isAssignedActive(d: {
  current_status: string | null | undefined;
  assigned_agent_id: string | null | undefined;
}): boolean {
  return statusBucket(d.current_status) === 'active' && !!d.assigned_agent_id;
}

/** Statuses for which a rep is NOT expected to send the client a status update.
 *  Everything else — every "blue" worked active status (`available` /
 *  `available_evening`), every "yellow" soft-fail (incl. `no_product`), AND the
 *  non-delivered terminal outcomes that still warrant a heads-up (`cancelled`,
 *  `failed_delivery`, `abandoned`) — IS something the client should hear about.
 *  Exempt, by design:
 *    - `pending`     — the not-yet-worked default;
 *    - `delivered`   — relayed in the once-a-day NIGHT BATCH of delivered reports,
 *                      not per-row (the change from the 2026-06-18 behaviour where
 *                      delivered counted here);
 *    - `rolled_over` — automated EOD bookkeeping on the parent row; the order lives
 *                      on as a fresh child for the next day, so there's nothing new
 *                      to tell the client (and it would flood the queue nightly);
 *    - `agent_cancelled` — an agent passing on their own race/route row; the order is
 *                      reassigned and stays alive, so the customer was NOT cancelled;
 *    - `deferred_to_client`, `unserious`, `picked_up`, `waybilled` — terminal
 *                      outcomes the client doesn't need a per-row status ping for
 *                      (Uzo, 2026-06-23: exempt these from "To notify"). This narrows
 *                      the 2026-06-20 "notify every non-delivered terminal" rule.
 *  Deliberately an exclusion list, not an include list, so a new customer-facing
 *  status added later auto-qualifies. Mirrored by k_notify_exempt in
 *  tools/live-defs/rep-performance.sql (rep-performance SLA denominator). */
const NOTIFY_EXEMPT_STATUSES = new Set<string>([
  'pending',
  'delivered',
  'rolled_over',
  'agent_cancelled',
  'deferred_to_client',
  'unserious',
  'picked_up',
  'waybilled',
]);

/** True when the delivery's LATEST status change is one the client should be told
 *  about but hasn't been yet (latest_notified is false). Powers the rep "Awaiting
 *  client notification" surfaces — the dashboard card and the list's "To notify"
 *  filter — so both share one definition and can't drift. Pure: reads only fields
 *  already on every list row (no extra query). */
export function awaitsClientNotification(d: {
  current_status: string | null | undefined;
  latest_notified: boolean | null | undefined;
}): boolean {
  if (d.latest_notified) return false;
  const s = d.current_status;
  if (!s) return false;
  return !NOTIFY_EXEMPT_STATUSES.has(s);
}

export const TONE_PALETTE: Record<
  Tone,
  { bg: string; soft: string; text: string; softText: string }
> = {
  red: { bg: colors.red, soft: colors.redSoft, text: colors.white, softText: colors.red },
  blue: { bg: colors.info, soft: colors.infoSoft, text: colors.white, softText: colors.infoDark },
  amber: {
    bg: colors.warning,
    soft: colors.warningSoft,
    text: colors.white,
    softText: colors.warningDark,
  },
  green: {
    bg: colors.success,
    soft: colors.successSoft,
    text: colors.white,
    softText: colors.successDark,
  },
  gray: { bg: colors.closed, soft: colors.closedSoft, text: colors.white, softText: colors.closed },
};
