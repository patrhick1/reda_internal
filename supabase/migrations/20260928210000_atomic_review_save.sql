BEGIN;

-- Keep the legacy link API for installed clients, but never allow a late save
-- to replace a completed link. All review mutations lock source then edit-lock.
CREATE OR REPLACE FUNCTION public.resolve_inbound_to_delivery(p_inbound_id uuid,p_delivery_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth
SET lock_timeout='2s' SET statement_timeout='20s' AS $$
DECLARE v_source public.bot_inbound_messages%rowtype; v_text text;
BEGIN
 IF public.is_manager() IS NOT TRUE THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_source FROM public.bot_inbound_messages WHERE id=p_inbound_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found' USING ERRCODE='P0002'; END IF;
 IF v_source.status='created_delivery' AND v_source.delivery_id=p_delivery_id THEN RETURN; END IF;
 IF v_source.status<>'needs_review' OR v_source.delivery_id IS NOT NULL THEN
  RAISE EXCEPTION 'This review item has already been handled. Reopen Review to check it.' USING ERRCODE='PT409';
 END IF;
 PERFORM 1 FROM public.edit_locks WHERE entity_type='bot_inbound' AND entity_id=p_inbound_id FOR UPDATE;
 PERFORM public._assert_holds_lock('bot_inbound',p_inbound_id);
 IF NOT EXISTS(SELECT 1 FROM public.deliveries WHERE id=p_delivery_id AND deleted_at IS NULL) THEN
  RAISE EXCEPTION 'Delivery not found' USING ERRCODE='P0002';
 END IF;
 v_text:=v_source.raw_text;
 UPDATE public.bot_inbound_messages SET status='created_delivery',delivery_id=p_delivery_id,processed_at=now() WHERE id=p_inbound_id;
 IF v_text IS NOT NULL THEN
  UPDATE public.deliveries SET bot_raw_message=v_text,text_fingerprint=coalesce(text_fingerprint,public._text_fingerprint(v_text))
   WHERE id=p_delivery_id AND bot_raw_message IS NULL;
  IF FOUND THEN
   PERFORM public.write_audit('delivery',p_delivery_id,jsonb_build_object('bot_raw_message',NULL),
    jsonb_build_object('bot_raw_message',v_text),'review fix: WhatsApp message retained on the delivery',auth.uid());
  END IF;
 END IF;
 DELETE FROM public.edit_locks WHERE entity_type='bot_inbound' AND entity_id=p_inbound_id;
END $$;

-- A stale discard must not undo an order saved on another device.
CREATE OR REPLACE FUNCTION public.discard_inbound(p_inbound_id uuid,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth
SET lock_timeout='2s' SET statement_timeout='20s' AS $$
DECLARE v_source public.bot_inbound_messages%rowtype;
BEGIN
 IF public.is_manager() IS NOT TRUE THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_source FROM public.bot_inbound_messages WHERE id=p_inbound_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found' USING ERRCODE='P0002'; END IF;
 IF v_source.status<>'needs_review' OR v_source.delivery_id IS NOT NULL THEN
  RAISE EXCEPTION 'This review item has already been handled. Reopen Review to check it.' USING ERRCODE='PT409';
 END IF;
 PERFORM 1 FROM public.edit_locks WHERE entity_type='bot_inbound' AND entity_id=p_inbound_id FOR UPDATE;
 PERFORM public._assert_holds_lock('bot_inbound',p_inbound_id);
 UPDATE public.bot_inbound_messages SET status='error',error_text='discarded: '||coalesce(nullif(trim(p_reason),''),'no reason given'),processed_at=now()
  WHERE id=p_inbound_id;
 DELETE FROM public.edit_locks WHERE entity_type='bot_inbound' AND entity_id=p_inbound_id;
END $$;

CREATE FUNCTION public.create_delivery_from_review(
 p_inbound_id uuid,p_client_id uuid,p_product_catalog_id uuid,p_customer_name text,p_customer_phone text,
 p_raw_address text,p_quantity_ordered integer,p_customer_price numeric,
 p_location_id uuid DEFAULT NULL,p_scheduled_date date DEFAULT CURRENT_DATE,p_assigned_agent_id uuid DEFAULT NULL,
 p_customer_phone_alt text DEFAULT NULL,p_items jsonb DEFAULT NULL,p_delivery_instructions text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,auth
SET lock_timeout='2s' SET statement_timeout='20s' AS $$
DECLARE v_source public.bot_inbound_messages%rowtype; v_delivery uuid; v_key text;
BEGIN
 IF public.is_manager() IS NOT TRUE THEN RAISE EXCEPTION 'permission denied' USING ERRCODE='42501'; END IF;
 -- Serialize this source only. A second device/retry sees the committed result
 -- after the first save, including when the first HTTP response was lost.
 SELECT * INTO v_source FROM public.bot_inbound_messages WHERE id=p_inbound_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review item not found' USING ERRCODE='P0002'; END IF;
 IF v_source.status='created_delivery' AND v_source.delivery_id IS NOT NULL THEN RETURN v_source.delivery_id; END IF;
 IF v_source.status<>'needs_review' OR v_source.delivery_id IS NOT NULL THEN
  RAISE EXCEPTION 'This review item has already been handled. Reopen Review to check it.' USING ERRCODE='PT409';
 END IF;
 PERFORM 1 FROM public.edit_locks WHERE entity_type='bot_inbound' AND entity_id=p_inbound_id FOR UPDATE;
 PERFORM public._assert_holds_lock('bot_inbound',p_inbound_id);
 v_key:='review-save-v1:'||p_inbound_id;
 -- Never adopt a caller-created delivery that used our reserved key. A valid
 -- atomic save cannot leave a history key behind without its source link.
 IF EXISTS(SELECT 1 FROM public.delivery_status_history WHERE client_uuid=v_key) THEN
  RAISE EXCEPTION 'This review item needs checking before it can be saved.' USING ERRCODE='PT409';
 END IF;
 v_delivery:=public.create_delivery(p_client_uuid=>v_key,p_client_id=>p_client_id,p_product_catalog_id=>p_product_catalog_id,
  p_customer_name=>p_customer_name,p_customer_phone=>p_customer_phone,p_raw_address=>p_raw_address,
  p_quantity_ordered=>p_quantity_ordered,p_customer_price=>p_customer_price,p_location_id=>p_location_id,
  p_scheduled_date=>p_scheduled_date,p_assigned_agent_id=>p_assigned_agent_id,p_created_via=>'manual',
  p_bot_raw_message=>v_source.raw_text,p_customer_phone_alt=>p_customer_phone_alt,p_items=>p_items,
  p_delivery_instructions=>p_delivery_instructions);
 PERFORM public.resolve_inbound_to_delivery(p_inbound_id,v_delivery);
 RETURN v_delivery;
END $$;
REVOKE ALL ON FUNCTION public.create_delivery_from_review(uuid,uuid,uuid,text,text,text,integer,numeric,uuid,date,uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_delivery_from_review(uuid,uuid,uuid,text,text,text,integer,numeric,uuid,date,uuid,text,jsonb,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
