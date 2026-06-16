// Shared internal-auth gate for edge functions that should ONLY be reachable by
// trusted internal callers (DB webhooks, cron, other edge functions) — never by
// the public or by ordinary authenticated users. The mobile app does not call
// any of these directly.
//
// Accepts the request iff EITHER:
//   * header `x-internal-secret` matches INTERNAL_FUNCTION_SECRET, OR
//   * `Authorization: Bearer <token>` matches SUPABASE_SERVICE_ROLE_KEY
//     (so existing service-role callers — cron, supabase.functions.invoke from
//      another function, and DB webhooks that send the service key — keep working
//      with no change).
//
// Mirrors the timing-safe comparison already used by the webhook functions.

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Returns a 401 Response if the caller is not a trusted internal caller, else null. */
export function denyIfNotInternal(req: Request): Response | null {
  const internal = Deno.env.get('INTERNAL_FUNCTION_SECRET') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const hdr = req.headers.get('x-internal-secret') ?? '';
  const authz = req.headers.get('authorization') ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

  const ok =
    (internal.length > 0 && timingSafeEqual(hdr, internal)) ||
    (serviceKey.length > 0 && bearer.length > 0 && timingSafeEqual(bearer, serviceKey));

  return ok ? null : new Response('unauthorized', { status: 401 });
}
