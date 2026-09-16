-- Shared assertions run with both shadow-only and final-pay policies.
savepoint normal_fee_review_cases;
update public.deliveries set agent_payment_base_snapshot=null,
  agent_payment_base_captured_at=clock_timestamp() where id=md5('same-customer-order-2')::uuid;
create temporary table normal_fee_request as select gen_random_uuid() request_id,delivery_id,revision
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid;
select public.correct_same_customer_normal_fee(request_id,delivery_id,revision,3000,'TEST verified location rate') from normal_fee_request;
select pg_temp.check_ok((select sum(expected_amount)=4500 and bool_and(pay_state='ready')
  from public.same_customer_earnings where active), 'normal-fee review repairs missing baseline and recalculates group');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_fee_decisions)
  and (select count(*)=1 and bool_and(before_value->>'base_fee' is null and (after_value->>'base_fee')::numeric=3000)
  from public.same_customer_normal_fee_reviews),'normal correction audits before/after without creating exception');
select pg_temp.check_ok(public.get_same_customer_shadow_pay(md5('same-customer-order-2')::uuid)
  ->'last_normal_fee_review'->>'reason'='TEST verified location rate','admin read exposes normal-fee correction evidence');
create temporary table normal_fee_counts as select (select count(*) from public.same_customer_earning_revisions) n,
  (select count(*) from public.stock_adjustments) stock_n;
select public.correct_same_customer_normal_fee(request_id,delivery_id,revision,3000,'TEST verified location rate') from normal_fee_request;
select pg_temp.check_ok((select n=(select count(*) from public.same_customer_earning_revisions)
  and stock_n=(select count(*) from public.stock_adjustments) from normal_fee_counts)
  and (select count(*)=1 from public.same_customer_normal_fee_reviews),'normal correction retry has no duplicate financial or stock effect');
select pg_temp.check_ok((select sum(d.agent_payment_snapshot)=case when bool_or(e.policy_applied) then 4500 else 6000 end
  from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id where e.active),
  'shadow correction preserves payable; active policy projects corrected final pay');
do $$ declare r record; v numeric; begin
  select * into r from normal_fee_request;
  begin
    perform public.correct_same_customer_normal_fee(r.request_id,r.delivery_id,r.revision,4000,'TEST changed request');
    raise exception 'FAIL: conflicting reuse accepted'; exception when invalid_parameter_value then null;
  end;
  begin
    perform public.correct_same_customer_normal_fee(gen_random_uuid(),r.delivery_id,r.revision,4000,'TEST stale');
    raise exception 'FAIL: stale fee correction accepted'; exception when serialization_failure then null;
  end;
  select revision into r.revision from public.same_customer_earnings where delivery_id=r.delivery_id;
  foreach v in array array[-1::numeric,'NaN'::numeric,'Infinity'::numeric,1.001::numeric,100000000::numeric,3000::numeric] loop
    begin
      perform public.correct_same_customer_normal_fee(gen_random_uuid(),r.delivery_id,r.revision,v,'TEST invalid amount');
      raise exception 'FAIL: invalid/unchanged fee accepted: %',v; exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.correct_same_customer_normal_fee(gen_random_uuid(),r.delivery_id,r.revision,4000,' ');
    raise exception 'FAIL: missing reason accepted'; exception when invalid_parameter_value then null;
  end;
  begin
    perform public.correct_same_customer_normal_fee(gen_random_uuid(),md5('same-customer-order-4')::uuid,1,4000,'TEST pending');
    raise exception 'FAIL: pending delivery correction accepted'; exception when invalid_parameter_value then null;
  end;
end $$;
savepoint normal_fee_zero;
select public.correct_same_customer_normal_fee(gen_random_uuid(),delivery_id,revision,0,'TEST zero normal fee')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select base_fee=0 and pay_state='pending' and review_reason='rate_mismatch'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid),
  'zero is a valid baseline but does not bypass unequal-rate review');
rollback to normal_fee_zero;
savepoint normal_fee_exception;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST preserved manual exception');
select public.review_same_customer_manual_pay(gen_random_uuid(),g.id,g.revision,'TEST confirmed exception')
  from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id
  where e.delivery_id=md5('same-customer-order-1')::uuid;
select public.correct_same_customer_normal_fee(gen_random_uuid(),delivery_id,revision,4000,'TEST changed baseline')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select base_fee=4000 and manual_amount=2500 and pay_state='pending'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),
  'normal-fee correction preserves exception and invalidates group readiness');
rollback to normal_fee_exception;
savepoint normal_fee_settled;
select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST freeze normal-fee period');
do $$ declare e record; begin
  select * into e from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid;
  begin
    perform public.correct_same_customer_normal_fee(gen_random_uuid(),e.delivery_id,e.revision,4000,'TEST frozen period');
    raise exception 'FAIL: settled normal correction accepted'; exception when invalid_parameter_value then null;
  end;
end $$;
rollback to normal_fee_settled;
select set_config('request.jwt.claim.sub',md5('same-customer-user-dispatcher')::uuid::text,true);
set local role authenticated;
do $$ begin
  begin
    perform public.correct_same_customer_normal_fee(gen_random_uuid(),md5('same-customer-order-2')::uuid,1,4000,'TEST forbidden');
    raise exception 'FAIL: dispatcher correction accepted'; exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.same_customer_normal_fee_reviews;
    raise exception 'FAIL: private audit access granted'; exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback to normal_fee_review_cases;
