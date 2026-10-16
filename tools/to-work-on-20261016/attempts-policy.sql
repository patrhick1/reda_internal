\set ON_ERROR_STOP on
\ir ../eod-reliability-20260921/fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;

DO $$ DECLARE
 v_policy boolean; v_count int; v_status text; v_id uuid; v_child uuid;
 v_expected text; v_actual text; v_tag text; v_day date:=reda_maintenance.business_day();
BEGIN
 PERFORM pg_temp.assert(NOT has_function_privilege('anon','public._rollover_is_strike(text)','execute'),'helper remains private');
 FOREACH v_policy IN ARRAY ARRAY[false,true] LOOP
  UPDATE clients SET auto_cancel_soft_fails=v_policy WHERE id=md5('eod-test-client')::uuid;
  FOR v_count IN 0..1 LOOP
   FOREACH v_status IN ARRAY ARRAY['pending','tomorrow','will_call_back','available','available_evening','no_product',
    'not_answering','not_connecting','number_busy','switched_off','not_around','not_available','follow_up','postponed','picked_up','waybilled'] LOOP
    v_tag:=v_policy::text||'-'||v_count||'-'||v_status;
    v_id:=md5('attempt-policy-'||v_tag)::uuid;
    INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
     quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,current_status,rollover_count,created_by_user_id)
    SELECT v_id,client_id,product_catalog_id,'TEST '||v_tag,'08011112222','TEST '||v_tag,
     1,10000,3000,4000,v_day,v_status,v_count,created_by_user_id FROM deliveries WHERE id=md5('eod-test-order-2')::uuid;
    v_expected:=CASE
     WHEN v_status IN ('not_around','picked_up','waybilled') OR (v_status='postponed' AND NOT v_policy) THEN NULL
     WHEN v_status IN ('not_around','not_available') THEN 'close_disinterest'
     WHEN v_status IN ('not_answering','not_connecting','number_busy','switched_off','tomorrow','postponed') AND v_policy THEN 'close_policy'
     WHEN v_status='follow_up' THEN 'close_followup'
     WHEN v_status IN ('not_answering','not_connecting','number_busy','switched_off') AND v_count=1 THEN 'cap_unserious'
     ELSE 'roll' END;
    SELECT action INTO v_actual FROM reda_maintenance.classify(v_day,ARRAY[v_id]);
    PERFORM pg_temp.assert(v_actual IS NOT DISTINCT FROM v_expected,'classification '||v_tag||': expected '||coalesce(v_expected,'excluded')||', got '||coalesce(v_actual,'excluded'));
    -- Exercise the actual rollover function for all four retryable failures.
    IF NOT v_policy AND v_status IN ('not_answering','not_connecting','number_busy','switched_off') THEN
     v_child:=public.rollover_delivery('attempt-policy-'||v_tag,v_id,v_day+1,'attempt policy test',false);
     IF v_count=0 THEN
      PERFORM pg_temp.assert((SELECT rollover_count=1 AND current_status='pending' FROM deliveries WHERE id=v_child),'first failure rolls: '||v_status);
     ELSE
      PERFORM pg_temp.assert(v_child IS NULL AND (SELECT current_status='unserious' FROM deliveries WHERE id=v_id),'second failure closes: '||v_status);
     END IF;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 RAISE NOTICE 'PASS: 64 status/count/client-policy combinations and four retryable failure lifecycles';
END $$;
ROLLBACK;
