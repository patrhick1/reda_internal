/** Shared wording/routing for blacklist refusals. No platform dependencies. */
export function blacklistCreationError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const obj = error as { code?: unknown; hint?: unknown };
  if (obj.code !== 'P0001' || typeof obj.hint !== 'string') return null;
  try {
    const hint = JSON.parse(obj.hint);
    if (hint?.kind !== 'blacklisted') return null;
    const phone =
      typeof hint.phone === 'string' && hint.phone.trim() ? ` (${hint.phone.trim()})` : '';
    const reason =
      typeof hint.reason === 'string' && hint.reason.trim()
        ? ` Reason: ${hint.reason.trim()}.`
        : '';
    return `Order not created: this customer's number${phone} is blacklisted.${reason} Your details are still here. Check the number, or ask a manager to review the blacklist entry.`;
  } catch {
    return null;
  }
}

export function blockedOrdersRoute(role: string, inboundId?: unknown): `/${string}` | null {
  const base =
    role === 'admin'
      ? '/(admin)/needs-review'
      : role === 'dispatcher'
        ? '/(dispatcher)/review'
        : role === 'rep'
          ? '/(rep)/review'
          : null;
  if (!base) return null;
  const id =
    typeof inboundId === 'string' && /^[0-9a-f-]{36}$/i.test(inboundId)
      ? `&inboundId=${encodeURIComponent(inboundId)}`
      : '';
  return `${base}?tab=blocked${id}`;
}
