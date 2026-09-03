-- bot_create_delivery as live on the box after the customer blacklist change (2026-09-03).
-- Diff vs the pre-change capture (commit cfcb15e) is the blacklist assert only;
-- see supabase/migrations/20260903231500_customer_blacklist.sql.

CREATE OR REPLACE FUNCTION public.bot_create_delivery(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_bot_raw_message text DEFAULT NULL::text, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_customer_phone_alt text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_delivery_instructions text DEFAULT NULL::text, p_client_rep text DEFAULT NULL::text)
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
  v_eff_date           date := public._effective_scheduled_date(p_scheduled_date, 'bot');
  v_client_rep         text := nullif(trim(p_client_rep), '');
  v_items_fp           text := public._delivery_items_sig(coalesce(p_items, jsonb_build_array(
                          jsonb_build_object('product_catalog_id', p_product_catalog_id,
                                             'quantity_ordered', p_quantity_ordered))));  -- [Feature A]
begin
  select id into v_bot_user_id from public.users
   where email = 'bot@reda.dev' and is_active = true limit 1;
  if v_bot_user_id is null then
    select id into v_bot_user_id from public.users
     where role = 'admin' and is_active = true order by created_at limit 1;
  end if;
  if v_bot_user_id is null then raise exception 'no admin user available to act as bot'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_bot_user_id::text, 'role', 'authenticated')::text, true);

  -- Customer blacklist: refuse before the duplicate/orphan logic can dispatch.
  perform public._assert_customer_not_blacklisted(p_customer_phone, p_customer_phone_alt);

  -- Pre-empt same-agent dupe at intake — re-keyed to items_fingerprint.
  if v_effective_agent_id is not null and v_phone_norm is not null then
    select d.id into v_existing_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id = v_effective_agent_id
       and d.customer_phone_normalized = v_phone_norm
       and d.items_fingerprint = v_items_fp            -- [Feature A]
       and (d.scheduled_date = v_eff_date or d.current_status = 'postponed')
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address))
       )
     order by d.created_at asc limit 1;

    if v_existing_id is not null then
      raise exception 'duplicate forward: agent % already has open delivery % for customer % items % on %',
        v_effective_agent_id, v_existing_id, v_phone_norm, v_items_fp, v_eff_date
        using errcode = 'P0001',
              hint = jsonb_build_object('kind','duplicate_same_agent',
                'existing_delivery_id', v_existing_id, 'agent_id', v_effective_agent_id)::text;
    end if;
  end if;

  -- Smart-reassign of unassigned orphan — re-keyed to items_fingerprint.
  if v_phone_norm is not null then
    select d.id into v_orphan_id
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
     where d.assigned_agent_id is null
       and d.customer_phone_normalized = v_phone_norm
       and d.items_fingerprint = v_items_fp            -- [Feature A]
       and d.scheduled_date = v_eff_date
       and d.deleted_at is null
       and sd.category <> 'terminal'
       and (
         (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
         or
         (public._norm_address(d.raw_address) = public._norm_address(p_raw_address))
       )
     order by d.created_at asc limit 1 for update;

    if v_orphan_id is not null then
      -- Absorb the orphan: attach the agent, and backfill the rep from THIS
      -- forward only if the orphan doesn't already carry one (never overwrite an
      -- existing value). The rep may only appear on the second forward.
      update public.deliveries
         set assigned_agent_id = v_effective_agent_id,
             client_rep        = coalesce(client_rep, v_client_rep),
             updated_at        = now()
       where id = v_orphan_id;
      perform public.write_audit(
        p_actor_id := v_bot_user_id, p_entity_type := 'delivery', p_entity_id := v_orphan_id,
        p_old := jsonb_build_object('assigned_agent_id', null),
        p_new := jsonb_build_object('assigned_agent_id', v_effective_agent_id,
          'client_rep', v_client_rep,
          'triggering_bot_message', p_bot_raw_message),
        p_reason := 'bot_smart_reassign: absorbed unassigned sibling');
      return v_orphan_id;
    end if;
  end if;

  v_delivery_id := public.create_delivery(
    p_client_uuid => p_client_uuid, p_client_id => p_client_id,
    p_product_catalog_id => p_product_catalog_id, p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone, p_raw_address => p_raw_address,
    p_quantity_ordered => p_quantity_ordered, p_customer_price => p_customer_price,
    p_location_id => p_location_id, p_scheduled_date => v_eff_date,
    p_assigned_agent_id => v_effective_agent_id, p_created_via => 'bot',
    p_bot_raw_message => p_bot_raw_message, p_customer_phone_alt => p_customer_phone_alt,
    p_items => p_items, p_delivery_instructions => p_delivery_instructions,
    p_client_rep => p_client_rep
  );
  return v_delivery_id;
end;
$function$

