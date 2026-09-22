-- The runner prepends the existing synthetic payment fixtures in a transaction.
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date,inactive_from=null;
create function pg_temp.complete_order(n integer, request text, happened timestamptz default now())
returns void language sql as $$
  select public.change_delivery_status(p_client_uuid:=request,p_delivery_id:=md5('same-customer-order-'||n)::uuid,
    p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=happened)
$$;
create function pg_temp.save_pay(n integer, amount numeric, request uuid default gen_random_uuid())
returns jsonb language plpgsql as $$ declare p jsonb; begin
  p:=public.preview_delivery_charge_correction(md5('same-customer-order-'||n)::uuid,4000,amount,true);
  return public.correct_delivery_charge_v2(request,md5('same-customer-order-'||n)::uuid,p->>'revision',4000,amount,'TEST agreed payout',true);
end $$;

savepoint before_completion;
select public.correct_delivery_charge(md5('same-customer-order-2')::uuid,0,0,'TEST charge once');
select pg_temp.complete_order(1,'waiver-before-1');
select pg_temp.complete_order(2,'waiver-before-2');
select pg_temp.check_ok((select sum(final_amount)=3000 and bool_and(final_state='ready') from public.same_customer_earnings where active),
  'old client waiver before completion is immediately final, including zero');
select pg_temp.check_ok((select charged_snapshot=0 and agent_payment_snapshot=0 and agent_payment_base_snapshot=3000
  from public.deliveries where id=md5('same-customer-order-2')::uuid),'waiver preserves baseline and both chosen fees');
rollback to before_completion;

select pg_temp.complete_order(1,'waiver-main-1');
select pg_temp.complete_order(2,'waiver-main-2');
select pg_temp.check_ok((select sum(final_amount)=4500 and bool_and(final_state='ready') from public.same_customer_earnings where active),'ordinary full/half calculation preserved');

savepoint zero_first;
select pg_temp.save_pay(1,0);
select pg_temp.save_pay(2,3000);
select pg_temp.check_ok((select sum(final_amount)=3000 and bool_and(final_state='ready') from public.same_customer_earnings where active),'waiving first and choosing second full preserves both explicit amounts');
select pg_temp.save_pay(2,0);
select pg_temp.check_ok((select sum(final_amount)=0 and bool_and(final_state='ready') from public.same_customer_earnings where active),'both intentional zeros are valid');
rollback to zero_first;

savepoint mixed_rates;
select public.correct_same_customer_normal_fee(gen_random_uuid(),delivery_id,revision,4000,'TEST another legitimate baseline')
from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select bool_and(final_state='pending') from public.same_customer_earnings where active),'unresolved automatic rates remain protected');
select pg_temp.save_pay(2,0);
select pg_temp.check_ok((select sum(final_amount)=3000 and bool_and(final_state='ready') from public.same_customer_earnings where active),'explicit waiver resolves mixed automatic/manual rates without changing either baseline');
rollback to mixed_rates;

savepoint save_and_retry;
create temporary table saved_request as select gen_random_uuid() request_id,
  public.preview_delivery_charge_correction(md5('same-customer-order-2')::uuid,0,0,true) p;
select pg_temp.check_ok((select (p->>'total')::numeric=3000 and not (p->>'pending')::boolean from saved_request),'preview shows exact waived group total');
select public.correct_delivery_charge_v2(request_id,md5('same-customer-order-2')::uuid,p->>'revision',0,0,'TEST charge once',true) from saved_request;
create temporary table saved_counts as select (select count(*) from public.same_customer_fee_decisions) decisions,
  (select count(*) from public.stock_adjustments) stock,(select count(*) from public.same_customer_earning_revisions) revisions;
select public.correct_delivery_charge_v2(request_id,md5('same-customer-order-2')::uuid,p->>'revision',0,0,'TEST charge once',true) from saved_request;
select pg_temp.check_ok((select decisions=(select count(*) from public.same_customer_fee_decisions)
  and stock=(select count(*) from public.stock_adjustments) and revisions=(select count(*) from public.same_customer_earning_revisions) from saved_counts),
  'retry returns saved result without duplicate financial, history or stock changes');
select pg_temp.check_ok((select total_earnings=3000 and total_remit=17000 and pending_pay_count=0
  from public.agent_earnings_summary_v2('2030-01-02','2030-01-02')),'reconciliation agrees with waived pay');
