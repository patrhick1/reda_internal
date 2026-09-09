-- Creates temporary fixtures; always rolls back.
BEGIN;
\set ON_ERROR_STOP on
do $test$
declare
 actor uuid; rider uuid; seed public.deliveries%rowtype; test_id uuid; item uuid; attempt uuid;
 token text:=gen_random_uuid()::text; outcomes jsonb; day date:=(now() at time zone 'Africa/Lagos')::date;
 balance numeric; settlement uuid;
begin
 select id into actor from users where role='admin' and is_active limit 1;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 select d.* into seed from deliveries d join current_stock st on st.agent_id=d.assigned_agent_id and st.product_catalog_id=d.product_catalog_id and st.quantity_on_hand>=1
 join product_catalog p on p.id=d.product_catalog_id and p.is_active
 where d.order_type='delivery' and d.deleted_at is null and d.location_id is not null
 and not exists(select 1 from settlements s where s.voided_at is null and s.period_date=day and ((s.subject_type='client' and s.subject_id=d.client_id) or (s.subject_type='agent' and s.subject_id=d.assigned_agent_id))) limit 1;
 if seed.id is null then raise exception 'No eligible stock fixture'; end if;
 rider:=seed.assigned_agent_id;
 test_id:=create_replacement(token||':create',seed.client_id,'Payment rollback test',seed.customer_phone,null,seed.raw_address,seed.location_id,day,rider,
 jsonb_build_array(jsonb_build_object('product_catalog_id',seed.product_catalog_id,'quantity',1)),
 jsonb_build_array(jsonb_build_object('product_catalog_id',seed.product_catalog_id,'quantity',1,'vendor_instruction','ask_if_damaged')),'other','Rollback',3000,1500);
 select id into item from replacement_return_items where delivery_id=test_id;
 outcomes:=jsonb_build_array(jsonb_build_object('return_item_id',item,'outcome','left_with_customer','quantity',0));
 begin
 perform complete_replacement(token,test_id,outcomes,null,-1,'cash','rider');
 raise exception 'Negative accepted';
 exception when check_violation then null; end;
 perform complete_replacement(token,test_id,outcomes,null,1800,'cash','rider');
 perform complete_replacement(token,test_id,outcomes,null,1800,'cash','rider');
 select id into attempt from replacement_attempts where delivery_id=test_id;
 if (select count(*) from replacement_attempts where delivery_id=test_id)<>1 then raise exception 'Replay duplicated attempt'; end if;
 if (select count(*) from stock_adjustments where delivery_id=test_id and reason='replacement_outbound')<>1 then raise exception 'Replay duplicated stock'; end if;
 if (select amount from client_financial_activity where entry_id=attempt)<>-1700 then raise exception 'Partial payment ledger (cash carries the 500 POS fee)'; end if;
 if not exists(select 1 from list_replacement_financials_v2(day,day) where attempt_id=attempt and customer_paid=1800) then raise exception 'Admin report'; end if;
 if not exists(select 1 from list_replacement_financials_rep_v2(day,day) where attempt_id=attempt and remit=-1700) then raise exception 'Rep report'; end if;
 if not exists(select 1 from list_replacement_agent_financials_v2(day,day) where attempt_id=attempt and customer_paid=1800 and payment_received_by='rider') then raise exception 'Rider report'; end if;

 settlement:=settle_period('agent',rider,day,'Rollback rider cash');
 if not exists(select 1 from settlements s, jsonb_array_elements(s.snapshot->'by_delivery') x where s.id=settlement and x->>'attempt_id'=attempt::text and (x->>'to_remit')::numeric=300) then raise exception 'Rider cash remittance should be 300'; end if;
 update settlements set voided_at=now() where id=settlement;
 perform correct_replacement_payment(attempt,3000,1500,'Zero payment correction',0,null,null);
 if (select amount from client_financial_activity where entry_id=attempt)<>-3000 then raise exception 'Zero payment ledger'; end if;
 begin
 perform correct_replacement_payment(attempt,3000,1500,'Invalid method',1800,null,'rider');
 raise exception 'Missing method accepted';
 exception when check_violation then null; end;
 perform correct_replacement_payment(attempt,3000,1500,'Full payment correction',3000,'transfer','reda');
 if (select amount from client_financial_activity where entry_id=attempt)<>0 then raise exception 'Full payment ledger'; end if;

 if (select activity_date from client_financial_activity where entry_id=attempt)<>day then raise exception 'Payment moved activity date'; end if;
 if exists(select 1 from list_replacement_financials_v2(day+1,day+1) where attempt_id=attempt) then raise exception 'Payment duplicated next day'; end if;
 settlement:=settle_period('client',seed.client_id,day,'Rollback client snapshot');
 if not exists(select 1 from settlements s, jsonb_array_elements(s.snapshot->'by_delivery') x where s.id=settlement and x->>'attempt_id'=attempt::text and (x->>'remit')::numeric=0 and (x->>'customer_paid')::numeric=3000) then raise exception 'Client snapshot'; end if;
 settlement:=settle_period('agent',rider,day,'Rollback payment test');
 if not exists(select 1 from settlements s, jsonb_array_elements(s.snapshot->'by_delivery') x where s.id=settlement and x->>'attempt_id'=attempt::text and (x->>'to_remit')::numeric=-1500) then raise exception 'REDA direct payment incorrectly charged to rider'; end if;
 begin
 perform correct_replacement_payment(attempt,3000,1500,'Blocked correction',0,null,null);
 raise exception 'Settled correction accepted';
 exception when invalid_parameter_value then null; end;
 perform set_config('request.jwt.claim.sub',rider::text,true);
 begin
 perform correct_replacement_payment(attempt,3000,1500,'Unauthorized',0,null,null);
 raise exception 'Rider corrected finances';
 exception when insufficient_privilege then null; end;
 raise notice 'PASS: partial/full payment, reports, replay, direct REDA receipt, settlement protection and permissions';
end;
$test$;

ROLLBACK;

