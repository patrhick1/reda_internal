CREATE OR REPLACE FUNCTION public.rollover_delivery(p_client_uuid text, p_delivery_id uuid, p_new_scheduled_date date DEFAULT NULL::date, p_reason text DEFAULT 'eod_rollover'::text, p_notify boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  -- Carry cap: how many times a soft-fail / never-attempted order may roll
  -- before it closes out to unserious. 1 = original day + exactly ONE follow-up
  -- day, then stop. (Lowered from 2 on 2026-06-20 — Reda follows up one day, not
  -- two days in a row.) Single source of truth: the comparison AND the reason
  -- string below both derive from this constant so they can never drift.
  v_carry_cap constant int := 1;
  v_actor uuid := auth.uid();
  v_old   public.deliveries%rowtype;
  v_new_id uuid;
  v_new_date date;
  v_rate_charged numeric;
  v_rate_agent_payment numeric;
  v_charged numeric;
  v_agent_payment numeric;
  v_existing_new uuid;
  v_is_strike boolean;
  v_category   text;
  v_cap_applies boolean;
  v_new_rollover_count int;
  v_rolled_from_status text;
  v_rolled_from_date   date;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'rollover requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  if p_client_uuid is null or btrim(p_client_uuid) = '' then
    raise exception 'client_uuid required for idempotency' using errcode = '22023';
  end if;

  select id into v_existing_new
  from public.deliveries
  where parent_delivery_id = p_delivery_id
    and created_via = 'rollover'
  limit 1;
  if v_existing_new is not null then
    return v_existing_new;
  end if;

  select * into v_old from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;

  if v_old.deleted_at is not null then
    raise exception 'cannot roll a deleted delivery' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.delivery_status_defs
    where status = v_old.current_status and category = 'terminal'
  ) then
    raise exception 'delivery already terminal (status=%) — nothing to roll', v_old.current_status
      using errcode = '22023';
  end if;

  v_is_strike := v_old.current_status in (
    'not_answering','not_around','not_available',
    'not_connecting','number_busy','switched_off'
  );

  select sd.category in ('initial','soft_failure')
    into v_cap_applies
    from public.delivery_status_defs sd
   where sd.status = v_old.current_status;

  if v_cap_applies and v_old.rollover_count >= v_carry_cap then
    perform public.change_delivery_status(
      p_client_uuid     := p_client_uuid || ':cap-unserious',
      p_delivery_id     := v_old.id,
      p_to_status       := 'unserious',
      p_reason          := 'carry-cap reached (' || v_carry_cap || ' rollover)',
      p_notes           := null,
      p_paid            := null,
      p_quantity_delivered := null,
      p_payment_method  := null,
      p_effective_at    := now()
    );
    if p_notify then
      perform public._notify_admins_carry_cap(v_old.id);
    end if;
    return null;
  end if;

  v_new_date := public._ensure_workday(
    coalesce(p_new_scheduled_date, (v_old.scheduled_date + interval '1 day')::date)
  );

  if v_old.location_id is not null then
    select charged, agent_payment into v_rate_charged, v_rate_agent_payment
    from public.current_rate_for_location(v_old.location_id);
  end if;
  v_charged       := coalesce(v_rate_charged,       v_old.charged_snapshot);
  v_agent_payment := coalesce(v_rate_agent_payment, v_old.agent_payment_snapshot);

  v_new_rollover_count := case when v_cap_applies then v_old.rollover_count + 1
                               else v_old.rollover_count end;

  -- Carry the last MEANINGFUL status forward: the parent's status if it was
  -- attempted (not 'pending'), else inherit whatever the parent was already
  -- carrying. 'pending' means "never attempted that day", so it isn't worth
  -- surfacing and shouldn't clobber an earlier real attempt.
  if v_old.current_status <> 'pending' then
    v_rolled_from_status := v_old.current_status;
    v_rolled_from_date   := v_old.scheduled_date;
  else
    v_rolled_from_status := v_old.rolled_from_status;
    v_rolled_from_date   := v_old.rolled_from_date;
  end if;

  v_new_id := gen_random_uuid();
  insert into public.deliveries (
    id, client_id, product_catalog_id, customer_name, customer_phone, customer_phone_alt,
    customer_price, raw_address, location_id, assigned_agent_id,
    quantity_ordered, scheduled_date, created_via, parent_delivery_id,
    charged_snapshot, agent_payment_snapshot, current_status,
    created_by_user_id, bot_raw_message, text_fingerprint, rollover_count,
    rolled_from_status, rolled_from_date, delivery_instructions
  )
  values (
    v_new_id, v_old.client_id, v_old.product_catalog_id, v_old.customer_name, v_old.customer_phone, v_old.customer_phone_alt,
    v_old.customer_price, v_old.raw_address, v_old.location_id,
    null,                                          -- assigned_agent_id intentionally NULL
    v_old.quantity_ordered, v_new_date, 'rollover', v_old.id,
    v_charged, v_agent_payment, 'pending',
    v_actor, v_old.bot_raw_message, v_old.text_fingerprint, v_new_rollover_count,
    v_rolled_from_status, v_rolled_from_date, v_old.delivery_instructions
  );

  insert into public.delivery_status_history
    (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
  values
    (v_new_id, null, 'pending', v_actor, p_client_uuid, p_reason, now());

  perform public.change_delivery_status(
    p_client_uuid     := p_client_uuid || ':parent',
    p_delivery_id     := v_old.id,
    p_to_status       := 'rolled_over',
    p_reason          := p_reason,
    p_notes           := null,
    p_paid            := null,
    p_quantity_delivered := null,
    p_payment_method  := null,
    p_effective_at    := now()
  );

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := v_new_id,
    p_old         := jsonb_build_object(
      'parent_delivery_id', v_old.id,
      'old_scheduled_date', v_old.scheduled_date,
      'old_status', v_old.current_status,
      'old_charged_snapshot', v_old.charged_snapshot,
      'old_agent_payment_snapshot', v_old.agent_payment_snapshot,
      'old_rollover_count', v_old.rollover_count,
      'old_assigned_agent_id', v_old.assigned_agent_id
    ),
    p_new         := jsonb_build_object(
      'new_delivery_id', v_new_id,
      'new_scheduled_date', v_new_date,
      'charged_snapshot', v_charged,
      'agent_payment_snapshot', v_agent_payment,
      'new_rollover_count', v_new_rollover_count,
      'is_strike_rollover', v_is_strike,
      'new_assigned_agent_id', null,
      'rolled_from_status', v_rolled_from_status,
      'rolled_from_date', v_rolled_from_date
    ),
    p_reason      := p_reason
  );

  return v_new_id;
end;
$function$
