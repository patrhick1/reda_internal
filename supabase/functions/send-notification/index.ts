// Edge Function: send-notification
//
// Generic broadcast function. Subsumes the older send-assignment-push by
// supporting the 'assignment' audience as one case among several.
//
// Body shapes accepted:
//   { audience: 'user', user_id: string, title, body, data? }
//   { audience: 'admins' | 'admins+dispatchers', title, body, data? }
//     - 'admins'              → admin only (used for stock-flavored pushes)
//     - 'admins+dispatchers'  → admin + dispatcher + rep (operational set)
//   { audience: 'assignment', delivery_id: string }
//   { audience: 'status_change', delivery_id: string, new_status: string }
//   { audience: 'warehouse_pickup', delivery_id: string }
//   { audience: 'call_invite', call_id: string }
//
// Fans out to every push_tokens row for the resolved audience. Prunes tokens
// that Expo reports as DeviceNotRegistered.
//
// Deploy: supabase functions deploy send-notification

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { denyIfNotInternal } from '../_shared/internal-auth.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// [Feature A] Shared multi-product helpers for notification composition.
type NotifLine = { product_catalog_id: string; name: string; qty: number };

// Normalize a delivery's lines: use delivery_items when present, else fall back
// to the legacy single product (pre-Phase-1 rows / safety).
function lineItemsOrLegacy(delivery: any): NotifLine[] {
  const items = Array.isArray(delivery?.items) ? delivery.items : [];
  if (items.length > 0) {
    return items.map((i: any) => ({
      product_catalog_id: i.product_catalog_id,
      name: i.product?.product_name ?? 'product',
      qty:  Number(i.quantity_ordered ?? 0),
    }));
  }
  return [{
    product_catalog_id: delivery?.product_catalog_id,
    name: delivery?.product?.product_name ?? 'product',
    qty:  Number(delivery?.quantity_ordered ?? 0),
  }];
}

// One current_stock query for a set of products for a single agent → map of
// product_catalog_id → on-hand.
async function onHandByProduct(supabase: any, agentId: string, productIds: string[]): Promise<Record<string, number>> {
  const ids = productIds.filter(Boolean);
  if (!agentId || ids.length === 0) return {};
  const { data } = await supabase
    .from('current_stock')
    .select('product_catalog_id, quantity_on_hand')
    .eq('agent_id', agentId)
    .in('product_catalog_id', ids);
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as any[]) out[r.product_catalog_id as string] = Number(r.quantity_on_hand ?? 0);
  return out;
}

