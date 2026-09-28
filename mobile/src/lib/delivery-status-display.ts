/** A client-policy closure shares a stored status with actual delivery failures.
 * Use the recorded event, never today's client setting, to distinguish them. */
export function isClientPolicyClosure(status: string, reason?: string | null): boolean {
  if (status !== 'failed_delivery') return false;
  const value = reason?.trim() ?? '';
  return (
    /^(?:maintenance:(?:manual_)?close_policy|eod_auto_cancel:client_policy)(?:$|;)/.test(value) ||
    /^postponed order came due.*auto-cancelled.*client policy/i.test(value)
  );
}

export const CLIENT_POLICY_CLOSURE_EXPLANATION =
  'Closed because this client’s orders do not roll over.';
