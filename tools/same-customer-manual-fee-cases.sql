savepoint manual_fee_cases;
-- A vendor-charge-only correction is not a rider-pay exception.
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4100,3000,'TEST vendor charge only');
select pg_temp.check_ok(not exists(select 1 from public.same_customer_fee_decisions)
  and (select sum(expected_amount)=4500 from public.same_customer_earnings where active),'charge-only correction does not create a rider exception');
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST joint vendor submission exception');
select pg_temp.check_ok((select e.base_fee=3000 and e.manual_amount=2500 and e.manual_reason='TEST joint vendor submission exception'
  and d.agent_payment_base_snapshot=3000 and d.agent_payment_snapshot=2500
  from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
  where e.delivery_id=md5('same-customer-order-1')::uuid),'manual final fee preserves the normal baseline and explicit current correction');
select pg_temp.check_ok((select bool_and(pay_state='pending' and review_reason='manual_review' and expected_amount is null)
  from public.same_customer_earnings where active),'multi-delivery manual exception requires group review');
create temporary table manual_review_request as select md5('manual-review-1')::uuid request_id,g.id group_id,g.revision
  from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id
  where e.delivery_id=md5('same-customer-order-1')::uuid;
do $$ declare p1 jsonb; p2 jsonb; begin
  p1:=public.get_same_customer_pay_group((select group_id from manual_review_request),null,1);
  p2:=public.get_same_customer_pay_group((select group_id from manual_review_request),(p1->>'next_cursor')::uuid,1);
  perform pg_temp.check_ok((p1->>'total_count')::integer=2 and (p1->>'proposed_total')::numeric=4000
    and jsonb_array_length(p1->'orders')=1 and jsonb_array_length(p2->'orders')=1
    and p2->>'next_cursor' is null and p1->>'revision'=p2->>'revision'
    and p1->'orders'->0->>'delivery_id'<>p2->'orders'->0->>'delivery_id','group-review pagination preserves full totals and distinct members');
end $$;
select public.review_same_customer_manual_pay(request_id,group_id,revision,'TEST reviewed all group amounts') from manual_review_request;
select pg_temp.check_ok((select sum(expected_amount)=4000 and bool_and(pay_state='ready') from public.same_customer_earnings where active),
  'review keeps explicit 2500 exception and automatic 1500 second fee');
create temporary table manual_retry_counts as select count(*) n from public.same_customer_earning_revisions;
select public.review_same_customer_manual_pay(request_id,group_id,revision,'TEST reviewed all group amounts') from manual_review_request;
select pg_temp.check_ok((select n=(select count(*) from public.same_customer_earning_revisions) from manual_retry_counts)
  and (select count(*)=1 from public.same_customer_manual_reviews),'manual review retry creates no audit or earning duplication');
do $$ declare r record; begin
  select * into r from manual_review_request;
  begin
    perform public.review_same_customer_manual_pay(r.request_id,r.group_id,r.revision,'TEST changed input');
    raise exception 'FAIL: review request reused with changed input'; exception when invalid_parameter_value then null;
  end;
  begin
    perform public.review_same_customer_manual_pay(gen_random_uuid(),r.group_id,r.revision,'TEST stale group');
    raise exception 'FAIL: stale group review accepted'; exception when serialization_failure then null;
  end;
  begin
    perform public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,'NaN'::numeric,'TEST invalid fee');
    raise exception 'FAIL: non-finite manual fee accepted'; exception when invalid_parameter_value then null;
  end;
end $$;

savepoint new_group_member;
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select pg_temp.complete_order(4,'manual-new-member-4');
select pg_temp.check_ok((select bool_and(pay_state='pending' and review_reason='manual_review') from public.same_customer_earnings where active)
  and (select manual_amount=2500 from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),
  'new successful delivery invalidates group acknowledgement without deleting the exception');
create temporary table clear_manual_request as select md5('clear-manual-1')::uuid request_id,delivery_id,revision
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
select public.clear_same_customer_manual_fee(request_id,delivery_id,revision,'TEST return to fixed rule') from clear_manual_request;
select pg_temp.check_ok((select sum(expected_amount)=6000 and bool_and(pay_state='ready') from public.same_customer_earnings where active),
  'clearing exception restores one full and two half fees');
select public.clear_same_customer_manual_fee(request_id,delivery_id,revision,'TEST return to fixed rule') from clear_manual_request;
select pg_temp.check_ok((select count(*)=1 from public.same_customer_fee_decisions where source='clear_exception')
  and (select agent_payment_snapshot=2500 from public.deliveries where id=md5('same-customer-order-1')::uuid),
  'clear retry is idempotent and shadow reset does not change current payable');
rollback to new_group_member;

