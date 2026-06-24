-- client_rep — capture the CLIENT'S OWN sales rep / closer named at the END of a
-- forwarded WhatsApp order, so reconciliation follow-ups to the client can be
-- addressed to the person who placed the order. Optional; null on most orders.
--
-- The value is LLM-extracted in _shared/product-extract.ts (client_rep field) and
-- threaded through bot-parse-message → bot_create_delivery → create_delivery.
--
-- Adding a parameter changes a function's signature, so CREATE OR REPLACE would
-- spawn a SECOND overload instead of replacing. We DROP then CREATE, appending
-- p_client_rep at the END with DEFAULT NULL so every existing named/positional
-- caller (the app's manual create path included) is unaffected. Re-grant EXECUTE
-- after the drop. Run the whole file in one transaction.
-- Apply in the Supabase SQL editor.

begin;

-- 1. Column ----------------------------------------------------------------
alter table public.deliveries
  add column if not exists client_rep text;

comment on column public.deliveries.client_rep is
  'Client''s own sales rep / closer named at the end of the forwarded order (LLM-extracted at intake). Null when the message has no trailing rep name. Used at reconciliation.';

-- 2. create_delivery -------------------------------------------------------
drop function if exists public.create_delivery(
  text, uuid, uuid, text, text, text, integer, numeric, uuid, date, uuid, text, text, text, jsonb, text);

create function public.create_delivery(
  p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text,
  p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric,
  p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE,
  p_assigned_agent_id uuid DEFAULT NULL::uuid, p_created_via text DEFAULT 'manual'::text,
  p_bot_raw_message text DEFAULT NULL::text, p_customer_phone_alt text DEFAULT NULL::text,
  p_items jsonb DEFAULT NULL::jsonb, p_delivery_instructions text DEFAULT NULL::text,
  p_client_rep text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
declare
  v_existing       uuid;
  v_delivery_id    uuid;
  v_charged        numeric;
  v_agent_payment  numeric;
  v_customer_name  text := nullif(trim(p_customer_name), '');
  v_customer_phone text := nullif(trim(p_customer_phone), '');
  v_customer_phone_alt text := nullif(trim(p_customer_phone_alt), '');
  v_raw_address    text := nullif(trim(p_raw_address), '');
  v_delivery_instructions text := nullif(trim(p_delivery_instructions), '');
  v_client_rep     text := nullif(trim(p_client_rep), '');
  v_actor          uuid := auth.uid();
  v_fingerprint    text := public._text_fingerprint(p_bot_raw_message);
  v_phone_norm     text := public._norm_phone(p_customer_phone);
  v_original_date  date := p_scheduled_date;
  v_bumped         boolean := false;
  v_items          jsonb;
  v_items_fp       text;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;

  select delivery_id into v_existing
    from public.delivery_status_history where client_uuid = p_client_uuid limit 1;
  if v_existing is not null then return v_existing; end if;

  if v_customer_name  is null then raise exception 'customer_name required'  using errcode = '23514'; end if;
  if v_customer_phone is null then raise exception 'customer_phone required' using errcode = '23514'; end if;
  if v_raw_address    is null then raise exception 'raw_address required'    using errcode = '23514'; end if;
  if p_quantity_ordered is null or p_quantity_ordered <= 0 then
    raise exception 'quantity_ordered must be > 0' using errcode = '23514';
  end if;
  if p_customer_price is null or p_customer_price < 0 then
    raise exception 'customer_price must be >= 0' using errcode = '23514';
  end if;
  if p_created_via not in ('manual', 'bot') then
    raise exception 'invalid created_via' using errcode = '23514';
  end if;

  p_scheduled_date := public._effective_scheduled_date(p_scheduled_date, p_created_via);
  v_bumped := (p_scheduled_date is distinct from v_original_date);

  if not exists (select 1 from public.clients where id = p_client_id and is_active = true) then
    raise exception 'client is inactive or not found' using errcode = '23514';
  end if;

  v_items := coalesce(p_items, jsonb_build_array(jsonb_build_object(
    'product_catalog_id', p_product_catalog_id, 'quantity_ordered', p_quantity_ordered,
    'customer_price', p_customer_price)));

  if exists (
    select 1 from jsonb_array_elements(v_items) e
     where not exists (
       select 1 from public.product_catalog pc
        where pc.id = (e->>'product_catalog_id')::uuid
          and pc.client_id = p_client_id and pc.is_active = true)
  ) then
    raise exception 'a line item product is inactive or does not belong to client' using errcode = '23514';
  end if;

  v_items_fp := public._delivery_items_sig(v_items);   -- [Feature A] dedup identity

  -- Same-agent sibling guard — manual creates only, re-keyed to items_fingerprint.
  if p_created_via = 'manual'
     and p_assigned_agent_id is not null
     and v_phone_norm is not null
     and exists (
       select 1
         from public.deliveries d
         join public.delivery_status_defs sd on sd.status = d.current_status
        where d.assigned_agent_id          = p_assigned_agent_id
          and d.customer_phone_normalized  = v_phone_norm
          and d.items_fingerprint          = v_items_fp           -- [Feature A]
          and (d.scheduled_date = p_scheduled_date or d.current_status = 'postponed')
          and d.deleted_at is null
          and sd.category <> 'terminal'
          and (
            (v_fingerprint is not null and d.text_fingerprint is not null and d.text_fingerprint = v_fingerprint)
            or
            ((v_fingerprint is null or d.text_fingerprint is null)
             and public._norm_address(d.raw_address) = public._norm_address(v_raw_address))
          )
     )
  then
    raise exception 'agent % already has an open delivery matching this customer + items + date', p_assigned_agent_id
      using errcode = '23505', hint = 'reassign to a different agent';
  end if;

  if p_location_id is not null then
    select er.charged, er.agent_payment into v_charged, v_agent_payment
      from public.effective_rate(p_location_id, p_client_id, null) er;
  end if;

  insert into public.deliveries (
    client_id, product_catalog_id, location_id,
    customer_name, customer_phone, customer_phone_alt, raw_address,
    quantity_ordered, customer_price, charged_snapshot, agent_payment_snapshot,
    scheduled_date, assigned_agent_id, created_by_user_id,
    current_status, created_via, bot_raw_message, text_fingerprint,
    delivery_instructions, client_rep
  ) values (
    p_client_id, p_product_catalog_id, p_location_id,
    v_customer_name, v_customer_phone, v_customer_phone_alt, v_raw_address,
    p_quantity_ordered, p_customer_price, v_charged, v_agent_payment,
    p_scheduled_date, p_assigned_agent_id, v_actor,
    'pending', p_created_via, p_bot_raw_message, v_fingerprint,
    v_delivery_instructions, v_client_rep
  ) returning id into v_delivery_id;

  v_items_fp := public._apply_delivery_items(v_delivery_id, v_items);

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at
  ) values (v_delivery_id, null, 'pending', v_actor, p_client_uuid, now());

  perform public.write_audit(
    'delivery', v_delivery_id, null,
    jsonb_build_object(
      'client_id', p_client_id, 'product_catalog_id', p_product_catalog_id,
      'location_id', p_location_id, 'customer_name', v_customer_name,
      'customer_phone', v_customer_phone, 'customer_phone_alt', v_customer_phone_alt,
      'raw_address', v_raw_address, 'quantity_ordered', p_quantity_ordered,
      'customer_price', p_customer_price, 'charged_snapshot', v_charged,
      'agent_payment_snapshot', v_agent_payment, 'assigned_agent_id', p_assigned_agent_id,
      'scheduled_date', p_scheduled_date, 'created_via', p_created_via,
      'current_status', 'pending', 'text_fingerprint', v_fingerprint,
      'items', v_items, 'items_fingerprint', v_items_fp,
      'delivery_instructions', v_delivery_instructions,
      'client_rep', v_client_rep,
      'auto_bumped_after_hours', v_bumped,
      'original_scheduled_date', case when v_bumped then v_original_date else null end
    ), null);

  return v_delivery_id;
end;
$function$;

grant execute on function public.create_delivery(
  text, uuid, uuid, text, text, text, integer, numeric, uuid, date, uuid, text, text, text, jsonb, text, text)
  to anon, authenticated, service_role;

-- 3. bot_create_delivery ---------------------------------------------------
drop function if exists public.bot_create_delivery(
  text, uuid, uuid, text, text, text, integer, numeric, uuid, date, text, uuid, text, jsonb, text);

create function public.bot_create_delivery(
  p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text,
  p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric,
  p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE,
  p_bot_raw_message text DEFAULT NULL::text, p_assigned_agent_id uuid DEFAULT NULL::uuid,
  p_customer_phone_alt text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb,
  p_delivery_instructions text DEFAULT NULL::text, p_client_rep text DEFAULT NULL::text)
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
      update public.deliveries set assigned_agent_id = v_effective_agent_id, updated_at = now()
       where id = v_orphan_id;
      perform public.write_audit(
        p_actor_id := v_bot_user_id, p_entity_type := 'delivery', p_entity_id := v_orphan_id,
        p_old := jsonb_build_object('assigned_agent_id', null),
        p_new := jsonb_build_object('assigned_agent_id', v_effective_agent_id,
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
$function$;

grant execute on function public.bot_create_delivery(
  text, uuid, uuid, text, text, text, integer, numeric, uuid, date, text, uuid, text, jsonb, text, text)
  to anon, authenticated, service_role;

commit;
