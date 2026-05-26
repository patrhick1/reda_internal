/** Format Nigerian Naira money. Returns "₦5,000" or "—" for null/undefined. */
export function formatNaira(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/** Format a Nigerian phone number as the user types.
 *   "08031234567"  → "0803 123 4567"
 *   "2348031234567" → "+234 803 123 4567"
 *  Falls back to the raw input if it doesn't look Nigerian. */
export function formatNgPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length <= 11) {
    return digits.replace(/(\d{4})(\d{0,3})(\d{0,4}).*/, (_, a, b, c) =>
      [a, b, c].filter(Boolean).join(' '));
  }
  if (digits.startsWith('234') && digits.length <= 13) {
    return '+' + digits.replace(/(\d{3})(\d{3})(\d{0,3})(\d{0,4}).*/, (_, a, b, c, d) =>
      [a, b, c, d].filter(Boolean).join(' '));
  }
  return raw;
}

/** Format an ISO timestamp as "Mar 15, 2026 14:22" in Africa/Lagos. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
