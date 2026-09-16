\ir same-customer-test-fixtures.sql
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=0,'disabled summary is empty');
update public.feature_flags set enabled=true where key='same_customer_discovery';
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'total_groups')::int=3
 and jsonb_array_length(public.list_same_customer_orders('2030-01-02',null,0)->'groups')=0
 and public.list_same_customer_orders('2030-01-02',null,0)->>'next_cursor' is null,'count-only includes every group without pages');
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=0,'same rider needs no attention');
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=2,'unassigned member flags exact and relevant alternate group');
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0,null,md5('same-customer-vendor-a')::uuid)->>'total_groups')::int=2
 and (public.list_same_customer_orders('2030-01-02',null,0,null,md5('same-customer-vendor-a')::uuid)->>'attention_groups')::int=2,'vendor filter retains whole-group assignment context');
select public.assign_same_customer_orders(md5('attention-assign')::uuid,array[md5('same-customer-order-1')::uuid],md5('same-customer-user-agent')::uuid);
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=0,'manual assignment clears alert');
insert into auth.users(id,email) values(md5('attention-second-agent')::uuid,'second@attention.example.invalid');
insert into public.users(id,email,display_name,role) values(md5('attention-second-agent')::uuid,'second@attention.example.invalid','Second test rider','agent');
update public.deliveries set assigned_agent_id=md5('attention-second-agent')::uuid where id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((select (g->>'needs_assignment')::boolean from jsonb_array_elements(public.list_same_customer_orders('2030-01-02')->'groups') g where g->>'match_kind'='primary'),'different riders flag group');
update public.deliveries set current_status='delivered',quantity_delivered=1 where id=md5('same-customer-order-1')::uuid;
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=2,'delivered plus open different rider still reviewable');
update public.deliveries set current_status='delivered',quantity_delivered=1;
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,0)->>'attention_groups')::int=0,'fully delivered groups do not need assignment review');
select pg_temp.check_ok((select bool_and(agent_payment_snapshot=3000 and charged_snapshot=4000) from public.deliveries),'attention never changes fees');
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
do $$ begin
 begin perform public.list_same_customer_orders('2030-01-02',null,0); raise exception 'FAIL: agent could read summary'; exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'PASS: count-only, full-group filters, unassigned/different riders, completed groups, assignment refresh and role protection' result;
