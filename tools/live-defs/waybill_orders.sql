-- ============================================================================
-- Waybill / pickup orders. Paste-and-run as ONE script in the Supabase SQL editor.
--
-- A waybill/pickup is NOT a product delivery — it's a money record that rides
-- the deliveries table so it lands in the delivery report + client remittance.
-- It has a client but NO product, NO customer phone, NO address, NO agent. Reda
-- books an Uber (or pays a waybill driver), charges the client a (usually lower)
-- fee, and may pass storekeeper/driver cash straight through.
--
-- Money mapping (so existing formulas Just Work, no view-math change):
--   charged_snapshot       = total to bill the client (pickup fee + pass-throughs)
--   agent_payment_snapshot = total Reda paid out      (trip fare + pass-throughs)
--   paid                   = 0 (no customer paid Reda; this is a CLIENT charge)
-- Margin = charged_snapshot - agent_payment_snapshot. The client-remit formula
-- sees 0 - charged_snapshot, correctly deducting the pickup/waybill charge from
-- what Reda owes the client. Pass-throughs add to both charged and paid-out so
-- they net to zero in margin, but remain part of the client's total charge.
-- agent_payment_snapshot is inert for agent settlement here (no assigned agent).
--
-- Discriminator: order_type ('delivery' default | 'waybill'). It (a) lets these
-- rows legitimately skip product/phone/address, (b) keeps them out of the
-- negative-margin review, (c) tells the app "no product here".
-- ============================================================================

begin;

-- 1. order_type discriminator -------------------------------------------------
alter table public.deliveries
  add column if not exists order_type text not null default 'delivery';

alter table public.deliveries drop constraint if exists deliveries_order_type_check;
alter table public.deliveries
  add constraint deliveries_order_type_check check (order_type in ('delivery','waybill'));

-- 2. Relax the 3 NOT NULLs a waybill can't satisfy ...
alter table public.deliveries alter column product_catalog_id drop not null;
alter table public.deliveries alter column customer_phone     drop not null;
alter table public.deliveries alter column raw_address         drop not null;

-- 3. ... but KEEP integrity for real deliveries (type-gated). Existing rows are
--    all order_type='delivery' with these fields set, so this validates clean.
alter table public.deliveries drop constraint if exists deliveries_delivery_requires_fields;
alter table public.deliveries
  add constraint deliveries_delivery_requires_fields check (
    order_type <> 'delivery'
    or (product_catalog_id is not null and customer_phone is not null and raw_address is not null)
  );

-- 4. Trigger guards: a waybill must not auto-assign an agent or fire a customer
--    "delivered" notification. (The stock-pickup + message triggers already
--    early-return on a null assigned_agent_id, so they need no change.)
create or replace function public.tg_auto_assign_on_insert()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if new.assigned_agent_id is null
     and new.deleted_at is null
     and new.created_via <> 'rollover'
     and new.order_type <> 'waybill'
     and coalesce((public.get_flag('enable_auto_assign')->>'enabled')::boolean, true)
  then
    begin
      perform public.auto_assign_delivery(new.id);
    exception when others then
      perform public.write_audit(
        p_actor_id    := null,
        p_entity_type := 'delivery',
        p_entity_id   := new.id,
        p_old         := null,
        p_new         := jsonb_build_object('error', sqlerrm),
        p_reason      := 'auto_assign: error'
      );
    end;
  end if;
  return null;
end;
$function$;

create or replace function public.tg_notify_delivery_status_change()
 returns trigger language plpgsql security definer
as $function$
declare
  v_notify_set text[] := array['delivered','cancelled','failed_delivery','unserious','no_product'];
begin
  if new.order_type <> 'waybill'
     and new.current_status = any(v_notify_set)
     and (TG_OP = 'INSERT' or old.current_status is distinct from new.current_status)
  then
    perform public.send_edge_notification(jsonb_build_object(
      'audience',    'status_change',
      'delivery_id', new.id,
      'new_status',  new.current_status
    ));
  end if;
  return new;
end;
$function$;

