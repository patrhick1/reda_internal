BEGIN;
ALTER TABLE public.delivery_status_history ADD COLUMN previous_scheduled_date date;
ALTER TABLE public.delivery_status_history ADD COLUMN new_scheduled_date date;

-- Preserve the deployed status/stock/payment implementation. Assert the exact
-- extension points rather than silently replace a newer financial function.
DO $$ DECLARE def text; original text; BEGIN
 SELECT pg_get_functiondef('public.change_delivery_status(text,uuid,text,text,text,integer,numeric,text,timestamptz,date,jsonb)'::regprocedure) INTO def;
 original:=def;
 def:=replace(def,'if p_to_status = ''postponed'' and p_new_scheduled_date is not null then',
  'if p_to_status = ''postponed'' then
    if p_new_scheduled_date is null then raise exception ''A future date is required when postponing'' using errcode=''23514''; end if;');
 def:=replace(def,'p_new_scheduled_date <= current_date','p_new_scheduled_date <= (now() at time zone ''Africa/Lagos'')::date');
 def:=replace(def,'p_new_scheduled_date, current_date','p_new_scheduled_date, (now() at time zone ''Africa/Lagos'')::date');
 def:=replace(def,'if v_delivery.current_status = p_to_status then return; end if;',
  'if v_delivery.current_status = p_to_status then
     if p_to_status=''postponed'' then raise exception ''Use the reschedule action to change the promised date'' using errcode=''23514''; end if;
     return; end if;');
 def:=replace(def,'reason, notes, reported_occurred_at','reason, notes, reported_occurred_at, previous_scheduled_date, new_scheduled_date');
 def:=replace(def,'v_effective, p_reason, p_notes, p_effective_at','v_effective, p_reason, p_notes, p_effective_at, v_delivery.scheduled_date, v_final_date');
 IF def=original OR def NOT LIKE '%A future date is required%' OR def NOT LIKE '%v_delivery.scheduled_date, v_final_date%' OR def NOT LIKE '%Use the reschedule action%' THEN
  RAISE EXCEPTION 'Unexpected change_delivery_status definition; inspect before applying'; END IF;
 EXECUTE def;
END $$;

CREATE FUNCTION public.postpone_delivery(p_client_uuid text,p_delivery_id uuid,p_date date,
 p_expected_updated_at timestamptz,p_expected_status text,p_expected_date date,p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
DECLARE d public.deliveries%rowtype; v_date date; v_event public.delivery_status_history%rowtype;
BEGIN
 PERFORM public._same_customer_lock_orders(ARRAY[p_delivery_id],'{}');
 SELECT * INTO d FROM public.deliveries WHERE id=p_delivery_id FOR UPDATE;
 IF NOT FOUND OR d.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Order no longer available' USING ERRCODE='23514'; END IF;
 IF (public.is_admin_or_dispatcher() OR (public.current_user_role()='agent' AND d.assigned_agent_id=auth.uid())) IS NOT TRUE THEN
  RAISE EXCEPTION 'You are no longer assigned to this order. Refresh to see its current state.' USING ERRCODE='42501'; END IF;
 IF nullif(btrim(p_client_uuid),'') IS NULL THEN RAISE EXCEPTION 'Request ID required' USING ERRCODE='23514'; END IF;
 SELECT * INTO v_event FROM public.delivery_status_history WHERE client_uuid=p_client_uuid;
 IF FOUND THEN
  IF v_event.delivery_id<>p_delivery_id OR v_event.to_status<>'postponed' OR v_event.new_scheduled_date IS DISTINCT FROM public._ensure_workday(p_date) THEN
   RAISE EXCEPTION 'Request ID already used for a different operation' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 IF p_expected_updated_at IS NULL OR d.updated_at IS DISTINCT FROM p_expected_updated_at OR d.current_status IS DISTINCT FROM p_expected_status
   OR d.scheduled_date IS DISTINCT FROM p_expected_date THEN
  RAISE EXCEPTION 'This order changed after you opened it. Refresh and choose its new date again.' USING ERRCODE='23514'; END IF;
 IF p_date IS NULL OR p_date<=(now() AT TIME ZONE 'Africa/Lagos')::date THEN
  RAISE EXCEPTION 'Choose a date after today in Lagos' USING ERRCODE='23514'; END IF;
 v_date:=public._ensure_workday(p_date);
 IF d.current_status<>'postponed' THEN
  PERFORM public.change_delivery_status(p_client_uuid,p_delivery_id,'postponed',p_reason,
    p_new_scheduled_date=>v_date);
 ELSE
  INSERT INTO public.delivery_status_history(delivery_id,from_status,to_status,changed_by_user_id,client_uuid,reason,
   effective_at,previous_scheduled_date,new_scheduled_date)
  VALUES(d.id,'postponed','postponed',auth.uid(),p_client_uuid,coalesce(nullif(btrim(p_reason),''),'Customer postponed'),now(),d.scheduled_date,v_date);
  UPDATE public.deliveries SET scheduled_date=v_date,updated_at=clock_timestamp() WHERE id=d.id;
  PERFORM public.write_audit('delivery',d.id,jsonb_build_object('scheduled_date',d.scheduled_date),
   jsonb_build_object('scheduled_date',v_date),'postponement_rescheduled',auth.uid());
 END IF;
END $$;

CREATE FUNCTION public.list_delivery_history_chain_v2(p_delivery_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,auth AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(h)||jsonb_build_object('postponed_to',e.new_scheduled_date,
   'previous_scheduled_date',e.previous_scheduled_date) ORDER BY h.chain_depth DESC,h.changed_at,h.id),'[]')
 FROM public.list_delivery_history_chain(p_delivery_id) h JOIN public.delivery_status_history e ON e.id=h.id
$$;
REVOKE ALL ON FUNCTION public.postpone_delivery(text,uuid,date,timestamptz,text,date,text),public.list_delivery_history_chain_v2(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.postpone_delivery(text,uuid,date,timestamptz,text,date,text),public.list_delivery_history_chain_v2(uuid) TO authenticated;
COMMIT;
