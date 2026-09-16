\ir same-customer-pay-test-fixtures.sql
create function pg_temp.complete_order(p_number integer,p_request text,p_occurred timestamptz default now())
returns void language sql as $$
  select public.change_delivery_status(p_client_uuid:=p_request,p_delivery_id:=md5('same-customer-order-'||p_number)::uuid,
    p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=p_occurred)
$$;

-- Existing/legacy completions never get repriced merely by installing this.
savepoint flag_off;
select pg_temp.complete_order(1,'shadow-off-completion');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_earnings),'shadow defaults off');
rollback to flag_off;
update public.feature_flags set enabled=true where key='same_customer_pay_shadow';

select pg_temp.complete_order(1,'shadow-completion-1');
select pg_temp.check_ok((select expected_amount=3000 and multiplier=1 and pay_state='ready'
  and business_date=(now() at time zone 'Africa/Lagos')::date and accounting_date=date '2030-01-02'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),'one success earns full fee using actual Lagos day, preserving accounting date');
select pg_temp.complete_order(2,'shadow-completion-2');
select pg_temp.check_ok((select sum(expected_amount)=4500 and count(*)=2 and count(*) filter(where multiplier=1)=1
  from public.same_customer_earnings where active),'two successes earn one full plus one half');
select pg_temp.check_ok((select expected_amount=3000 from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),'earlier accepted success retains full-fee anchor');
select pg_temp.check_ok((select current_status='cancelled' from public.deliveries where id=md5('same-customer-order-3')::uuid),'existing sibling cancellation still applies');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_earnings where delivery_id=md5('same-customer-order-3')::uuid),'duplicate copy earns nothing');

-- A retry must not duplicate completion, stock movements, or earning revisions.
create temporary table retry_counts as select
  (select count(*) from public.delivery_status_history) as history_count,
  (select count(*) from public.stock_adjustments) as stock_count,
  (select count(*) from public.same_customer_earning_revisions) as audit_count;
select pg_temp.complete_order(2,'shadow-completion-2');
select pg_temp.check_ok((select history_count=(select count(*) from public.delivery_status_history)
  and stock_count=(select count(*) from public.stock_adjustments)
  and audit_count=(select count(*) from public.same_customer_earning_revisions) from retry_counts),'retry changes no status, stock or earnings');

savepoint rate_correction;
update public.deliveries set agent_payment_snapshot=4000,agent_payment_base_snapshot=4000,agent_payment_base_captured_at=clock_timestamp() where id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select bool_and(pay_state='pending' and review_reason='rate_mismatch' and expected_amount is null)
  from public.same_customer_earnings where active),'unequal normal rates flag every affected earning');
update public.deliveries set agent_payment_snapshot=3000,agent_payment_base_snapshot=3000,agent_payment_base_captured_at=clock_timestamp() where id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select sum(expected_amount)=4500 and bool_and(pay_state='ready') from public.same_customer_earnings where active),'correcting baseline restores fixed calculation');
rollback to rate_correction;
\ir same-customer-normal-fee-cases.sql
\ir same-customer-normal-fee-review-cases.sql
\ir same-customer-manual-fee-cases.sql

savepoint reversal;
select public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST incorrect delivery');
select pg_temp.check_ok((select not active and pay_state='reversed' and expected_amount is null from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),'reversal invalidates original earning');
select pg_temp.check_ok((select expected_amount=3000 and multiplier=1 from public.same_customer_earnings where delivery_id=md5('same-customer-order-2')::uuid),'reversal promotes remaining success to full fee');
select pg_temp.check_ok((select sum(quantity_delta)=0 from public.stock_adjustments where delivery_id=md5('same-customer-order-1')::uuid),'existing reversal restores stock exactly once');
select pg_temp.complete_order(1,'shadow-redelivery-1');
select pg_temp.check_ok((select sum(expected_amount)=4500 and count(*)=2 from public.same_customer_earnings where active),'re-delivery restores correct group total without duplicate earning');
rollback to reversal;

savepoint identity_correction;
select public.correct_delivery_customer_match(md5('shadow-split')::uuid,'split',
  (select jsonb_agg(jsonb_build_object('id',id,'revision',same_customer_match_revision)) from public.deliveries
    where id in(md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid)),'TEST separate recipients');
select pg_temp.check_ok((select sum(expected_amount)=6000 and bool_and(multiplier=1) from public.same_customer_earnings where active),'identity split recomputes both groups');
select public.correct_delivery_customer_match(md5('shadow-relink')::uuid,'link',
  (select jsonb_agg(jsonb_build_object('id',id,'revision',same_customer_match_revision)) from public.deliveries
    where id in(md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid)),'TEST same recipient confirmed');
