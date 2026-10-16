\set ON_ERROR_STOP on
\ir ../eod-reliability-20260921/fixture.sql
CREATE FUNCTION pg_temp.assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',message; END IF; END $$;

DO $$ DECLARE parent uuid:=md5('eod-test-order-2')::uuid; child uuid; first_child uuid;
 v_status text; count_before int; day date:=reda_maintenance.business_day(); BEGIN
 child:=public.rollover_delivery('attempt-test-pending-1',parent,day,'attempt test',false);
 PERFORM pg_temp.assert((SELECT rollover_count=0 FROM deliveries WHERE id=child),'Pending must not consume an attempt');
 first_child:=child;
 SELECT count(*) INTO count_before FROM deliveries;
 PERFORM pg_temp.assert(public.rollover_delivery('attempt-test-pending-1',parent,day,'attempt test',false)=child,'retry returns existing child');
 PERFORM pg_temp.assert((SELECT count(*)=count_before FROM deliveries),'retry creates no duplicate');
 parent:=child;
 child:=public.rollover_delivery('attempt-test-pending-2',parent,day+1,'attempt test',false);
 PERFORM pg_temp.assert((SELECT rollover_count=0 FROM deliveries WHERE id=child),'multiple untouched days preserve allowance');

 parent:=child;
 PERFORM public.change_delivery_status('attempt-test-first-status',parent,'not_answering');
 child:=public.rollover_delivery('attempt-test-first-failure',parent,day+2,'attempt test',false);
 PERFORM pg_temp.assert((SELECT rollover_count=1 AND current_status='pending' FROM deliveries WHERE id=child),'first failed attempt allows one follow-up');
 parent:=child;
 child:=public.rollover_delivery('attempt-test-gap',parent,day+3,'attempt test',false);
 PERFORM pg_temp.assert((SELECT rollover_count=1 FROM deliveries WHERE id=child),'untouched day after first failure must not trigger cap');
 parent:=child;
 PERFORM public.change_delivery_status('attempt-test-second-status',parent,'not_connecting');
 child:=public.rollover_delivery('attempt-test-second-failure',parent,day+4,'attempt test',false);
 PERFORM pg_temp.assert(child IS NULL,'second qualifying failure permits no third attempt');
 PERFORM pg_temp.assert((SELECT current_status='unserious' FROM deliveries WHERE id=parent),'second failure closes Unserious');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM deliveries WHERE parent_delivery_id=parent),'no successor after two failures');

 FOREACH v_status IN ARRAY ARRAY['pending','tomorrow','will_call_back','available','available_evening','picked_up','waybilled','no_product'] LOOP
  parent:=md5('attempt-operational-'||v_status)::uuid;
  INSERT INTO deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
    quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,current_status,rollover_count,created_by_user_id)
  SELECT parent,client_id,product_catalog_id,'TEST '||v_status,'08011112222','TEST '||v_status,1,10000,3000,4000,day,v_status,1,created_by_user_id
  FROM deliveries WHERE id=first_child;
  IF EXISTS(SELECT 1 FROM delivery_status_defs sd WHERE sd.status=v_status AND sd.category='terminal') THEN
   BEGIN
    PERFORM public.rollover_delivery('attempt-operational-'||v_status,parent,day+1,'attempt test',false);
    RAISE EXCEPTION 'FAIL: terminal status % rolled',v_status;
   EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  ELSE
   child:=public.rollover_delivery('attempt-operational-'||v_status,parent,day+1,'attempt test',false);
   PERFORM pg_temp.assert((SELECT rollover_count=1 FROM deliveries WHERE id=child),v_status||' preserves counter and does not cap');
  END IF;
 END LOOP;
 PERFORM pg_temp.assert((SELECT rollover_count=1 AND current_status='not_answering' FROM deliveries WHERE id=md5('eod-test-order-3')::uuid),'unprocessed historical row is unchanged');
 PERFORM pg_temp.assert(NOT EXISTS(SELECT 1 FROM stock_adjustments),'rollover does not move stock');
 PERFORM pg_temp.assert(public._ensure_workday(date '2026-10-17'+1)=date '2026-10-19','Sunday skip remains');
 RAISE NOTICE 'PASS: pending gaps, two failed attempts, operational matrix, retry, unchanged historical row, stock and Sunday';
END $$;
ROLLBACK;
