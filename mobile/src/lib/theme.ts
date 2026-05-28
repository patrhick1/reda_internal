// Reda design tokens — translated from the brand kit. Keep this file as the
// single source of truth; never inline hex colors or font names in screens.

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
export const STATUS_META: Record<string, { label: string; tone: Tone; desc: string }> = {
  pending: { label: 'Pending', tone: 'red', desc: 'Awaiting agent' },
  available: { label: 'Available', tone: 'blue', desc: 'Customer reachable' },
  available_evening: {
    label: 'Available (evening)',
    tone: 'blue',
    desc: 'Customer reachable in the evening',
  },
  not_answering: { label: 'Not answering', tone: 'amber', desc: 'No answer' },
  number_busy: { label: 'Number busy', tone: 'amber', desc: 'Line busy' },
  switched_off: { label: 'Switched off', tone: 'amber', desc: 'Phone off' },
  not_connecting: { label: 'Not connecting', tone: 'amber', desc: "Call won't connect" },
  not_around: { label: 'Not around', tone: 'amber', desc: 'Customer not at location' },
  will_call_back: { label: 'Will call back', tone: 'amber', desc: 'Customer asked to call later' },
  not_available: { label: 'Not available', tone: 'amber', desc: "Customer can't take it now" },
  tomorrow: { label: 'Tomorrow', tone: 'amber', desc: 'Customer rescheduled' },
  postponed: { label: 'Postponed', tone: 'amber', desc: 'Pushed later' },
  follow_up: { label: 'Follow up', tone: 'amber', desc: 'Needs follow-up' },
  picked_up: { label: 'Picked up', tone: 'blue', desc: 'Customer collected order' },
  waybilled: { label: 'Waybilled', tone: 'blue', desc: 'Shipped via waybill' },
  delivered: { label: 'Delivered', tone: 'green', desc: 'Done' },
  cancelled: { label: 'Cancelled', tone: 'gray', desc: 'Closed' },
  failed_delivery: { label: 'Failed', tone: 'gray', desc: 'Could not deliver' },
  unserious: { label: 'Unserious', tone: 'gray', desc: 'Customer not serious' },
  no_product: { label: 'No product', tone: 'gray', desc: 'Out of stock' },
  abandoned: { label: 'Abandoned', tone: 'gray', desc: 'Gave up on this order' },
  deferred_to_client: {
    label: 'Deferred to client',
    tone: 'gray',
    desc: 'Returned to vendor to handle',
  },
  rolled_over: { label: 'Rolled over', tone: 'gray', desc: 'Carried to next day' },
};

export const STATUS_GROUPS: Record<'active' | 'soft' | 'done' | 'closed', string[]> = {
  active: ['pending', 'available', 'available_evening'],
  soft: [
    'not_answering',
    'number_busy',
    'switched_off',
    'not_connecting',
    'not_around',
    'will_call_back',
    'not_available',
    'tomorrow',
    'postponed',
    'follow_up',
    'picked_up',
    'waybilled',
  ],
  done: ['delivered'],
  closed: [
    'cancelled',
    'failed_delivery',
    'unserious',
    'no_product',
    'abandoned',
    'deferred_to_client',
    'rolled_over',
  ],
};

/** Statuses that close out a delivery — done + closed buckets. Used to hide
 *  edit/action affordances on screens that should only act on open work. */
export const TERMINAL_STATUSES = new Set<string>([...STATUS_GROUPS.done, ...STATUS_GROUPS.closed]);

export function statusBucket(s: string | null | undefined): keyof typeof STATUS_GROUPS {
  if (!s) return 'active';
  for (const k of Object.keys(STATUS_GROUPS) as (keyof typeof STATUS_GROUPS)[]) {
    if (STATUS_GROUPS[k].includes(s)) return k;
  }
  return 'active';
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