select pg_temp.check_ok((select sum(expected_amount)=4500 from public.same_customer_earnings where active),'identity link recomputes merged group');
rollback to identity_correction;

savepoint offline_date;
select pg_temp.complete_order(4,'shadow-offline-4',now()-interval '1 day');
select pg_temp.check_ok((select pay_state='pending' and review_reason='date_discrepancy' and business_date is null
  and occurred_at is not null and expected_amount is null from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'cross-day offline claim preserved for date review');
select pg_temp.check_ok((select current_status='delivered' and paid=10000 from public.deliveries where id=md5('same-customer-order-4')::uuid),'pending pay does not block operational completion or collection');
rollback to offline_date;

savepoint future_clock;
select pg_temp.complete_order(4,'shadow-future-4',now()+interval '2 days');
select pg_temp.check_ok((select review_reason='clock_skew' and expected_amount is null from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'future device clock cannot choose a pay date');
rollback to future_clock;

savepoint completion_review;
-- An old client omits the occurrence, while effective_at still defaults to now().
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'shadow-legacy-4',null);
select pg_temp.check_ok((select effective_at is not null and reported_occurred_at is null
  from public.delivery_status_history where client_uuid='shadow-legacy-4'),'legacy server fallback is not explicit occurrence evidence');
select pg_temp.check_ok((select pay_state='pending' and review_reason='missing_occurrence' and occurred_at is null
  and expected_amount is null from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'legacy completion stays operationally successful with pending shadow date');
create temporary table review_request as select md5('shadow-date-review-4')::uuid as request_id,
  delivery_id,revision,(now() at time zone 'Africa/Lagos')::date as accepted_day from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid;
select public.review_same_customer_completion_day(request_id,delivery_id,revision,accepted_day,'TEST confirmed by operations') from review_request;
select pg_temp.check_ok((select sum(expected_amount)=6000 and bool_and(pay_state='ready') from public.same_customer_earnings where active),'admin date review joins the existing day and recalculates');
select pg_temp.check_ok((select occurred_at is null and date_review_reason is null from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'date review preserves the original missing occurrence evidence');
create temporary table review_retry_count as select count(*) n from public.same_customer_earning_revisions;
select public.review_same_customer_completion_day(request_id,delivery_id,revision,accepted_day,'TEST confirmed by operations') from review_request;
select pg_temp.check_ok((select n=(select count(*) from public.same_customer_earning_revisions) from review_retry_count)
  and (select count(*)=1 from public.same_customer_completion_reviews),'date correction retry adds no revisions or reviews');
do $$ declare r record; begin
  select * into r from review_request;
  begin
    perform public.review_same_customer_completion_day(r.request_id,r.delivery_id,r.revision,r.accepted_day,'changed reason');
    raise exception 'FAIL: reused request accepted different input'; exception when invalid_parameter_value then null;
  end;
  begin
    perform public.review_same_customer_completion_day(gen_random_uuid(),r.delivery_id,r.revision,r.accepted_day,'TEST stale revision');
    raise exception 'FAIL: stale date review accepted'; exception when serialization_failure then null;
  end;
  begin
    perform public.review_same_customer_completion_day(gen_random_uuid(),r.delivery_id,r.revision,r.accepted_day+1,'TEST future day');
    raise exception 'FAIL: future date review accepted'; exception when invalid_parameter_value then null;
  end;
end $$;
select set_config('request.jwt.claim.sub',md5('same-customer-user-dispatcher')::uuid::text,true);
do $$ begin
  begin
    perform public.review_same_customer_completion_day(gen_random_uuid(),md5('same-customer-order-4')::uuid,1,current_date,'TEST forbidden');
    raise exception 'FAIL: dispatcher can review earning dates'; exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
-- Moving a known full-fee anchor to another day promotes the remaining anchor.
select public.review_same_customer_completion_day(md5('move-anchor-day')::uuid,delivery_id,revision,
  (now() at time zone 'Africa/Lagos')::date-1,'TEST verified previous day') from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select sum(expected_amount)=7500 and count(*) filter(where multiplier=1)=2
  from public.same_customer_earnings where active),'date correction recomputes both old and new day groups');
select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST settlement guard');
do $$ declare e record; begin
  select * into e from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid;
  begin
    perform public.review_same_customer_completion_day(gen_random_uuid(),e.delivery_id,e.revision,e.business_date-1,'TEST settled period');
    raise exception 'FAIL: settled-day correction accepted'; exception when invalid_parameter_value then null;
  end;
end $$;
rollback to completion_review;

-- Alternate contact alone does not authorize a financial identity merge.
savepoint separate_rider;
insert into auth.users(id,email) values(md5('shadow-second-rider')::uuid,'second-rider@example.invalid');
insert into public.users(id,email,display_name,role) values(md5('shadow-second-rider')::uuid,'second-rider@example.invalid','TEST second rider','agent');
insert into public.stock_adjustments(agent_id,product_catalog_id,quantity_delta,reason,created_by_user_id,client_uuid)
  values(md5('shadow-second-rider')::uuid,md5('same-customer-product-4')::uuid,20,'found',md5('same-customer-user-admin')::uuid,'second-rider-stock');
update public.deliveries set customer_phone='08012345678',assigned_agent_id=md5('shadow-second-rider')::uuid where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'shadow-second-rider-4');
select pg_temp.check_ok((select expected_amount=3000 and multiplier=1 from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'different successful rider earns independent full fee');
rollback to separate_rider;

select pg_temp.complete_order(4,'shadow-completion-4');
select pg_temp.check_ok((select expected_amount=3000 from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'alternate phone remains a possible match without deduction');
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select sum(expected_amount)=6000 and count(*)=3 from public.same_customer_earnings where active),'third resolved success earns half');