savepoint manual_rate_mismatch;
update public.deliveries set agent_payment_base_snapshot=4000,agent_payment_base_captured_at=clock_timestamp()
  where id=md5('same-customer-order-2')::uuid;
do $$ declare g record; begin
  select * into g from public.same_customer_pay_groups where id=(select group_id from manual_review_request);
  begin
    perform public.review_same_customer_manual_pay(gen_random_uuid(),g.id,g.revision,'TEST cannot bypass rate mismatch');
    raise exception 'FAIL: manual review bypassed unequal normal rates'; exception when invalid_parameter_value then null;
  end;
end $$;
select pg_temp.check_ok((select bool_and(pay_state='pending' and review_reason='rate_mismatch') from public.same_customer_earnings where active),
  'manual acknowledgement cannot override unequal normal rates');
rollback to manual_rate_mismatch;

savepoint manual_redelivery;
select public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST reverse manually corrected success');
select pg_temp.complete_order(1,'manual-redelivery-1');
select pg_temp.check_ok((select manual_amount=2500 and manual_event_review and pay_state='pending'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),'new completion event preserves exception but requires renewed review');
rollback to manual_redelivery;

savepoint manual_identity_change;
select public.correct_delivery_customer_match(md5('manual-split-1')::uuid,'split',
  (select jsonb_agg(jsonb_build_object('id',id,'revision',same_customer_match_revision)) from public.deliveries
    where id=md5('same-customer-order-1')::uuid),'TEST different recipient context');
select pg_temp.check_ok((select manual_amount=2500 and pay_state='pending' and review_reason='manual_review'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),
  'splitting a reviewed manual exception into a single-order group needs renewed review');
rollback to manual_identity_change;

savepoint manual_settlement;
select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST settle manual correction');
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-1')::uuid;
do $$ declare e record; begin
  select * into e from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
  begin
    perform public.correct_delivery_charge(e.delivery_id,4000,2000,'TEST changed assignment cannot bypass settled rider');
    raise exception 'FAIL: successful rider settlement was bypassed'; exception when unique_violation then null;
  end;
  begin
    perform public.clear_same_customer_manual_fee(gen_random_uuid(),e.delivery_id,e.revision,'TEST settled clear');
    raise exception 'FAIL: cleared a settled exception'; exception when invalid_parameter_value then null;
  end;
end $$;
rollback to manual_settlement;

savepoint manual_before_completion;
select public.correct_delivery_charge(md5('same-customer-order-4')::uuid,4000,2600,'TEST exception before first success');
select pg_temp.complete_order(4,'manual-before-first-success');
select pg_temp.check_ok((select base_fee=3000 and manual_amount=2600 and expected_amount=2600 and pay_state='ready'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'exception entered before completion survives enrollment without becoming the baseline');
savepoint manual_day_change;
select public.review_same_customer_completion_day(md5('manual-day-change')::uuid,delivery_id,revision,business_date-1,'TEST revised day needs exception review')
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select manual_amount=2600 and pay_state='pending' and review_reason='manual_review'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'single-order manual exception needs review after its accepted day changes');
rollback to manual_day_change;
select public.revert_delivery_to_pending(md5('same-customer-order-4')::uuid,'TEST single manual redelivery');
select pg_temp.complete_order(4,'manual-single-redelivery');
select pg_temp.check_ok((select pay_state='pending' and review_reason='manual_review' and manual_event_review
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-4')::uuid),'single-order redelivery needs review of the earlier exception');
select public.review_same_customer_manual_pay(md5('manual-single-review')::uuid,g.id,g.revision,'TEST same exception still applies')
  from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id
  where e.delivery_id=md5('same-customer-order-4')::uuid;
select pg_temp.check_ok((select expected_amount=2600 and pay_state='ready' from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-4')::uuid),'single-order exception can be explicitly reviewed after redelivery');
rollback to manual_before_completion;

select set_config('request.jwt.claim.sub',md5('same-customer-user-dispatcher')::uuid::text,true);
do $$ begin
  begin
    perform public.get_same_customer_pay_group((select group_id from manual_review_request));
    raise exception 'FAIL: dispatcher read private pay group'; exception when insufficient_privilege then null;
  end;
  begin
    perform public.review_same_customer_manual_pay(gen_random_uuid(),(select group_id from manual_review_request),1,'TEST forbidden');
    raise exception 'FAIL: dispatcher reviewed pay'; exception when insufficient_privilege then null;
  end;
  begin
    perform public.clear_same_customer_manual_fee(gen_random_uuid(),md5('same-customer-order-1')::uuid,1,'TEST forbidden');
    raise exception 'FAIL: dispatcher cleared manual pay'; exception when insufficient_privilege then null;
  end;
end $$;
rollback to manual_fee_cases;
