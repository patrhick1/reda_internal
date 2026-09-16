-- Included after two successful same-customer completions in the shadow suite.
savepoint normal_fee_cases;
insert into public.locations(id,name) values
  (md5('normal-fee-equal-zone')::uuid,'TEST equal-rate zone'),
  (md5('normal-fee-higher-zone')::uuid,'TEST higher-rate zone');
insert into public.rate_card(location_id,charged,agent_payment) values
  (md5('same-customer-location')::uuid,4000,3000),
  (md5('normal-fee-equal-zone')::uuid,4000,3000),
  (md5('normal-fee-higher-zone')::uuid,5000,4000);

-- Emulate a future payout projection, without enabling financial activation.
create temporary table baseline_revision as select revision from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-2')::uuid;
update public.deliveries set agent_payment_snapshot=1500 where id=md5('same-customer-order-2')::uuid;
update public.deliveries set customer_name='TEST edited name' where id=md5('same-customer-order-2')::uuid;
select pg_temp.check_ok((select e.base_fee=3000 and e.expected_amount=1500 and d.agent_payment_base_snapshot=3000
  and e.revision=(select revision from baseline_revision)
  from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
  where e.delivery_id=md5('same-customer-order-2')::uuid),'projected half fee and unrelated edit cannot become the normal baseline or trigger recalculation');

select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
select pg_temp.check_ok((public.agent_change_delivery_location('normal-equal-zone',md5('same-customer-order-2')::uuid,
  md5('normal-fee-equal-zone')::uuid,'TEST same normal fee')->>'outcome')='applied','equal normal rate auto-applies even when projected payout is half');
select pg_temp.check_ok((select from_agent_payment=3000 from public.delivery_location_changes where client_uuid='normal-equal-zone'),
  'location reversion evidence stores the previous normal fee');
select pg_temp.check_ok((public.agent_change_delivery_location('normal-higher-zone',md5('same-customer-order-2')::uuid,
  md5('normal-fee-higher-zone')::uuid,'TEST higher normal fee')->>'outcome')='pending','higher normal rate still requires manager approval');
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
select public.approve_location_change(id,'TEST approve normal fee') from public.delivery_location_changes where client_uuid='normal-higher-zone';
select pg_temp.check_ok((select bool_and(pay_state='pending' and review_reason='rate_mismatch') from public.same_customer_earnings where active),
  'approved normal-rate change makes unequal group rates reviewable');
select public.revert_location_change(id,'TEST restore normal fee') from public.delivery_location_changes where client_uuid='normal-higher-zone';
select pg_temp.check_ok((select sum(expected_amount)=4500 and bool_and(pay_state='ready') from public.same_customer_earnings where active),
  'zone reversal restores the preserved normal rate and recalculates');

select public.correct_delivery_location(md5('same-customer-order-2')::uuid,md5('normal-fee-higher-zone')::uuid,'TEST admin normal rate');
select pg_temp.check_ok((select base_fee=4000 and review_reason='rate_mismatch' from public.same_customer_earnings
  where delivery_id=md5('same-customer-order-2')::uuid),'admin delivered-location correction updates normal baseline');
select public.correct_delivery_location(md5('same-customer-order-2')::uuid,md5('same-customer-location')::uuid,'TEST restore original zone');

-- Reversal keeps the original normal rate available for editing and rollover.
select public.revert_delivery_to_pending(md5('same-customer-order-2')::uuid,'TEST reverse for rollover');
update public.deliveries set agent_payment_snapshot=1500 where id=md5('same-customer-order-2')::uuid;
select public.acquire_edit_lock('delivery',md5('same-customer-order-2')::uuid);
select public.update_delivery_fields(p_delivery_id:=md5('same-customer-order-2')::uuid,p_customer_name:='TEST name-only edit');
select pg_temp.check_ok((select agent_payment_snapshot=1500 and agent_payment_base_snapshot=3000 from public.deliveries
  where id=md5('same-customer-order-2')::uuid),'name-only edit preserves both current payout and original normal rate');
select public.update_delivery_fields(p_delivery_id:=md5('same-customer-order-2')::uuid,p_location_id:=md5('normal-fee-higher-zone')::uuid);
select pg_temp.check_ok((select agent_payment_snapshot=4000 and agent_payment_base_snapshot=4000 from public.deliveries
  where id=md5('same-customer-order-2')::uuid),'pre-delivery rate resnapshot changes normal rate explicitly');
select public.update_delivery_fields(p_delivery_id:=md5('same-customer-order-2')::uuid,p_location_id:=md5('same-customer-location')::uuid);

select public.correct_delivery_customer_match(md5('normal-fee-split')::uuid,'split',
  (select jsonb_agg(jsonb_build_object('id',id,'revision',same_customer_match_revision)) from public.deliveries
    where id=md5('same-customer-order-2')::uuid),'TEST different recipient');
-- No location rate exists, so rollover must fall back to normal fee, not payout.
update public.deliveries set agent_payment_snapshot=1500,location_id=null where id=md5('same-customer-order-2')::uuid;
insert into public.delivery_status_transitions(from_status,to_status) values('pending','rolled_over');
select public.rollover_delivery('normal-fee-rollover',md5('same-customer-order-2')::uuid,date '2030-01-04','TEST rollover',false);
select pg_temp.check_ok((select child.agent_payment_snapshot=3000 and child.agent_payment_base_snapshot=3000
  and child.same_customer_key_override=parent.same_customer_key_override and child.same_customer_match_mode='separate'
  and child.assigned_agent_id is null and child.current_status='pending'
  from public.deliveries child join public.deliveries parent on parent.id=child.parent_delivery_id
  where parent.id=md5('same-customer-order-2')::uuid),'rollover preserves resolved identity and normal fee without assigning a rider');
select public.rollover_delivery('normal-fee-rollover',md5('same-customer-order-2')::uuid,date '2030-01-04','TEST rollover',false);
select pg_temp.check_ok((select count(*)=1 from public.deliveries where parent_delivery_id=md5('same-customer-order-2')::uuid),
  'rollover retry creates no duplicate child');

-- A NULL normal fee is an explicit data error, never a reason to read payout.
update public.deliveries set agent_payment_base_snapshot=null,agent_payment_base_captured_at=clock_timestamp()
  where id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select base_fee is null and pay_state='pending' and review_reason='rate_mismatch'
  from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid),'captured NULL normal fee cannot silently fall back to payout');

grant usage on schema public,auth to authenticated;
grant select,update on public.deliveries to authenticated;
set local role authenticated;
do $$ begin
  begin
    perform public._same_customer_has_earning(md5('same-customer-order-1')::uuid);
    raise exception 'FAIL: private earning helper was callable outside a trigger';
  exception when insufficient_privilege then null; end;
  begin
    update public.deliveries set agent_payment_base_snapshot=1 where id=md5('same-customer-order-1')::uuid;
    raise exception 'FAIL: direct normal-fee edit bypassed authorized correction';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback to normal_fee_cases;
