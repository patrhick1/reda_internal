-- Link replacements to existing deliveries; trailing default preserves older app calls.
begin;
drop function public.create_replacement(text, uuid, text, text, text, text, uuid, date, uuid, jsonb, jsonb, text, text, numeric, numeric);
create or replace function public.create_replacement(
  p_client_uuid text,
  p_client_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_phone_alt text,
  p_raw_address text,
  p_location_id uuid,
  p_scheduled_date date,
  p_assigned_agent_id uuid,
  p_outbound_items jsonb,
  p_return_items jsonb,
  p_reason text,
  p_notes text default null,
  p_success_client_charge numeric default 0,
  p_success_agent_payment numeric default 0,
  p_original_delivery_id uuid default null
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing uuid;
  v_delivery_id uuid;
  v_first_product uuid;
  v_total integer;
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_instruction text;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if p_original_delivery_id is not null and not exists (
    select 1 from public.deliveries where id = p_original_delivery_id
      and deleted_at is null and order_type = 'delivery' and client_id = p_client_id
  ) then
    raise exception 'Original delivery must exist and belong to the same client' using errcode = '22023';
  end if;
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  select delivery_id into v_existing
    from public.delivery_status_history where client_uuid = p_client_uuid limit 1;
  if v_existing is not null then return v_existing; end if;

  if nullif(trim(p_customer_name), '') is null
     or nullif(trim(p_customer_phone), '') is null
     or nullif(trim(p_raw_address), '') is null then
    raise exception 'customer name, phone and address are required' using errcode = '23514';
  end if;
  if p_location_id is null then
    raise exception 'location required' using errcode = '23514';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'replacement reason required' using errcode = '23514';
  end if;
  if coalesce(p_success_client_charge, -1) < 0 or coalesce(p_success_agent_payment, -1) < 0 then
    raise exception 'charges must be >= 0' using errcode = '23514';
  end if;
  if jsonb_typeof(p_outbound_items) <> 'array' or jsonb_array_length(p_outbound_items) = 0 then
    raise exception 'at least one outbound item is required' using errcode = '23514';
  end if;
  if jsonb_typeof(p_return_items) <> 'array' or jsonb_array_length(p_return_items) = 0 then
    raise exception 'at least one expected return item is required' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_outbound_items) item
     group by item->>'product_catalog_id' having count(*) > 1
  ) then
    raise exception 'combine duplicate outbound products into one quantity'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_return_items) item
     group by item->>'product_catalog_id' having count(*) > 1
  ) then
    raise exception 'combine duplicate returned products into one quantity'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id and is_active) then
    raise exception 'client is inactive or not found' using errcode = '23514';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'location not found' using errcode = '23514';
  end if;
  if p_assigned_agent_id is not null and not exists (
    select 1 from public.users where id = p_assigned_agent_id and role = 'agent' and is_active
  ) then
    raise exception 'assigned agent is inactive or invalid' using errcode = '23514';
  end if;

  v_total := 0;
  for v_item in select value from jsonb_array_elements(p_outbound_items)
  loop
    v_product := nullif(v_item->>'product_catalog_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::integer;
    if v_product is null or coalesce(v_qty, 0) <= 0 then
      raise exception 'every outbound item needs a product and positive quantity' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.product_catalog
       where id = v_product and client_id = p_client_id and is_active
    ) then
      raise exception 'outbound product does not belong to this client' using errcode = '23514';
    end if;
    v_first_product := coalesce(v_first_product, v_product);
    v_total := v_total + v_qty;
  end loop;

  insert into public.deliveries(
    client_id, product_catalog_id, location_id,
    customer_name, customer_phone, customer_phone_alt, raw_address,
    quantity_ordered, customer_price, charged_snapshot, agent_payment_snapshot,
    scheduled_date, assigned_agent_id, created_by_user_id,
    current_status, created_via, order_type, delivery_instructions
  ) values (
    p_client_id, v_first_product, p_location_id,
    trim(p_customer_name), trim(p_customer_phone), nullif(trim(p_customer_phone_alt), ''),
    trim(p_raw_address), v_total, 0, 0, 0,
    coalesce(p_scheduled_date, (now() at time zone 'Africa/Lagos')::date),
    p_assigned_agent_id, v_actor, 'pending', 'manual', 'replacement', nullif(trim(p_notes), '')
  ) returning id into v_delivery_id;

  for v_item in select value from jsonb_array_elements(p_outbound_items)
  loop
    insert into public.delivery_items(delivery_id, product_catalog_id, quantity_ordered, customer_price)
    values (
      v_delivery_id,
      (v_item->>'product_catalog_id')::uuid,
      (v_item->>'quantity')::integer,
      0
    );
  end loop;

  insert into public.replacement_jobs(
    delivery_id, original_delivery_id, reason, notes,
    success_client_charge, success_agent_payment, created_by_user_id
  ) values (
    v_delivery_id, p_original_delivery_id, trim(p_reason), nullif(trim(p_notes), ''),
    p_success_client_charge, p_success_agent_payment, v_actor
  );

  for v_item in select value from jsonb_array_elements(p_return_items)
  loop
    v_product := nullif(v_item->>'product_catalog_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::integer;
    v_instruction := coalesce(nullif(v_item->>'vendor_instruction', ''), 'ask_if_damaged');
    if v_product is null or coalesce(v_qty, 0) <= 0 then
      raise exception 'every return item needs a product and positive quantity' using errcode = '23514';
    end if;
    if v_instruction not in ('ask_if_damaged', 'collect_and_hold', 'do_not_collect_damaged') then
      raise exception 'invalid vendor instruction' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.product_catalog
       where id = v_product and client_id = p_client_id and is_active
    ) then
      raise exception 'return product does not belong to this client' using errcode = '23514';
    end if;
    insert into public.replacement_return_items(
      delivery_id, product_catalog_id, quantity_expected, vendor_instruction
    ) values (v_delivery_id, v_product, v_qty, v_instruction);
  end loop;

  insert into public.delivery_status_history(
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at, reason
  ) values (v_delivery_id, null, 'pending', v_actor, p_client_uuid, now(), 'replacement_created');

  perform public.write_audit(
    'delivery', v_delivery_id, null,
    jsonb_build_object(
      'order_type', 'replacement',
      'client_id', p_client_id,
      'outbound_items', p_outbound_items,
      'return_items', p_return_items,
      'reason', trim(p_reason),
      'success_client_charge', p_success_client_charge,
      'success_agent_payment', p_success_agent_payment,
      'assigned_agent_id', p_assigned_agent_id
    ), null
  );
  return v_delivery_id;
end;
$function$;

revoke all on function public.create_replacement(text, uuid, text, text, text, text, uuid, date, uuid, jsonb, jsonb, text, text, numeric, numeric, uuid) from public, anon;
grant execute on function public.create_replacement(text, uuid, text, text, text, text, uuid, date, uuid, jsonb, jsonb, text, text, numeric, numeric, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
