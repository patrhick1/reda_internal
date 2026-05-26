// Edge Function: send_assignment_push
// Triggered when a delivery's assigned_agent_id is set (insert or update).
// Looks up the agent's expo_push_token and fires an Expo push.
//
// Deploy:    supabase functions deploy send-assignment-push
// Invoke:    automatically by the DB trigger via pg_net (see SQL).
// Env vars:  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (set in Supabase dashboard
//            → Project Settings → Edge Functions → Secrets, or auto-populated for
//            functions running inside Supabase).

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Accept two shapes:
  //   { delivery_id: "..." }                          — manual / direct call
  //   { type, table, record, old_record, schema }     — Supabase Database Webhook
  let deliveryId: string | undefined;
  if (typeof body.delivery_id === 'string') {
    deliveryId = body.delivery_id;
  } else if (body.record && typeof body.record.id === 'string') {
    // Only fire if assignment is actually present (and changed, for UPDATE).
    const newAssignee = body.record.assigned_agent_id;
    const oldAssignee = body.old_record?.assigned_agent_id ?? null;
    if (!newAssignee) {
      return new Response('no assignee', { status: 200 });
    }
    if (body.type === 'UPDATE' && newAssignee === oldAssignee) {
      return new Response('assignee unchanged', { status: 200 });
    }
    deliveryId = body.record.id;
  }
  if (!deliveryId) {
    return new Response('delivery_id required', { status: 400 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response('server misconfigured', { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Look up the delivery + assigned agent + their token.
  const { data: delivery, error } = await supabase
    .from('deliveries')
    .select(`
      id, customer_name, quantity_ordered, assigned_agent_id,
      location:locations(name),
      product:product_catalog(product_name),
      assignee:users!deliveries_assigned_agent_id_fkey(expo_push_token, display_name)
    `)
    .eq('id', deliveryId)
    .maybeSingle();

  if (error) {
    console.error('lookup error', error);
    return new Response('lookup error', { status: 500 });
  }
  if (!delivery || !delivery.assigned_agent_id) {
    return new Response('not assigned', { status: 200 });
  }

  const token = (delivery as any).assignee?.expo_push_token;
  if (!token) {
    return new Response('no push token for assignee', { status: 200 });
  }

  // PRD §5.14 notification copy: "Customer name — Location — Product × Qty"
  const locationName = (delivery as any).location?.name ?? 'location TBD';
  const productName  = (delivery as any).product?.product_name ?? 'product TBD';
  const body_text = `${delivery.customer_name} — ${locationName} — ${productName} × ${delivery.quantity_ordered}`;

  const pushRes = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      to: token,
      title: 'New delivery',
      body: body_text,
      data: { delivery_id: delivery.id },
      sound: 'default',
      priority: 'high',
    }),
  });

  if (!pushRes.ok) {
    const errText = await pushRes.text();
    console.error('expo push failed', errText);
    return new Response(errText, { status: 502 });
  }

  return new Response('ok', { status: 200 });
});
