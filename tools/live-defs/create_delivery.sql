CREATE OR REPLACE FUNCTION public.create_delivery(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_created_via text DEFAULT 'manual'::text, p_bot_raw_message text DEFAULT NULL::text, p_customer_phone_alt text DEFAULT NULL::text)
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
  v_actor          uuid := auth.uid();
  v_fingerprint    text := public._text_fingerprint(p_bot_raw_message);
  v_phone_norm     text := public._norm_phone(p_customer_phone);
  v_original_date  date := p_scheduled_date;
  v_bumped         boolean := false;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;

  -- Idempotency: if we've already seen this client_uuid, return that delivery.
  select delivery_id into v_existing
    from public.delivery_status_history
   where client_uuid = p_client_uuid
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

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
  if not exists (
    select 1 from public.product_catalog
     where id = p_product_catalog_id and client_id = p_client_id and is_active = true
  ) then
    raise exception 'product is inactive or does not belong to client' using errcode = '23514';
  end if;

  -- Same-agent sibling guard — manual creates only. Keyed on the PRIMARY phone;
  -- the alternate intentionally does not participate in dedup.
  if p_created_via = 'manual'
     and p_assigned_agent_id is not null
     and v_phone_norm is not null
     and exists (
       select 1
         from public.deliveries d
         join public.delivery_status_defs sd on sd.status = d.current_status
        where d.assigned_agent_id          = p_assigned_agent_id
          and d.customer_phone_normalized  = v_phone_norm
          and d.product_catalog_id         = p_product_catalog_id
          and d.scheduled_date             = p_scheduled_date
          and d.deleted_at is null
          and sd.category <> 'terminal'
          and (
            (v_fingerprint is not null
             and d.text_fingerprint is not null
             and d.text_fingerprint = v_fingerprint)
            or
            ((v_fingerprint is null or d.text_fingerprint is null)
             and public._norm_address(d.raw_address) = public._norm_address(v_raw_address)
             and coalesce(d.quantity_ordered, 0) = coalesce(p_quantity_ordered, 0))
          )
     )
  then
    raise exception
      'agent % already has an open delivery matching this customer + product + date',
      p_assigned_agent_id
    using errcode = '23505',
          hint    = 'reassign to a different agent';
  end if;

  if p_location_id is not null then
    select er.charged, er.agent_payment
      into v_charged, v_agent_payment
      from public.effective_rate(p_location_id, p_client_id, null) er;
  end if;

  insert into public.deliveries (
    client_id, product_catalog_id, location_id,
    customer_name, customer_phone, customer_phone_alt, raw_address,
    quantity_ordered, customer_price,
    charged_snapshot, agent_payment_snapshot,
    scheduled_date, assigned_agent_id, created_by_user_id,
    current_status, created_via, bot_raw_message, text_fingerprint
  ) values (
    p_client_id, p_product_catalog_id, p_location_id,
    v_customer_name, v_customer_phone, v_customer_phone_alt, v_raw_address,
    p_quantity_ordered, p_customer_price,
    v_charged, v_agent_payment,
    p_scheduled_date, p_assigned_agent_id, v_actor,
    'pending', p_created_via, p_bot_raw_message, v_fingerprint
  ) returning id into v_delivery_id;

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status,
    changed_by_user_id, client_uuid, effective_at
  ) values (
    v_delivery_id, null, 'pending',
    v_actor, p_client_uuid, now()
  );

  perform public.write_audit(
    'delivery',
    v_delivery_id,
    null,
    jsonb_build_object(
      'client_id',                p_client_id,
      'product_catalog_id',       p_product_catalog_id,
      'location_id',              p_location_id,
      'customer_name',            v_customer_name,
      'customer_phone',           v_customer_phone,
      'customer_phone_alt',       v_customer_phone_alt,
      'raw_address',              v_raw_address,
      'quantity_ordered',         p_quantity_ordered,
      'customer_price',           p_customer_price,
      'charged_snapshot',         v_charged,
      'agent_payment_snapshot',   v_agent_payment,
      'assigned_agent_id',        p_assigned_agent_id,
      'scheduled_date',           p_scheduled_date,
      'created_via',              p_created_via,
      'current_status',           'pending',
      'text_fingerprint',         v_fingerprint,
      'auto_bumped_after_hours',  v_bumped,
      'original_scheduled_date',  case when v_bumped then v_original_date else null end
    ),
    null
  );

  return v_delivery_id;
end;
$function$

