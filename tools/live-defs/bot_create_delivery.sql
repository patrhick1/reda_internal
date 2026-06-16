CREATE OR REPLACE FUNCTION public.bot_create_delivery(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_bot_raw_message text DEFAULT NULL::text, p_assigned_agent_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_bot_user_id        uuid;
  v_delivery_id        uuid;
  v_fingerprint        text := public._text_fingerprint(p_bot_raw_message);
  v_phone_norm         text := public._norm_phone(p_customer_phone);
  v_effective_agent_id uuid := p_assigned_agent_id;
  v_orphan_id          uuid;
  v_existing_id        uuid;
  -- Match against the SAME date create_delivery will store after its bump,
  -- not the raw input — otherwise a re-forward across the midnight/after-hours
  -- boundary checks the wrong day and a same-agent duplicate slips through.
  v_eff_date           date := public._effective_scheduled_date(p_scheduled_date, 'bot');
begin
  select id into v_bot_user_id
    from public.users
   where email = 'bot@reda.dev' and is_active = true
   limit 1;
  if v_bot_user_id is null then
    select id into v_bot_user_id
      from public.users
     where role = 'admin' and is_active = true
     order by created_at
     limit 1;
  end if;
  if v_bot_user_id is null then
    raise exception 'no admin user available to act as bot';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_bot_user_id::text, 'role', 'authenticated')::text,
    true);

  -- Pre-empt same-agent dupe at intake. Predicate matches _find_sibling_
  -- deliveries: (Tier 1: fingerprint equal) OR (Tier 2: normalized address +
  -- qty equal), independent.
  --
  -- When the contractor's bot re-forwards an order to the same agent it
  -- already named, DO NOT create a new row and DO NOT reassign. Raise a
  -- structured P0001 so bot-parse-message can mark the inbound row as a
  -- duplicate of the existing delivery. Intentional multi-agent races
  -- (different agents named on different forwards) still work — this block
  -- only fires when the SAME agent is named twice.
  if v_effective_agent_id is not null and v_phone_norm is not null then
    select d.id into v_existing_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id          = v_effective_agent_id
       and d.customer_phone_normalized  = v_phone_norm
       and d.product_catalog_id         = p_product_catalog_id
       and d.scheduled_date             = v_eff_date
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null
          and d.text_fingerprint is not null
          and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address)
          and coalesce(d.quantity_ordered, 0) = coalesce(p_quantity_ordered, 0))
       )
     order by d.created_at asc
     limit 1;

    if v_existing_id is not null then
      raise exception 'duplicate forward: agent % already has open delivery % for customer % product % on %',
        v_effective_agent_id, v_existing_id, v_phone_norm, p_product_catalog_id, v_eff_date
        using errcode = 'P0001',
              hint    = jsonb_build_object(
                'kind',                 'duplicate_same_agent',
                'existing_delivery_id', v_existing_id,
                'agent_id',             v_effective_agent_id
              )::text;
    end if;
  end if;

  -- Smart-reassign of unassigned orphan. UNCHANGED from the prior version.
  -- An "orphan" here is a sibling row that was created without an agent
  -- (e.g. an earlier forward had no contractor agent hint or that agent
  -- didn't resolve). When the next forward DOES name an agent, absorb the
  -- orphan onto that agent rather than spawning another row.
  if v_phone_norm is not null then
    select d.id into v_orphan_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id is null
       and d.customer_phone_normalized  = v_phone_norm
       and d.product_catalog_id         = p_product_catalog_id
       and d.scheduled_date             = v_eff_date
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null
          and d.text_fingerprint is not null
          and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address)
          and coalesce(d.quantity_ordered, 0) = coalesce(p_quantity_ordered, 0))
       )
     order by d.created_at asc
     limit 1
     for update;

    if v_orphan_id is not null then
      update public.deliveries
         set assigned_agent_id = v_effective_agent_id,
             updated_at        = now()
       where id = v_orphan_id;

      perform public.write_audit(
        p_actor_id    := v_bot_user_id,
        p_entity_type := 'delivery',
        p_entity_id   := v_orphan_id,
        p_old         := jsonb_build_object('assigned_agent_id', null),
        p_new         := jsonb_build_object(
          'assigned_agent_id',       v_effective_agent_id,
          'triggering_bot_message',  p_bot_raw_message
        ),
        p_reason      := 'bot_smart_reassign: absorbed unassigned sibling'
      );

      return v_orphan_id;
    end if;
  end if;

  v_delivery_id := public.create_delivery(
    p_client_uuid        => p_client_uuid,
    p_client_id          => p_client_id,
    p_product_catalog_id => p_product_catalog_id,
    p_customer_name      => p_customer_name,
    p_customer_phone     => p_customer_phone,
    p_raw_address        => p_raw_address,
    p_quantity_ordered   => p_quantity_ordered,
    p_customer_price     => p_customer_price,
    p_location_id        => p_location_id,
    p_scheduled_date     => v_eff_date,
    p_assigned_agent_id  => v_effective_agent_id,
    p_created_via        => 'bot',
    p_bot_raw_message    => p_bot_raw_message
  );
  return v_delivery_id;
end;
$function$

