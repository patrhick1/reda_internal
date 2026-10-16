// Reconcile customer contacts as a pair, before dropping equivalent numbers.
// Read only explicit customer phone labels, never arbitrary digit sequences
// (which may be bank accounts, order references, or the sales rep's number).
export function resolveCustomerPhones(
  text: string,
  contractor: Array<string | null | undefined>,
  extracted: Array<string | null | undefined>,
): { primary: string | null; alternate: string | null } {
  const normalize = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const digits = value.replace(/[^\d+]/g, '');
    return digits.length >= 10 ? digits : null;
  };
  const key = (value: string): string => value.replace(/\D/g, '').replace(/^234/, '').replace(/^0/, '');
  const labeled: string[] = [];
  const whatsapp: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\*?\s*((?:customer\s+)?(?:phone|mobile|telephone)(?:\s*(?:number|no\.?|#|[12]))?|whatsapp(?:\s*(?:number|no\.?|#))?)\s*\*?\s*:\s*\*?\s*((?:\+?234|0)[\d ()-]+)\s*\*?\s*$/i);
    if (!match) continue;
    const phone = normalize(match[2]);
    // Strict Nigerian mobile shape for deterministic raw-text recovery.
    if (!phone || !/^[789]\d{9}$/.test(key(phone))) continue;
    (/^whatsapp/i.test(match[1]) ? whatsapp : labeled).push(phone);
  }
  const distinct: string[] = [];
  // A WhatsApp-only label must not displace an otherwise valid primary.
  const candidates = labeled.length
    ? [...labeled, ...whatsapp, ...contractor, ...extracted]
    : [...contractor, ...extracted, ...whatsapp];
  for (const candidate of candidates) {
    const phone = normalize(candidate);
    if (phone && !distinct.some(existing => key(existing) === key(phone))) distinct.push(phone);
  }
  return { primary: distinct[0] ?? null, alternate: distinct[1] ?? null };
}