insert into public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
  location_id,assigned_agent_id,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date)
values(md5('same-customer-order-5')::uuid,md5('same-customer-vendor-b')::uuid,md5('same-customer-product-3')::uuid,
  'TEST same-vendor recipient','08012345678','Another address description',md5('same-customer-location')::uuid,
  md5('same-customer-user-agent')::uuid,1,10000,3000,4000,date '2030-01-03');
insert into public.delivery_items(delivery_id,product_catalog_id,quantity_ordered) values
  (md5('same-customer-order-5')::uuid,md5('same-customer-product-3')::uuid,1),
  (md5('same-customer-order-5')::uuid,md5('same-customer-product-4')::uuid,2);
select pg_temp.complete_order(5,'shadow-completion-5');
select pg_temp.check_ok((select sum(expected_amount)=7500 and count(*)=4 and count(distinct group_id)=1
  from public.same_customer_earnings where active),'four successes across accounting dates and multiple item lines earn 2.5 fees');
select pg_temp.check_ok((select accounting_date=date '2030-01-03' and expected_amount=1500 from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-5')::uuid),'accounting date does not split actual-day pay group');

-- Reassignment after completion must not transfer the successful rider snapshot.
savepoint assignment_after_success;
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select rider_id=md5('same-customer-user-agent')::uuid and expected_amount=1500
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'later assignment edits preserve successful rider');
rollback to assignment_after_success;

savepoint postponed_completion;
insert into public.delivery_status_defs(status,category,label) values('postponed','soft_failure','Postponed');
insert into public.delivery_status_transitions(from_status,to_status) values('postponed','delivered');
insert into public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
  location_id,assigned_agent_id,quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,current_status)
values(md5('same-customer-order-6')::uuid,md5('same-customer-vendor-b')::uuid,md5('same-customer-product-3')::uuid,
  'TEST postponed recipient','09088776655','Postponed test address',md5('same-customer-location')::uuid,
  md5('same-customer-user-agent')::uuid,1,10000,3000,4000,date '2030-01-09','postponed');
insert into public.delivery_items(delivery_id,product_catalog_id,quantity_ordered)
  values(md5('same-customer-order-6')::uuid,md5('same-customer-product-3')::uuid,1);
select pg_temp.complete_order(6,'shadow-postponed-6');
select pg_temp.check_ok((select e.accounting_date=d.scheduled_date and e.accounting_date=(now() at time zone 'Africa/Lagos')::date
  from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
  where d.id=md5('same-customer-order-6')::uuid),'postponed completion snapshots the final accounting date');
rollback to postponed_completion;

select pg_temp.check_ok((select bool_and(agent_payment_snapshot=3000 and charged_snapshot=4000 and customer_price=10000)
  from public.deliveries),'shadow calculations never change money snapshots');
select pg_temp.check_ok(not exists(select 1 from public.settlements),'shadow calculations create no settlements');
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
do $$ begin
  begin perform public.get_same_customer_shadow_pay(md5('same-customer-order-1')::uuid);
    raise exception 'FAIL: rider can see provisional shadow pay'; exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin
  if exists(select 1 from public.deliveries) or exists(select 1 from public.users)
    or exists(select 1 from public.same_customer_earnings) or exists(select 1 from public.same_customer_pay_groups)
    or exists(select 1 from public.same_customer_earning_revisions) then raise exception 'Shadow fixtures were not rolled back'; end if;
end $$;
select 'PASS: shadow earnings, actual Lagos day, rates, retries, reversals, identity, stock and rollback' as result;