type Audience =
  | { kind: 'user';                 userId: string }
  | { kind: 'admins' }
  | { kind: 'admins+dispatchers' }
  | { kind: 'assignment';           deliveryId: string }
  | { kind: 'status_change';        deliveryId: string; newStatus: string }
  | { kind: 'warehouse_pickup';     deliveryId: string }
  | { kind: 'call_invite';          callId: string };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Internal-only: callable by DB webhooks / cron / other functions, never the public.
  const denied = denyIfNotInternal(req);
  if (denied) return denied;

  let body: any;
  try { body = await req.json(); }
  catch { return new Response('invalid JSON', { status: 400 }); }

  const audience = parseAudience(body);
  if (!audience) return new Response('audience required', { status: 400 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return new Response('server misconfigured', { status: 500 });
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Resolve audience → { title, body, data, userIds }
  const resolved = await resolve(audience, body, supabase);
  if ('error' in resolved) {
    console.error('resolve failed', resolved.error);
    return new Response(resolved.error, { status: resolved.status });
  }
  const { title, body: text, data, userIds } = resolved;

  if (userIds.length === 0) return new Response('no recipients', { status: 200 });

  // Collect every active token across those users.
  const { data: tokens, error: tokErr } = await supabase
    .from('push_tokens')
    .select('token')
    .in('user_id', userIds);
  if (tokErr) {
    console.error('token lookup failed', tokErr);
    return new Response('token lookup failed', { status: 500 });
  }
  const tokenList = (tokens ?? []).map((r) => r.token as string).filter(Boolean);
  if (tokenList.length === 0) return new Response('no tokens', { status: 200 });

  // Build messages. Expo accepts up to 100 per request; chunk just in case.
  const messages = tokenList.map((to) => ({
    to,
    title,
    body: text,
    data,
    sound: 'default',
    priority: 'high',
    channelId: 'default',
  }));

  const chunks = chunk(messages, 100);
  const stale: string[] = [];

  for (const batch of chunks) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('expo push http failed', res.status, errText);
      continue;
    }
    const json = (await res.json()) as { data?: Array<{ status: string; details?: { error?: string } }> };
    const tickets = json.data ?? [];
    tickets.forEach((t, i) => {
      if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
        stale.push(batch[i].to);
      }
    });
  }

  // Prune dead tokens so the table doesn't grow forever.
  if (stale.length > 0) {
    const { error: delErr } = await supabase
      .from('push_tokens')
      .delete()
      .in('token', stale);
    if (delErr) console.warn('prune failed', delErr);
    else console.log('pruned stale tokens', stale.length);
  }

  return new Response(
    JSON.stringify({ recipients: tokenList.length, pruned: stale.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

function parseAudience(body: any): Audience | null {
  if (!body || typeof body !== 'object') return null;
  switch (body.audience) {
    case 'user':
      if (typeof body.user_id === 'string') return { kind: 'user', userId: body.user_id };
      return null;
    case 'admins':              return { kind: 'admins' };
    case 'admins+dispatchers':  return { kind: 'admins+dispatchers' };
    case 'assignment':
      if (typeof body.delivery_id === 'string') return { kind: 'assignment', deliveryId: body.delivery_id };
      return null;
    case 'status_change':
      if (typeof body.delivery_id === 'string' && typeof body.new_status === 'string') {
        return { kind: 'status_change', deliveryId: body.delivery_id, newStatus: body.new_status };
      }
      return null;
    case 'warehouse_pickup':
      if (typeof body.delivery_id === 'string') return { kind: 'warehouse_pickup', deliveryId: body.delivery_id };
      return null;
    case 'call_invite':
      if (typeof body.call_id === 'string') return { kind: 'call_invite', callId: body.call_id };
      return null;
    default: return null;
  }
}

type Resolved = { title: string; body: string; data: Record<string, unknown> | undefined; userIds: string[] };

async function resolve(
  audience: Audience,
  body: any,
  supabase: ReturnType<typeof createClient>,
): Promise<Resolved | { error: string; status: number }> {
  const dataField = (typeof body.data === 'object' && body.data) ? body.data as Record<string, unknown> : undefined;

  if (audience.kind === 'user') {
    if (typeof body.title !== 'string' || typeof body.body !== 'string') {
      return { error: 'title and body required', status: 400 };
    }
    return { title: body.title, body: body.body, data: dataField, userIds: [audience.userId] };
  }

  if (audience.kind === 'admins' || audience.kind === 'admins+dispatchers') {
    if (typeof body.title !== 'string' || typeof body.body !== 'string') {
      return { error: 'title and body required', status: 400 };
    }
    // admins+dispatchers resolves to the operational-coordinator set:
    // admin + dispatcher + rep. Mirrors the server-side is_admin_or_dispatcher()
    // helper's body. Stock-specific pushes use audience 'admins' instead so
    // rep (no stock access) is excluded by construction.
    const roles = audience.kind === 'admins' ? ['admin'] : ['admin', 'dispatcher', 'rep'];
    const { data: users, error } = await supabase
      .from('users')
      .select('id')
      .in('role', roles)
      .eq('is_active', true);
    if (error) return { error: 'user lookup failed', status: 500 };
    return {
      title: body.title,
      body: body.body,
      data: dataField,
      userIds: (users ?? []).map((u) => u.id as string),
    };
  }

  if (audience.kind === 'assignment') {
    const { data: delivery, error } = await supabase
      .from('deliveries')
      .select(`
        id, customer_name, quantity_ordered, assigned_agent_id, product_catalog_id,
        location:locations(name),
        product:product_catalog(product_name),
        items:delivery_items(quantity_ordered, product_catalog_id, product:product_catalog(product_name))
      `)
      .eq('id', audience.deliveryId)
      .maybeSingle();
    if (error) return { error: 'delivery lookup failed', status: 500 };
    if (!delivery || !delivery.assigned_agent_id) {
      return { title: '', body: '', data: undefined, userIds: [] };
    }
    const locationName = (delivery as any).location?.name ?? 'location TBD';

    // [Feature A] Build the per-line list. Fall back to the legacy single
    // product when no delivery_items rows exist (pre-Phase-1 row).
    const aItems = lineItemsOrLegacy(delivery);
    const productSummary = aItems.map((i) => `${i.name} ×${i.qty}`).join(', ');
    let bodyText = `${delivery.customer_name} — ${locationName} — ${productSummary}`;

    // Per-item warehouse-pickup hint: check the agent's on-hand for EVERY line,
    // list the products short. One stock query for all line products.
    const aStock = await onHandByProduct(supabase, delivery.assigned_agent_id as string, aItems.map((i) => i.product_catalog_id));
    const aShort = aItems
      .map((i) => ({ name: i.name, short: i.qty - (aStock[i.product_catalog_id] ?? 0) }))
      .filter((s) => s.short > 0);
    if (aShort.length > 0) {
      bodyText += ` — pick up ${aShort.map((s) => `${s.short} ${s.name}`).join(', ')} from warehouse first`;
    }

    return {
      title: 'New delivery',
      body:  bodyText,
      data:  { delivery_id: delivery.id },
      userIds: [delivery.assigned_agent_id as string],
    };
  }

  if (audience.kind === 'status_change') {
    // Notify all admins when a delivery hits one of the 5 terminal statuses
    // we care about (decided trigger-side).
    const { data: delivery, error } = await supabase
      .from('deliveries')
      .select(`
        id, customer_name, quantity_ordered, quantity_delivered, paid, product_catalog_id,
        location:locations(name),
        product:product_catalog(product_name),
        items:delivery_items(quantity_ordered, product_catalog_id, product:product_catalog(product_name)),
        agent:users!deliveries_assigned_agent_id_fkey(display_name)
      `)
      .eq('id', audience.deliveryId)
      .maybeSingle();
    if (error) return { error: 'delivery lookup failed', status: 500 };
    if (!delivery) return { title: '', body: '', data: undefined, userIds: [] };

    const { data: admins, error: adminsErr } = await supabase
      .from('users').select('id').eq('role', 'admin').eq('is_active', true);
    if (adminsErr) return { error: 'admin lookup failed', status: 500 };
    const adminIds = (admins ?? []).map((u) => u.id as string);

    const customer = delivery.customer_name ?? 'Customer';
    const location = (delivery as any).location?.name ?? '—';
    // [Feature A] Summarize all products ("Opulent Oud ×2, Atomizer ×4").
    const product  = lineItemsOrLegacy(delivery).map((i) => `${i.name} ×${i.qty}`).join(', ') || '—';
    const agent    = (delivery as any).agent?.display_name?.split(/\s+/)[0] ?? 'Agent';
    const paid     = Number(delivery.paid ?? 0);
    const qty      = delivery.quantity_delivered;

    let title = 'Delivery update';
    let bodyText: string;
    switch (audience.newStatus) {
      case 'delivered':
        title = 'Delivered';
        bodyText = `${agent} delivered to ${customer} · ${location}` +
                   (paid > 0 ? ` · ₦${paid.toLocaleString('en-NG')} collected` : '');
        break;
      case 'failed_delivery':
        title = 'Failed delivery';
        bodyText = `${agent} marked failed: ${customer} · ${location} · ${product}`;
        break;
      case 'cancelled':
        title = 'Delivery cancelled';
        bodyText = `${agent} cancelled: ${customer} · ${location} · ${product}`;
        break;
      case 'unserious':
        title = 'Customer not serious';
        bodyText = `${agent}: ${customer} · ${location} · ${product}`;
        break;
      case 'no_product':
        title = 'Out of stock';
        bodyText = `${agent}: ${customer} · ${location} · ${product}` +
                   (qty != null ? ` × ${qty}` : '');
        break;
      default:
        bodyText = `${agent}: ${customer} · ${location} · status ${audience.newStatus}`;
    }

    return {
      title,
      body: bodyText,
      data: { delivery_id: delivery.id },
      userIds: adminIds,
    };
  }

  if (audience.kind === 'call_invite') {
    // Look up the call + caller's display name. We DO NOT include the Agora
    // token here — that's minted separately by issue-agora-token. This push
    // is the wake-up signal; the mobile client takes over with CallKeep.
    const { data: call, error: callErr } = await supabase
      .from('calls')
      .select(`
        id, callee_id, callee_audience, agora_channel, ringing_until, related_delivery_id,
        caller:users!calls_caller_id_fkey(display_name)
      `)
      .eq('id', audience.callId)
      .maybeSingle();
    if (callErr) return { error: 'call lookup failed', status: 500 };
    if (!call) return { title: '', body: '', data: undefined, userIds: [] };

    const callerName  = (call as any).caller?.display_name ?? 'Someone';
    const callerFirst = callerName.split(/\s+/)[0];
    const isTeamCall  = (call as any).callee_audience === 'ops_team';

    // Resolve recipients. Two shapes:
    //   - 1:1 call → push the named callee; multi-device fanout via push_tokens.
    //   - ops_team call → push every active admin+dispatcher+rep. The first
    //     accepter atomically claims the row server-side; every other phone's
    //     Realtime sub sees the flip and CallKeep dismisses cleanly.
    let recipientIds: string[];
    if (isTeamCall) {
      const { data: opsUsers, error: opsErr } = await supabase
        .from('users')
        .select('id')
        .in('role', ['admin', 'dispatcher', 'rep'])
        .eq('is_active', true);
      if (opsErr) return { error: 'ops user lookup failed', status: 500 };
      recipientIds = (opsUsers ?? []).map((u) => u.id as string);
    } else {
      if (!call.callee_id) {
        return { title: '', body: '', data: undefined, userIds: [] };
      }
      recipientIds = [call.callee_id as string];
    }

    return {
      title: isTeamCall ? 'Team call' : 'Incoming call',
      body:  isTeamCall ? `${callerFirst} needs ops` : `${callerFirst} is calling`,
      data: {
        route:               'call_invite',
        call_id:             call.id,
        agora_channel:       call.agora_channel,
        caller_name:         callerName,
        callee_audience:     (call as any).callee_audience,
        ringing_until:       call.ringing_until,
        related_delivery_id: call.related_delivery_id,
      },
      userIds: recipientIds,
    };
  }

  // audience.kind === 'warehouse_pickup' — warehouse user(s) get pinged when
  // the assigned agent's shortfall can't be covered by warehouse stock, i.e.
  // the warehouse needs to pick up from the client. Trigger-side decides when
  // to fire; this branch only composes the body and resolves recipients.
  {
    const { data: delivery, error } = await supabase
      .from('deliveries')
      .select(`
        id, customer_name, quantity_ordered, product_catalog_id, assigned_agent_id,
        client:clients(name, contact_phone),
        product:product_catalog(product_name),
        location:locations(name),
        items:delivery_items(quantity_ordered, product_catalog_id, product:product_catalog(product_name)),
        agent:users!deliveries_assigned_agent_id_fkey(display_name)
      `)
      .eq('id', audience.deliveryId)
      .maybeSingle();
    if (error) return { error: 'delivery lookup failed', status: 500 };
    if (!delivery) return { title: '', body: '', data: undefined, userIds: [] };

    // [Feature A] Per-line shortfall. Recompute so the body numbers are correct
    // (trigger only says "fire", not "by how much"). Mirrors the trigger's math
    // per product instead of against the single legacy product.
    const wpItems = lineItemsOrLegacy(delivery);
    const productIds = wpItems.map((i) => i.product_catalog_id).filter(Boolean);
    const agentId = (delivery as any).assigned_agent_id as string | null;
    const agentStock = agentId ? await onHandByProduct(supabase, agentId, productIds) : {};

    // Warehouse audience first, then their on-hand per product (one query).
    const { data: warehouseUsers, error: whErr } = await supabase
      .from('users').select('id').eq('role', 'warehouse').eq('is_active', true);
    if (whErr) return { error: 'warehouse lookup failed', status: 500 };
    const userIds = (warehouseUsers ?? []).map((u) => u.id as string);

    const warehouseStock: Record<string, number> = {};
    if (userIds.length > 0 && productIds.length > 0) {
      const { data: rows } = await supabase
        .from('current_stock')
        .select('product_catalog_id, quantity_on_hand')
        .in('product_catalog_id', productIds)
        .in('agent_id', userIds);
      for (const r of (rows ?? []) as any[]) {
        const pid = r.product_catalog_id as string;
        warehouseStock[pid] = (warehouseStock[pid] ?? 0) + Number(r.quantity_on_hand ?? 0);
      }
    }

    // Per product: warehouse must cover what the agent still lacks.
    const wpShort = wpItems
      .map((i) => {
        const agentShortfall = Math.max(0, i.qty - (agentStock[i.product_catalog_id] ?? 0));
        return { name: i.name, short: Math.max(0, agentShortfall - (warehouseStock[i.product_catalog_id] ?? 0)) };
      })
      .filter((s) => s.short > 0);

    const clientName  = (delivery as any).client?.name ?? 'the client';
    const clientPhone = (delivery as any).client?.contact_phone ?? null;
    const locationName = (delivery as any).location?.name ?? '—';
    const agentFirst  = ((delivery as any).agent?.display_name ?? 'Agent').split(/\s+/)[0];
    const customer    = delivery.customer_name ?? 'customer';
    const fromClause = clientPhone ? `${clientName} (☎ ${clientPhone})` : clientName;
    const pickupList = wpShort.length > 0 ? wpShort.map((s) => `${s.short} ${s.name}`).join(', ') : 'stock';
    const bodyText =
      `Pick up ${pickupList} from ${fromClause}. ` +
      `Needed for ${agentFirst}'s delivery to ${customer} · ${locationName}.`;

    return {
      title: 'Stock pickup from client',
      body:  bodyText,
      data:  { route: 'stock', delivery_id: delivery.id },
      userIds,
    };
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