-- 5. Expose order_type on the role-scoped views (appended; CREATE OR REPLACE
--    only allows adding columns at the end).
create or replace view public.deliveries_admin as
 select d.id, d.client_id, d.product_catalog_id, d.location_id, d.assigned_agent_id,
    d.parent_delivery_id, d.customer_name, d.customer_phone, d.raw_address,
    d.quantity_ordered, d.quantity_delivered, d.customer_price, d.paid, d.payment_method,
    d.charged_snapshot, d.agent_payment_snapshot, d.current_status, d.created_date,
    d.scheduled_date, d.created_by_user_id, d.created_via, d.bot_raw_message, d.created_at,
    d.updated_at, d.deleted_at,
    coalesce(d.charged_snapshot, 0::numeric) - coalesce(d.agent_payment_snapshot, 0::numeric) as margin,
    lh.id as latest_history_id, lh.changed_at as latest_changed_at,
    ln.status_history_id is not null as latest_notified,
    d.customer_phone_alt, lm.created_at as latest_message_at,
    d.rolled_from_status, d.rolled_from_date, d.rollover_count, d.delivery_instructions,
    d.assigned_at,
    d.order_type
   from deliveries d
     left join lateral ( select h.id, h.changed_at from delivery_status_history h
          where h.delivery_id = d.id order by h.changed_at desc limit 1) lh on true
     left join delivery_client_notifications ln on ln.status_history_id = lh.id
     left join lateral ( select m.created_at from delivery_messages m
          where m.delivery_id = d.id order by m.created_at desc limit 1) lm on true
  where is_admin() and d.deleted_at is null;

create or replace view public.deliveries_safe as
 select d.id, d.client_id, d.product_catalog_id, d.location_id, d.customer_name,
    d.customer_phone, d.raw_address, d.quantity_ordered, d.quantity_delivered,
    d.customer_price, d.paid, d.payment_method,
    case when d.assigned_agent_id = auth.uid() then d.agent_payment_snapshot else null::numeric end as agent_payment_snapshot,
    d.assigned_agent_id, d.created_by_user_id, d.current_status, d.bot_raw_message, d.created_via,
    d.parent_delivery_id, d.scheduled_date, d.created_date, d.created_at, d.updated_at,
    lh.id as latest_history_id, lh.changed_at as latest_changed_at,
    ln.status_history_id is not null as latest_notified,
    d.customer_phone_alt, lm.created_at as latest_message_at,
    d.rolled_from_status, d.rolled_from_date, d.rollover_count, d.delivery_instructions,
    d.assigned_at,
    d.order_type
   from deliveries d
     left join lateral ( select h.id, h.changed_at from delivery_status_history h
          where h.delivery_id = d.id order by h.changed_at desc limit 1) lh on true
     left join delivery_client_notifications ln on ln.status_history_id = lh.id
     left join lateral ( select m.created_at from delivery_messages m
          where m.delivery_id = d.id order by m.created_at desc limit 1) lm on true
  where d.deleted_at is null and (is_admin_or_dispatcher() or d.assigned_agent_id = auth.uid());

-- 6. create_waybill RPC -------------------------------------------------------
create or replace function public.create_waybill(
  p_client_id      uuid,
  p_charged        numeric,
  p_paid           numeric,
  p_note           text default null,
  p_label          text default 'Waybill',
  p_scheduled_date date default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_id    uuid;
  v_role  text;
  v_date  date := coalesce(p_scheduled_date, (now() at time zone 'Africa/Lagos')::date);
  v_label text := coalesce(nullif(btrim(p_label), ''), 'Waybill');
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'a client is required for a waybill' using errcode = '23514';
  end if;
  if p_charged is null or p_charged < 0 then
    raise exception 'charged must be a non-negative number' using errcode = '23514';
  end if;
  if p_paid is null or p_paid < 0 then
    raise exception 'paid out must be a non-negative number' using errcode = '23514';
  end if;

  -- author_role for the breakdown note; is_manager() guarantees admin|dispatcher.
  select role into v_role from public.users where id = v_actor;
  v_role := case when v_role in ('admin','dispatcher') then v_role else 'admin' end;

  insert into public.deliveries (
    client_id, order_type,
    customer_name, quantity_ordered, quantity_delivered, customer_price,
    charged_snapshot, agent_payment_snapshot, paid,
    current_status, created_via, created_date, scheduled_date, created_by_user_id
  ) values (
    p_client_id, 'waybill',
    v_label, 1, 1, 0,
    p_charged, p_paid, 0,              -- no customer collection; p_paid is Reda's payout
    'delivered', 'manual', v_date, v_date, v_actor
  ) returning id into v_id;

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at
  ) values (v_id, null, 'delivered', v_actor, gen_random_uuid(), now());

  if nullif(btrim(p_note), '') is not null then
    insert into public.delivery_messages (delivery_id, author_id, author_role, note)
      values (v_id, v_actor, v_role, btrim(p_note));
  end if;

  perform public.write_audit(
    'delivery', v_id, null,
    jsonb_build_object(
      'order_type',             'waybill',
      'client_id',              p_client_id,
      'customer_name',          v_label,
      'charged_snapshot',       p_charged,
      'agent_payment_snapshot', p_paid,
      'paid',                   0,
      'waybill_paid_out',       p_paid,
      'note',                   nullif(btrim(p_note), ''),
      'current_status',         'delivered'
    ),
    'create_waybill'
  );

  return v_id;
end;
$function$;

grant execute on function public.create_waybill(uuid, numeric, numeric, text, text, date) to authenticated;

commit;
