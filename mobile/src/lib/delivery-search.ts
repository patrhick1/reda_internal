/** Keep name searches literal in PostgREST's OR-filter grammar. */
export function sanitizeDeliverySearch(term: string): string {
  return term
    .replace(/[%_,()"\\*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Search only: never use this to change customer identity or payment grouping.
 * Mirrors SQL _delivery_phone_search_key, including the 00234 dialling prefix. */
export function phoneSearchKey(phone: string | null | undefined): string {
  let digits = (phone ?? '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00234')) digits = digits.slice(2);
  if (digits.startsWith('234')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

export function phoneSearchTerms(query: string): string[] {
  const digits = query.replace(/[^0-9]/g, '');
  // Keep the literal fragment too: "031" or "234" can occur inside a number.
  // Neither an empty prefix nor one/two digits should match every order.
  return [...new Set([phoneSearchKey(digits), digits])].filter((term) => term.length >= 3);
}

export function deliverySearchFilter(query: string): string {
  const term = sanitizeDeliverySearch(query);
  const filters = [`customer_name.ilike.%${term}%`];
  for (const phone of phoneSearchTerms(term)) {
    filters.push(`customer_phone_search.ilike.%${phone}%`);
    filters.push(`customer_phone_alt_search.ilike.%${phone}%`);
  }
  return filters.join(',');
}

export function matchesDeliverySearch(
  row: {
    customer_name?: string | null;
    customer_phone?: string | null;
    customer_phone_alt?: string | null;
  },
  query: string,
): boolean {
  const term = sanitizeDeliverySearch(query).toLowerCase();
  if (!term || (row.customer_name ?? '').toLowerCase().includes(term)) return true;
  const numbers = [phoneSearchKey(row.customer_phone), phoneSearchKey(row.customer_phone_alt)];
  return phoneSearchTerms(term).some((needle) => numbers.some((number) => number.includes(needle)));
}
