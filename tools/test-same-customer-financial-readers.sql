\ir same-customer-pay-test-fixtures.sql
select pg_temp.check_ok((select count(*)=1 and bool_and(mode='legacy' and state='legacy' and amount=3000 and margin=1000)
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid,md5('same-customer-order-1')::uuid])),
  'unenrolled delivery metadata preserves legacy amounts and deduplicates ids');
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date;
select public.change_delivery_status(p_client_uuid:='reader-complete-'||n,p_delivery_id:=md5('same-customer-order-'||n)::uuid,
  p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=now())
from generate_series(1,2) n;
select pg_temp.check_ok((select total_earnings=4500 and known_earnings=4500 and total_remit=15500 and pending_pay_count=0
  from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')),'reader uses canonical full and half earnings');
select pg_temp.check_ok((select total_earnings=4500 from public.agent_earnings_summary('2000-01-01','2100-01-01')),
  'legacy summary receives confirmed canonical amounts');
select pg_temp.check_ok((select sum(amount)=4500 and sum(margin)=3500 and bool_and(mode='final' and state='ready')
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid])),
  'delivery metadata agrees with final earnings and admin margins');
savepoint reversed_metadata;
select public.revert_delivery_to_pending(md5('same-customer-order-1')::uuid,'TEST reversed pay display');
select pg_temp.check_ok((select state='reversed' and amount is null and margin is null
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid])),
  'reversed earnings do not present a projected ordinary fee as earned');
rollback to reversed_metadata;
savepoint negative_margin_metadata;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,2000,3000,'TEST final margin review');
select pg_temp.check_ok((public.get_negative_margin_delivery_ids()->>'total_count')::int=1
  and public.get_negative_margin_delivery_ids()->'delivery_ids' @> to_jsonb(array[md5('same-customer-order-1')::uuid]),
  'negative margin lookup includes confirmed losses');
select pg_temp.check_ok((public.get_negative_margin_delivery_ids(0)->>'total_count')::int=1
  and public.get_negative_margin_delivery_ids(0)->'delivery_ids'='[]'::jsonb,
  'attention count avoids transferring delivery ids');
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,2000,5000,'TEST pending manual margin');
select pg_temp.check_ok((public.get_negative_margin_delivery_ids()->>'total_count')::int=0,
  'pending provisional fee is excluded from confirmed negative margins');
rollback to negative_margin_metadata;
select pg_temp.check_ok((select public.get_same_customer_shadow_pay(md5('same-customer-order-2')::uuid)->>'mode'='final'),
  'review endpoint identifies actual payable mode');
savepoint pending_reader;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST reader manual exception');
select pg_temp.check_ok((select total_earnings is null and total_remit is null and known_earnings=0 and pending_pay_count=2
  and total_collected=20000 from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')),
  'pending is null rather than zero or a provisional payable snapshot');
select pg_temp.check_ok((select bool_and(state='pending' and amount is null and margin is null)
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid])),
  'pending detail amounts and margins never expose provisional money');
select pg_temp.check_ok((select p->>'mode'='final' and p->>'state'='pending' and p->>'current_payable_amount' is null
  from (select public.get_same_customer_shadow_pay(md5('same-customer-order-1')::uuid) p) x),
  'review endpoint never labels a pending provisional amount as payable');
select pg_temp.check_ok((select p->>'mode'='final' and p->'orders'->0->>'current_payable' is null
  from (select public.get_same_customer_pay_group(group_id) p from public.same_customer_earnings
    where delivery_id=md5('same-customer-order-1')::uuid) x),'manual review group identifies live changes and pending pay');
do $$ begin
  perform public.agent_earnings_summary('2000-01-01','2100-01-01');
  raise exception 'FAIL legacy client accepted pending totals';
exception when sqlstate 'P0001' then
  if sqlerrm not like 'Rider pay needs review.%' then raise; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
select pg_temp.check_ok((select count(*)=2 and bool_and(agent_payment_snapshot is null and pay_state='pending')
  from public.list_my_earnings_v2('2000-01-01','2100-01-01')),'own pending rows remain visible');
reset role;
rollback to pending_reader;

-- Mutable assignment never changes the successful rider's summary or detail.
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-1')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
select pg_temp.check_ok((select count(*)=2 and sum(agent_payment_snapshot)=4500
  from public.list_my_earnings_v2('2000-01-01','2100-01-01')),'successful rider still sees the reassigned earning');
select pg_temp.check_ok((select deliveries_count=2 and total_earnings=4500
  from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')),'own summary agrees with detail');
create temporary table reader_first_page as select * from public.list_my_earnings_v2('2000-01-01','2100-01-01',null,null,1);
select pg_temp.check_ok((select count(*)=1 from reader_first_page) and
  (select count(*)=1 from reader_first_page a cross join lateral
    public.list_my_earnings_v2('2000-01-01','2100-01-01',a.scheduled_date,a.id,1) b where a.id<>b.id),
  'detail keyset pagination returns every earning once');
select pg_temp.check_ok((select state='ready' and amount=3000 and margin is null
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid])),
  'successful rider sees only their earning and never the admin margin');
reset role;
insert into auth.users(id,email) values(md5('reader-second-agent')::uuid,'second-reader@example.invalid');
insert into public.users(id,email,display_name,role) values(md5('reader-second-agent')::uuid,'second-reader@example.invalid','TEST second rider','agent');
update public.deliveries set assigned_agent_id=md5('reader-second-agent')::uuid where id=md5('same-customer-order-1')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',md5('reader-second-agent')::uuid::text,true);
select pg_temp.check_ok((select state='not_earned' and amount is null and margin is null and business_date is null and multiplier is null
  from public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid])),
  'new assigned rider cannot see or claim the successful rider earning');
select pg_temp.check_ok(not exists(select 1 from public.get_delivery_pay_state(array[md5('same-customer-order-2')::uuid,md5('unknown-delivery')::uuid])),
  'unrelated and unknown ids disclose no payment records');
do $$ begin
  perform public.get_delivery_pay_state(array_fill(md5('same-customer-order-1')::uuid,array[501]));
  raise exception 'FAIL oversized pay lookup accepted';
exception when invalid_parameter_value then null; end $$;
select set_config('request.jwt.claim.sub',md5('same-customer-user-rep')::uuid::text,true);
select pg_temp.check_ok(not exists(select 1 from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')),
  'rep cannot read rider financial totals');
do $$ begin
  perform public.list_my_earnings_v2('2000-01-01','2100-01-01');
  raise exception 'FAIL rep read rider details';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.get_negative_margin_delivery_ids();
  raise exception 'FAIL rep read negative margins';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public.get_delivery_pay_state(array[md5('same-customer-order-1')::uuid]);
  raise exception 'FAIL rep read payment metadata';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform public._same_customer_financial_rows('2000-01-01','2100-01-01');
  raise exception 'FAIL private rows accessible';
exception when insufficient_privilege then null; end $$;
reset role;
rollback;
select 'PASS: canonical financial summaries, pending totals, legacy guard, own details, roles and pagination' result;
