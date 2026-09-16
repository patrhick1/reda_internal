\ir same-customer-pay-test-fixtures.sql
create function pg_temp.complete_order(p_number integer,p_request text,p_occurred timestamptz default now())
returns void language sql as $$
  select public.change_delivery_status(p_client_uuid:=p_request,p_delivery_id:=md5('same-customer-order-'||p_number)::uuid,
    p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=p_occurred)
$$;
select pg_temp.check_ok((select active_from is null from public.same_customer_pay_policy),'final payout activation defaults off');
savepoint late_offline_policy;
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date-2,
  inactive_from=(now() at time zone 'Africa/Lagos')::date;
select public.correct_delivery_charge(md5('same-customer-order-4')::uuid,4000,2500,'TEST offline manual exception after suspension');
select pg_temp.complete_order(4,'final-offline-after-suspension',now()-interval '1 day');
select pg_temp.check_ok((select policy_applied and final_state='pending' and final_review_reason='date_discrepancy'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),
  'offline completion from an active day stays pending even after the policy is suspended');
select public.review_same_customer_completion_day(md5('late-offline-date')::uuid,delivery_id,revision,
  (now() at time zone 'Africa/Lagos')::date-1,'TEST verified active-day offline completion')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select policy_applied and final_state='pending' and final_review_reason='manual_review'
  and base_fee=3000 and manual_amount=2500 from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'offline manual exception survives date review and needs renewed acknowledgement');
select public.review_same_customer_manual_pay(md5('offline-exception-review')::uuid,g.id,g.revision,'TEST confirmed offline exception after date review')
  from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id
  where e.delivery_id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select policy_applied and final_state='ready' and final_amount=2500 and base_fee=3000 and manual_amount=2500
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'verified offline active day retains its policy');
rollback to late_offline_policy;
savepoint future_claim_before_activation;
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date+1;
select pg_temp.complete_order(4,'final-future-before-activation',now()+interval '2 days');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_earnings)
  and not exists(select 1 from public.same_customer_pay_policy_days where business_date>(now() at time zone 'Africa/Lagos')::date),
  'future device clock cannot enroll a future policy day before activation');
rollback to future_claim_before_activation;
-- Only the isolated owner configures today's policy in this rolled-back fixture.
update public.same_customer_pay_policy set active_from=(clock_timestamp() at time zone 'Africa/Lagos')::date;
select pg_temp.complete_order(1,'final-completion-1');
select pg_temp.complete_order(2,'final-completion-2');
\ir same-customer-normal-fee-review-cases.sql
select pg_temp.check_ok((select count(*)=2 and sum(final_amount)=4500 and bool_and(policy_applied and final_state='ready')
  from public.same_customer_earnings where active),'final policy works while shadow flag is off');
select pg_temp.check_ok((select sum(agent_payment_snapshot)=4500 from public.deliveries where current_status='delivered'),
  'final full and half earnings project into actual payable snapshots');
select pg_temp.check_ok((select bool_and(charged_snapshot=4000 and customer_price=10000) from public.deliveries),
  'rider policy never changes vendor charges or customer prices');
create temporary table final_retry_counts as select (select count(*) from public.same_customer_earning_revisions) n,
  (select count(*) from public.stock_adjustments) stock_n;
select pg_temp.complete_order(2,'final-completion-2');
select pg_temp.check_ok((select n=(select count(*) from public.same_customer_earning_revisions)
  and stock_n=(select count(*) from public.stock_adjustments) from final_retry_counts),'completion retry duplicates neither money nor stock');

savepoint final_reversal;
select public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST final earning reversal');
select pg_temp.check_ok((select final_state='reversed' and final_amount is null from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-1')::uuid) and
  (select agent_payment_snapshot=3000 from public.deliveries where id=md5('same-customer-order-2')::uuid),
  'reversal reverses the earning and promotes the remaining success');
select pg_temp.complete_order(1,'final-redelivery-1');
select pg_temp.check_ok((select sum(final_amount)=4500 and count(*)=2 from public.same_customer_earnings where active)
  and (select agent_payment_snapshot=1500 and agent_payment_base_snapshot=3000 from public.deliveries
    where id=md5('same-customer-order-1')::uuid),'redelivery earns the half tier without halving the normal baseline');
rollback to final_reversal;

savepoint final_manual;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST final manual exception');
select pg_temp.check_ok((select bool_and(final_state='pending' and final_amount is null) from public.same_customer_earnings where active),
  'unreviewed exception leaves final amounts explicitly pending');
select public.review_same_customer_manual_pay(md5('final-manual-review')::uuid,g.id,g.revision,'TEST reviewed final exception')
  from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id
  where e.delivery_id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select sum(final_amount)=4000 and bool_and(final_state='ready') from public.same_customer_earnings where active)
  and (select sum(agent_payment_snapshot)=4000 from public.deliveries where current_status='delivered'),
  'reviewed manual exception projects atomically');
