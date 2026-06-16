CREATE OR REPLACE FUNCTION public.change_delivery_status(p_client_uuid text, p_delivery_id uuid, p_to_status text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_quantity_delivered integer DEFAULT NULL::integer, p_paid numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT NULL::text, p_effective_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_new_scheduled_date date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_delivery       record;
  v_transition     record;
  v_actor          uuid := auth.uid();
  v_is_admin       boolean := public.is_admin();
  v_is_dispatcher  boolean := public.is_admin_or_dispatcher();
  v_role           text := public.current_user_role();
  v_effective      timestamptz := coalesce(p_effective_at, now());
  v_existing       uuid;
  v_on_hand        int;
  v_new_date       date;
begin
  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;

  select id into v_existing
    from public.delivery_status_history
   where client_uuid = p_client_uuid
   limit 1;
  if v_existing is not null then
    return;
  end if;

  select * into v_delivery from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if v_delivery.deleted_at is not null then
    raise exception 'delivery has been deleted' using errcode = '22023';
  end if;

  if v_delivery.current_status = p_to_status then
    return;
  end if;

  select * into v_transition
    from public.delivery_status_transitions
   where from_status = v_delivery.current_status
     and to_status   = p_to_status;
  if not found then
    raise exception 'invalid transition: % -> %', v_delivery.current_status, p_to_status using errcode = '22023';
  end if;

  if v_transition.requires_admin then
    if not v_is_admin then
      raise exception 'this transition requires admin' using errcode = '42501';
    end if;
  else
    if not (
      v_is_dispatcher
      or (v_role = 'agent' and v_delivery.assigned_agent_id = v_actor)
    ) then
      raise exception 'permission denied' using errcode = '42501';
    end if;
  end if;

  if v_transition.requires_reason and nullif(trim(p_reason), '') is null then
    raise exception 'reason required for this transition' using errcode = '23514';
  end if;

  if p_to_status = 'postponed' and p_new_scheduled_date is not null then
    if p_new_scheduled_date <= current_date then
      raise exception 'postpone date must be in the future (got %, today is %)',
        p_new_scheduled_date, current_date
        using errcode = '23514';
    end if;
    v_new_date := public._ensure_workday(p_new_scheduled_date);
  end if;

  if p_to_status = 'delivered' then
    if p_quantity_delivered is null or p_quantity_delivered <= 0 then
      raise exception 'quantity_delivered required (> 0) for delivered status' using errcode = '23514';
    end if;
    if p_paid is null or p_paid < 0 then
      raise exception 'paid required (>= 0) for delivered status' using errcode = '23514';
    end if;
    if p_payment_method not in ('cash','transfer') then
      raise exception 'payment_method must be ''cash'' or ''transfer''' using errcode = '23514';
    end if;

    -- Row-state precondition: a row with no location_id has NULL
    -- charged_snapshot and NULL agent_payment_snapshot (rate snapshots
    -- are derived from location at create time and never recomputed).
    -- Allowing it to reach delivered would silently zero Reda's fee
    -- AND the agent's earning. Force admin to set the location first.
    if v_delivery.location_id is null then
      raise exception
        'this delivery has no location set. Ask admin to edit the delivery and set the location before marking delivered.'
      using errcode = 'P0001',
            hint = jsonb_build_object(
              'code',        'location_required',
              'delivery_id', p_delivery_id
            )::text;
    end if;

    -- §14-4 GUARD (added 2026-06-08): a delivered row with no assigned agent
    -- decrements no stock (current_stock requires assigned_agent_id IS NOT
    -- NULL), runs no stock check, and credits no rider — it silently slips
    -- every inventory/reconciliation net. Require an agent before delivered.
    -- Assign the row (Edit screen / bulk-assign) first, then mark delivered.
    if v_delivery.assigned_agent_id is null then
      raise exception
        'cannot mark delivered: no agent is assigned to this delivery. Assign an agent first.'
      using errcode = 'P0001',
            hint = jsonb_build_object(
              'code',        'no_agent_assigned',
              'delivery_id', p_delivery_id
            )::text;
    end if;

    if v_delivery.assigned_agent_id is not null then
      select coalesce(quantity_on_hand, 0) into v_on_hand
        from public.current_stock
       where agent_id           = v_delivery.assigned_agent_id
         and product_catalog_id = v_delivery.product_catalog_id;

      if coalesce(v_on_hand, 0) < p_quantity_delivered then
        raise exception
          'insufficient_stock: agent has % units, delivery needs %',
          coalesce(v_on_hand, 0), p_quantity_delivered
        using errcode = 'P0001',
              hint = jsonb_build_object(
                'code',    'insufficient_stock',
                'on_hand', coalesce(v_on_hand, 0),
                'needed',  p_quantity_delivered
              )::text;
      end if;
    end if;
  end if;

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status,
    changed_by_user_id, client_uuid, effective_at,
    reason, notes
  ) values (
    p_delivery_id, v_delivery.current_status, p_to_status,
    v_actor, p_client_uuid, v_effective,
    p_reason, p_notes
  );

  update public.deliveries
     set current_status      = p_to_status,
         scheduled_date      = case when v_new_date is not null then v_new_date
                                    else scheduled_date end,
         quantity_delivered  = case when p_to_status = 'delivered' then p_quantity_delivered
                                    else quantity_delivered end,
         paid                = case when p_to_status = 'delivered' then p_paid
                                    else paid end,
         payment_method      = case when p_to_status = 'delivered' then p_payment_method
                                    else payment_method end,
         cash_pos_fee_snapshot = case
                                    when p_to_status = 'delivered'
                                         and p_payment_method = 'cash'
                                         and coalesce(p_paid, 0) > 0
                                      then 500
                                    when p_to_status = 'delivered'
                                      then 0
                                    else cash_pos_fee_snapshot
                                  end
   where id = p_delivery_id;

  perform public.write_audit(
    'delivery', p_delivery_id,
    jsonb_build_object(
      'current_status',         v_delivery.current_status,
      'scheduled_date',         v_delivery.scheduled_date,
      'quantity_delivered',     v_delivery.quantity_delivered,
      'paid',                   v_delivery.paid,
      'payment_method',         v_delivery.payment_method,
      'cash_pos_fee_snapshot',  v_delivery.cash_pos_fee_snapshot
    ),
    jsonb_build_object(
      'current_status',         p_to_status,
      'scheduled_date',         coalesce(v_new_date, v_delivery.scheduled_date),
      'quantity_delivered',     case when p_to_status = 'delivered' then p_quantity_delivered else v_delivery.quantity_delivered end,
      'paid',                   case when p_to_status = 'delivered' then p_paid               else v_delivery.paid end,
      'payment_method',         case when p_to_status = 'delivered' then p_payment_method     else v_delivery.payment_method end,
      'cash_pos_fee_snapshot',  case
                                  when p_to_status = 'delivered'
                                       and p_payment_method = 'cash'
                                       and coalesce(p_paid, 0) > 0
                                    then 500
                                  when p_to_status = 'delivered'
                                    then 0
                                  else v_delivery.cash_pos_fee_snapshot
                                end
    ),
    p_reason
  );
end;
$function$