select pg_temp.check_ok((select sum(amount)=3000 and bool_and(state='ready') from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid])),
  'delivery and rider metadata agree with reconciliation');
select pg_temp.check_ok((public.list_agent_pay_details(md5('same-customer-user-agent')::uuid,'2030-01-02','2030-01-02')->'orders'->0->>'manual_amount')::numeric=0,
  'reconciliation exposes waiver and its audit details');

savepoint single_handover;
select public.settle_period('agent',md5('same-customer-user-agent')::uuid,'2030-01-02','TEST actual handover');
select pg_temp.check_ok((select expected_amount=17000 from public.settlements where subject_type='agent' and voided_at is null),'single handover succeeds with exact amount');
do $$ begin
  begin perform pg_temp.save_pay(2,1000); raise exception 'FAIL settled payout changed'; exception when unique_violation or invalid_parameter_value then null; end;
end $$;
rollback to single_handover;
select public.bulk_settle_agents(gen_random_uuid(),array[md5('same-customer-user-agent')::uuid],'2030-01-02','TEST bulk handover');
select pg_temp.check_ok((select expected_amount=17000 from public.settlements where subject_type='agent' and voided_at is null),'bulk handover succeeds with exact amount');
rollback to save_and_retry;

savepoint later_order;
select pg_temp.save_pay(2,0);
create temporary table stale_preview as select public.preview_delivery_charge_correction(md5('same-customer-order-1')::uuid,4000,3500,true) p;
update public.deliveries set customer_phone='08012345678',customer_phone_alt=null where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'waiver-third');
select pg_temp.check_ok((select count(*)=3 and sum(final_amount)=4500 and bool_and(final_state='ready') from public.same_customer_earnings where active),
  'third successful delivery preserves prior zero and automatically calculates only its own fee');
do $$ begin
  begin perform public.correct_delivery_charge_v2(gen_random_uuid(),md5('same-customer-order-1')::uuid,
    (select p->>'revision' from stale_preview),4000,3500,'TEST stale',true);
    raise exception 'FAIL stale preview accepted'; exception when serialization_failure then null; end;
end $$;
select public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST reverse');
select pg_temp.check_ok((select manual_amount=0 and final_amount=0 and final_state='ready' from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid),
  'another delivery reversal cannot erase a waiver');
rollback to later_order;

savepoint nonzero_and_same_amount;
select pg_temp.save_pay(1,2500);
select pg_temp.check_ok((select sum(final_amount)=4000 and bool_and(final_state='ready') from public.same_customer_earnings where active),'nonzero manual amount needs no redundant approval');
select pg_temp.save_pay(2,1500);
select pg_temp.check_ok((select manual_amount=1500 and final_state='ready' from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid),'explicitly saving existing amount records intent');
rollback to nonzero_and_same_amount;

savepoint client_only;
select public.correct_delivery_charge_v2(gen_random_uuid(),md5('same-customer-order-1')::uuid,
  public.preview_delivery_charge_correction(md5('same-customer-order-1')::uuid)->>'revision',0,3000,'TEST waive client fee only',false);
select pg_temp.check_ok(not exists(select 1 from public.same_customer_fee_decisions)
  and (select sum(final_amount)=4500 from public.same_customer_earnings where active),'waiving client charge does not change or override rider pay');
rollback to client_only;

savepoint offline;
select public.correct_delivery_charge(md5('same-customer-order-4')::uuid,0,0,'TEST offline waiver');
select pg_temp.complete_order(4,'waiver-offline',now()-interval '1 day');
select pg_temp.check_ok((select final_state='pending' and final_review_reason='date_discrepancy' and manual_amount=0
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'manual zero does not erase independent date discrepancy');
rollback to offline;

select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
do $$ begin
  begin perform public.preview_delivery_charge_correction(md5('same-customer-order-1')::uuid); raise exception 'FAIL rider can preview private fee edit'; exception when insufficient_privilege then null; end;
  begin perform pg_temp.save_pay(1,0); raise exception 'FAIL rider can waive own fee'; exception when insufficient_privilege then null; end;
  begin perform public.list_agent_pay_details(md5('same-customer-user-agent')::uuid,'2030-01-02','2030-01-02'); raise exception 'FAIL private audit exposed'; exception when insufficient_privilege then null; end;
end $$;
rollback;