select public.clear_same_customer_manual_fee(md5('final-manual-clear')::uuid,delivery_id,revision,'TEST restore default rule')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select sum(agent_payment_snapshot)=4500 from public.deliveries where current_status='delivered'),
  'clearing a live exception restores the fixed final rule');
select public.correct_delivery_charge(md5('same-customer-order-4')::uuid,4000,2600,'TEST pre-success live exception');
select pg_temp.complete_order(4,'final-pre-success-exception');
select pg_temp.check_ok((select final_amount=2600 and manual_amount=2600 and base_fee=3000 from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'live policy records pre-completion exceptions with shadow off');
rollback to final_manual;

savepoint final_pending;
select pg_temp.complete_order(4,'final-legacy-missing-time',null);
select pg_temp.check_ok((select policy_applied and final_state='pending' and final_amount is null and final_review_reason='missing_occurrence'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'missing timestamp stays operationally complete and financially pending');
do $$ begin
  begin
    perform public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST pending must block');
    raise exception 'FAIL: pending earning settled';
  exception when raise_exception then
    if sqlerrm<>'rider pay needs review before this period can be settled' then raise; end if;
  end;
end $$;
do $$ begin
  begin
    insert into public.settlements(subject_type,subject_id,period_date,settled_by,expected_amount,deliveries_count,snapshot)
    values('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02',auth.uid(),0,3,'{}');
    raise exception 'FAIL: direct writer settled pending pay';
  exception when raise_exception then
    if sqlerrm<>'rider pay needs review before this period can be settled' then raise; end if;
  end;
end $$;
-- A historical voided record is not an active handover. Reactivating it must
-- pass the same readiness check as inserting a new active record.
insert into public.settlements(id,subject_type,subject_id,period_date,settled_by,expected_amount,deliveries_count,snapshot,voided_at,voided_by,void_reason)
values(md5('pending-voided-settlement')::uuid,'agent',md5('same-customer-user-agent')::uuid,date '2030-01-02',auth.uid(),0,3,'{}',now(),auth.uid(),'TEST historical void');
do $$ begin
  begin
    update public.settlements set voided_at=null,voided_by=null,void_reason=null where id=md5('pending-voided-settlement')::uuid;
    raise exception 'FAIL: direct writer reactivated pending handover';
  exception when raise_exception then
    if sqlerrm<>'rider pay needs review before this period can be settled' then raise; end if;
  end;
end $$;
select pg_temp.check_ok((select voided_at is not null from public.settlements where id=md5('pending-voided-settlement')::uuid),
  'rejected reactivation leaves historical void untouched');
savepoint direct_settlement_subject_change;
insert into public.settlements(id,subject_type,subject_id,period_date,settled_by,expected_amount,deliveries_count,snapshot)
values(md5('guard-client-to-agent')::uuid,'client',md5('same-customer-vendor-a')::uuid,date '2030-01-02',auth.uid(),0,0,'{}');
do $$ begin
  begin
    update public.settlements set subject_type='agent',subject_id=md5('same-customer-user-agent')::uuid
      where id=md5('guard-client-to-agent')::uuid;
    raise exception 'FAIL: direct writer moved a settlement into pending rider period';
  exception when raise_exception then
    if sqlerrm<>'rider pay needs review before this period can be settled' then raise; end if;
  end;
end $$;
select pg_temp.check_ok((select subject_type='client' from public.settlements where id=md5('guard-client-to-agent')::uuid),
  'rejected subject change preserves the original settlement');
rollback to direct_settlement_subject_change;
select public.settle_period('client',md5('same-customer-vendor-b')::uuid,date '2030-01-02','TEST vendor unaffected');
select pg_temp.check_ok((select expected_amount=12000 from public.settlements where subject_type='client'),
  'pending rider pay does not block or change vendor reconciliation');
rollback to final_pending;

savepoint final_rate;
update public.deliveries set agent_payment_base_snapshot=4000,agent_payment_base_captured_at=clock_timestamp()
  where id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select bool_and(final_state='pending' and final_review_reason='rate_mismatch') from public.same_customer_earnings where active),
  'unequal normal rates cannot produce final payable amounts');
