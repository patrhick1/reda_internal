-- Targeted live definition for create_waybill accounting.
--
-- `p_paid` is retained as the RPC argument name for compatibility, but means
-- the total Reda paid out. deliveries.paid remains 0 because that column is
-- customer money collected and drives client reconciliation.

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
    p_charged, p_paid, 0,
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

grant execute on function public.create_waybill(uuid, numeric, numeric, text, text, date)
  to authenticated;
