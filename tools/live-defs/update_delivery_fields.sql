CREATE OR REPLACE FUNCTION public.update_delivery_fields(p_delivery_id uuid, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_raw_address text DEFAULT NULL::text, p_location_id uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_product_catalog_id uuid DEFAULT NULL::uuid, p_quantity_ordered integer DEFAULT NULL::integer, p_customer_price numeric DEFAULT NULL::numeric, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_customer_phone_alt text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_old            public.deliveries%rowtype;
  v_old_jsonb      jsonb;
  v_new_jsonb      jsonb;
  v_eff_location   uuid;
  v_eff_client     uuid;
  v_eff_agent      uuid;
  v_rate_changed   boolean;
  v_charged        numeric;
  v_agent_payment  numeric;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  perform public._assert_holds_lock('delivery', p_delivery_id);

  select * into v_old
    from public.deliveries
   where id = p_delivery_id
   for update;
  if not found then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  v_old_jsonb := to_jsonb(v_old);

  if v_old.current_status not in (
    'pending','available','available_evening',
    'not_answering','number_busy','switched_off','tomorrow','postponed','follow_up',
    'not_connecting','not_around','will_call_back','not_available'
  ) then
    raise exception 'delivery is locked (status=%); only pre-delivery rows can be edited',
      v_old.current_status
      using errcode = '22023';
  end if;

  v_eff_location := coalesce(p_location_id,       v_old.location_id);
  v_eff_client   := coalesce(p_client_id,         v_old.client_id);
  v_eff_agent    := coalesce(p_assigned_agent_id, v_old.assigned_agent_id);

  v_rate_changed :=
       (v_eff_location is distinct from v_old.location_id)
    or (v_eff_client   is distinct from v_old.client_id)
    or (v_eff_agent    is distinct from v_old.assigned_agent_id);

  if v_rate_changed then
    select er.charged, er.agent_payment
      into v_charged, v_agent_payment
      from public.effective_rate(v_eff_location, v_eff_client, v_eff_agent) er;
    if v_charged is null then
      raise exception 'no active rate card for (location=%, client=%); cannot recompute snapshots',
        v_eff_location, v_eff_client
        using errcode = '22023',
              hint   = 'add a rate_card row for this location/client before editing';
    end if;
  end if;

  update public.deliveries set
    customer_name      = coalesce(p_customer_name,      customer_name),
    customer_phone     = coalesce(p_customer_phone,     customer_phone),
    customer_phone_alt = case when p_customer_phone_alt is null then customer_phone_alt
                              when p_customer_phone_alt = ''   then null
                              else p_customer_phone_alt end,
    raw_address        = coalesce(p_raw_address,        raw_address),
    location_id        = v_eff_location,
    client_id          = v_eff_client,
    product_catalog_id = coalesce(p_product_catalog_id, product_catalog_id),
    quantity_ordered   = coalesce(p_quantity_ordered,   quantity_ordered),
    customer_price     = coalesce(p_customer_price,     customer_price),
    charged_snapshot   = case when v_rate_changed
                              then v_charged
                              else charged_snapshot end,
    agent_payment_snapshot = case when v_rate_changed
                                  then v_agent_payment
                                  else agent_payment_snapshot end,
    assigned_agent_id  = v_eff_agent,
    updated_at         = now()
   where id = p_delivery_id;

  select to_jsonb(d) into v_new_jsonb from public.deliveries d where id = p_delivery_id;
  perform public.write_audit(
    'delivery', p_delivery_id, v_old_jsonb, v_new_jsonb,
    case when v_rate_changed then 'update_fields:rate_resnapshot' else 'update_fields' end,
    null
  );
end $function$