update public.deliveries set agent_payment_base_snapshot=3000,agent_payment_base_captured_at=clock_timestamp()
  where id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select sum(final_amount)=4500 and bool_and(final_state='ready') from public.same_customer_earnings where active),
  'corrected normal rates restore final amounts');
rollback to final_rate;

savepoint corrected_prepolicy_day;
select public.review_same_customer_completion_day(md5('final-prepolicy-date')::uuid,delivery_id,revision,business_date-1,'TEST actual day was before activation')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select not policy_applied and final_state='legacy' and final_amount=3000 from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-2')::uuid) and (select agent_payment_snapshot=3000 from public.deliveries
    where id=md5('same-customer-order-2')::uuid),'verified pre-policy date restores the normal fee instead of a retrospective discount');
select public.correct_delivery_charge(md5('same-customer-order-2')::uuid,4000,2600,'TEST manual correction after pre-policy date review');
select pg_temp.check_ok((select final_amount=2600 and not policy_applied from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-2')::uuid),'explicit correction after policy removal keeps the recorded amount current');
rollback to corrected_prepolicy_day;

savepoint day_policy;
update public.same_customer_pay_policy set active_from=null,inactive_from=null;
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'final-enrolled-day');
select pg_temp.check_ok((select final_amount=1500 and policy_applied from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),
  'changing future policy cannot disable an already enrolled business day');
rollback to day_policy;

savepoint completed_rider;
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-2')::uuid;
select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST successful rider ownership');
select pg_temp.check_ok((select expected_amount=15500 and deliveries_count=2 from public.settlements),
  'settlement uses the successful rider even after assignment changes');
rollback to completed_rider;

select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST freeze first period');
create temporary table frozen_settlement as select id,snapshot,expected_amount from public.settlements;
insert into public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
  location_id,assigned_agent_id,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date)
values(md5('same-customer-order-5')::uuid,md5('same-customer-vendor-b')::uuid,md5('same-customer-product-4')::uuid,
  'TEST open other period','08012345678','Another address',md5('same-customer-location')::uuid,
  md5('same-customer-user-agent')::uuid,1,10000,3000,4000,date '2030-01-03');
insert into public.delivery_items(delivery_id,product_catalog_id,quantity_ordered)
  values(md5('same-customer-order-5')::uuid,md5('same-customer-product-4')::uuid,1);
select pg_temp.complete_order(5,'final-open-period-5');
select pg_temp.check_ok((select final_amount=1500 and final_state='ready' from public.same_customer_earnings where delivery_id=md5('same-customer-order-5')::uuid),
  'new half fee in an open period is allowed when frozen amounts remain identical');
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'final-late-settled-period-4');
select pg_temp.check_ok((select bool_and(final_state='pending' and final_review_reason='settled_period_conflict') from public.same_customer_earnings where active),
  'new activity in an already-settled period requires explicit review');
select pg_temp.check_ok((select s.snapshot=f.snapshot and s.expected_amount=f.expected_amount from public.settlements s join frozen_settlement f using(id))
  and (select agent_payment_snapshot=1500 from public.deliveries where id=md5('same-customer-order-2')::uuid),
  'late completion preserves frozen snapshot and payout');
do $$ begin
  begin
    perform public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST frozen reversal');
    raise exception 'FAIL: frozen delivered earning reversed'; exception when invalid_parameter_value then null;
  end;
end $$;
select public.void_settlement(id,'TEST resolve late activity') from frozen_settlement;
select pg_temp.check_ok((select sum(final_amount)=7500 and bool_and(final_state='ready') from public.same_customer_earnings where active),
  'voiding frozen period resolves conflict and projects all four successful earnings');
select pg_temp.check_ok((select s.snapshot=f.snapshot and s.expected_amount=f.expected_amount and s.voided_at is not null
  from public.settlements s join frozen_settlement f using(id)),'void preserves original historical snapshot');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_projection_context),'projection recursion context always cleans up');
rollback;
do $$ begin
  if exists(select 1 from public.deliveries) or exists(select 1 from public.same_customer_earnings)
    or exists(select 1 from public.same_customer_pay_policy_days) or exists(select 1 from public.same_customer_projection_context) then
    raise exception 'Final-pay fixture cleanup failed'; end if;
end $$;
select 'PASS: final pay projection, pending settlement, manual exceptions, lifecycle, frozen history and rollback' as result;
