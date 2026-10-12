begin;

CREATE OR REPLACE FUNCTION public.bot_create_delivery_with_gifts(p_client_uuid text, p_client_id uuid, p_product_catalog_id uuid, p_customer_name text, p_customer_phone text, p_raw_address text, p_quantity_ordered integer, p_customer_price numeric, p_location_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_bot_raw_message text DEFAULT NULL::text, p_assigned_agent_id uuid DEFAULT NULL::uuid, p_customer_phone_alt text DEFAULT NULL::text, p_items jsonb DEFAULT NULL::jsonb, p_delivery_instructions text DEFAULT NULL::text, p_client_rep text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$

declare
 v_existing uuid;
 v_date date:=public._effective_scheduled_date(p_scheduled_date,'bot');
 v_phone text:=public._norm_phone(p_customer_phone);
begin
 if p_client_id is distinct from '2740824b-4f65-4901-abd5-6635aec0f044'::uuid or p_items is null then
  raise exception 'Gift intake policy requires the approved vendor and resolved items' using errcode='22023';
 end if;
 -- All newly automatic gift orders for this vendor/phone serialize, even when
 -- the assigned rider or item extraction differs. No production replay here.
 perform pg_advisory_xact_lock(hashtextextended('gift-intake:'||p_client_id::text||':'||coalesce(v_phone,''),0));
 -- Keep the existing create_delivery idempotency contract on exact retry.
 select delivery_id into v_existing from public.delivery_status_history where client_uuid=p_client_uuid;
 if v_existing is not null then return v_existing; end if;
 if v_phone is not null then
  select d.id into v_existing from public.deliveries d
  where d.client_id=p_client_id and d.customer_phone_normalized=v_phone and d.deleted_at is null
   and (d.scheduled_date=v_date or d.current_status='postponed')
   and (public._norm_address(d.raw_address)=public._norm_address(p_raw_address)
     or (d.text_fingerprint is not null and d.text_fingerprint=public._text_fingerprint(p_bot_raw_message)))
  order by d.created_at,d.id limit 1;
  if v_existing is not null then
   raise exception 'Check the existing order before creating a gift bundle'
    using errcode='P0001',hint=jsonb_build_object('kind','gift_duplicate_review','existing_delivery_id',v_existing)::text;
  end if;
 end if;
 return public.bot_create_delivery(
  p_client_uuid => p_client_uuid,
  p_client_id => p_client_id,
  p_product_catalog_id => p_product_catalog_id,
  p_customer_name => p_customer_name,
  p_customer_phone => p_customer_phone,
  p_raw_address => p_raw_address,
  p_quantity_ordered => p_quantity_ordered,
  p_customer_price => p_customer_price,
  p_location_id => p_location_id,
  p_scheduled_date => p_scheduled_date,
  p_bot_raw_message => p_bot_raw_message,
  p_assigned_agent_id => p_assigned_agent_id,
  p_customer_phone_alt => p_customer_phone_alt,
  p_items => p_items,
  p_delivery_instructions => p_delivery_instructions,
  p_client_rep => p_client_rep);
end;
$function$;

revoke all on function public.bot_create_delivery_with_gifts(text,uuid,uuid,text,text,text,integer,numeric,uuid,date,text,uuid,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.bot_create_delivery_with_gifts(text,uuid,uuid,text,text,text,integer,numeric,uuid,date,text,uuid,text,jsonb,text,text) to service_role;
notify pgrst,'reload schema';
commit;
