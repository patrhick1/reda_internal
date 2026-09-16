\ir same-customer-test-fixtures.sql
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02')->>'total_groups')::integer=0,'feature defaults off');
update public.feature_flags set enabled=true where key='same_customer_discovery';
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02')->>'total_groups')::integer=3,'one exact group and two alternate candidates');
select pg_temp.check_ok((select count(*)=3 from public._same_customer_day_orders('2030-01-02')),'duplicate race copy collapsed');
select pg_temp.check_ok((select (g->>'order_count')::int=2 and (g->>'vendor_count')::int=2
  from jsonb_array_elements(public.list_same_customer_orders('2030-01-02')->'groups') g where g->>'match_kind'='primary'),
  'different vendor/product/name/address still match on primary phone');
select pg_temp.check_ok((select (g->>'matching_order_count')::int=1 and (g->>'order_count')::int=2
  from jsonb_array_elements(public.list_same_customer_orders('2030-01-02',null,50,null,md5('same-customer-vendor-a')::uuid)->'groups') g
  where g->>'match_kind'='primary'),'vendor filter does not hide other group member');
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-03')->>'total_groups')::int=0,'days remain separate');
savepoint forwarded_copy;
update public.deliveries set text_fingerprint='same-forward' where id in(md5('same-customer-order-2')::uuid,md5('same-customer-order-3')::uuid);
update public.deliveries set raw_address='Different parsed address' where id=md5('same-customer-order-3')::uuid;
select pg_temp.check_ok((select count(*)=3 from public._same_customer_day_orders('2030-01-02')),'matching forwarded text collapses copies with different addresses');
rollback to forwarded_copy;
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02',null,1)->>'next_cursor') is not null,'pagination returns cursor');
select pg_temp.check_ok(jsonb_array_length(public.list_same_customer_orders('2030-01-02',
  public.list_same_customer_orders('2030-01-02',null,1)->>'next_cursor',50)->'groups')=2,'cursor advances without dropped/duplicated groups');

do $$ declare gid text; details jsonb; orders jsonb; response jsonb; begin
  select g->>'group_id' into gid from jsonb_array_elements(public.list_same_customer_orders('2030-01-02')->'groups') g
    where g->>'match_kind'='primary';
  details:=public.get_same_customer_orders('2030-01-02',gid);
  perform pg_temp.check_ok(jsonb_array_length(details->'orders')=2,'group detail hydrates both orders');
  select jsonb_agg(jsonb_build_object('id',o->>'id','revision',(o->>'revision')::bigint)) into orders
    from jsonb_array_elements(details->'orders') o;
  response:=public.correct_delivery_customer_match(md5('split-request')::uuid,'split',orders,'Shared family number');
  perform pg_temp.check_ok(response=public.correct_delivery_customer_match(md5('split-request')::uuid,'split',orders,'Shared family number'),'safe idempotent retry');
  perform pg_temp.check_ok(not exists(select 1 from public._same_customer_day_groups('2030-01-02') where match_kind='primary'),'split removes financial identity match');
  perform pg_temp.check_ok(public.get_same_customer_orders('2030-01-02','order:'||(orders->0->>'id'))->>'match_kind'='single',
    'split order remains reachable from detail for correction reset');
  begin
    perform public.correct_delivery_customer_match(md5('new-stale-request')::uuid,'link',orders,'Stale correction');
    raise exception 'FAIL: stale revision accepted';
  exception when serialization_failure then null; end;
  select jsonb_agg(jsonb_build_object('id',d.id,'revision',d.same_customer_match_revision)) into orders
    from public.deliveries d where d.id in(select (o->>'id')::uuid from jsonb_array_elements(orders) o);
  perform public.correct_delivery_customer_match(md5('link-request')::uuid,'link',orders,'Confirmed same recipient');
  perform pg_temp.check_ok(exists(select 1 from public._same_customer_day_groups('2030-01-02') where match_kind='linked'),'explicit link creates a group');
end $$;

savepoint stale_contact;
do $$ declare orders jsonb; begin
  select jsonb_build_array(jsonb_build_object('id',id,'revision',same_customer_match_revision)) into orders
    from public.deliveries where id=md5('same-customer-order-1')::uuid;
  update public.deliveries set customer_phone='09098765432' where id=md5('same-customer-order-1')::uuid;
  begin
    perform public.correct_delivery_customer_match(gen_random_uuid(),'split',orders,'Old contact form');
    raise exception 'FAIL: stale contact correction accepted';
  exception when serialization_failure then null; end;
end $$;
rollback to stale_contact;

savepoint reset_match;
do $$ declare orders jsonb; begin
  select jsonb_agg(jsonb_build_object('id',id,'revision',same_customer_match_revision)) into orders
    from public.deliveries where same_customer_match_mode='linked';
  perform public.correct_delivery_customer_match(gen_random_uuid(),'reset',orders,'Restore phone matching');
  perform pg_temp.check_ok(exists(select 1 from public._same_customer_day_groups('2030-01-02') where match_kind='primary'),
    'reset restores automatic phone matching');
end $$;
rollback to reset_match;

select set_config('request.jwt.claim.sub',md5('same-customer-user-dispatcher')::uuid::text,true);
select pg_temp.check_ok((select bool_and(o->>'agent_payment' is null)
  from public._same_customer_day_groups('2030-01-02') g
  cross join lateral jsonb_array_elements(public.get_same_customer_orders('2030-01-02',g.group_id)->'orders') o),
  'dispatcher does not gain admin-only financial fields');
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
do $$ begin
  begin perform public.list_same_customer_orders('2030-01-02'); raise exception 'FAIL: rider read ops groups';
  exception when insufficient_privilege then null; end;
  begin perform public.same_customer_badges(array[md5('same-customer-order-1')::uuid]); raise exception 'FAIL: rider read cross-rider badges';
  exception when insufficient_privilege then null; end;
end $$;

select pg_temp.check_ok((select bool_and(agent_payment_snapshot=3000 and charged_snapshot=4000 and customer_price=10000
  and current_status='pending' and assigned_agent_id=md5('same-customer-user-agent')::uuid) from public.deliveries),
  'discovery and identity changes do not mutate assignments, status or money');
select pg_temp.check_ok(not exists(select 1 from public.stock_adjustments),'discovery creates no stock movements');
select pg_temp.check_ok(not (select enabled from public.feature_flags where key='enable_auto_assign'),'auto assignment remains off');

-- Exercise manager assignment and inspect every skipped row. The savepoint
-- restores operational fixtures before the outer transaction rolls back.
savepoint assignment_cases;
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
update public.deliveries set assigned_agent_id=null where id=md5('same-customer-order-1')::uuid;
update public.deliveries set current_status='cancelled' where id=md5('same-customer-order-4')::uuid;
do $$ declare ids uuid[]; result jsonb; begin
  ids:=array[md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid,
    md5('same-customer-order-4')::uuid,md5('missing-order')::uuid];
  result:=public.assign_same_customer_orders(md5('assign-request')::uuid,ids,md5('same-customer-user-agent')::uuid);
  perform pg_temp.check_ok((result->>'updated_count')::int=1,'only explicitly selected eligible order assigned');
  perform pg_temp.check_ok((select count(distinct o->>'outcome')=4 from jsonb_array_elements(result->'orders') o),
    'assigned, already assigned, closed and unavailable outcomes are all reported');
  perform pg_temp.check_ok(result=public.assign_same_customer_orders(md5('assign-request')::uuid,ids,md5('same-customer-user-agent')::uuid),
    'assignment retry returns original result');
end $$;
rollback to assignment_cases;

select set_config('request.jwt.claim.sub',md5('same-customer-user-rep')::uuid::text,true);
select pg_temp.check_ok(jsonb_array_length(public.same_customer_badges(array[md5('same-customer-order-1')::uuid]))=1,'rep can read batched badges');
do $$ begin
  begin perform public.assign_same_customer_orders(gen_random_uuid(),array[md5('same-customer-order-1')::uuid],md5('same-customer-user-agent')::uuid);
    raise exception 'FAIL: rep assigned orders'; exception when insufficient_privilege then null; end;
  begin perform public.correct_delivery_customer_match(gen_random_uuid(),'split','[]','Forbidden');
    raise exception 'FAIL: rep corrected identity'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub',md5('same-customer-user-warehouse')::uuid::text,true);
do $$ begin
  begin perform public.list_same_customer_orders('2030-01-02');
    raise exception 'FAIL: warehouse read customer groups'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.check_ok(not has_function_privilege('anon','public.list_same_customer_orders(date,text,integer,uuid,uuid,text)','EXECUTE'), 'anonymous API access revoked');
select pg_temp.check_ok(not has_function_privilege('authenticated','public._same_customer_day_orders(date)','EXECUTE'), 'private matching adapter inaccessible');

savepoint api_permissions;
-- The schema-only dump excludes ACLs. Exercise the same authenticated entry
-- role with table UPDATE available, so a broad legacy grant cannot bypass audit.
grant usage on schema public,auth to authenticated;
grant select,update on public.deliveries to authenticated;
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
set local role authenticated;
select pg_temp.check_ok((public.list_same_customer_orders('2030-01-02')->>'total_groups')::int>0,'authenticated manager executes public API');
do $$ begin
  begin
    update public.deliveries set same_customer_key_override=gen_random_uuid() where id=md5('same-customer-order-1')::uuid;
    raise exception 'FAIL: direct table update bypassed identity audit';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback to api_permissions;

savepoint scale_case;
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
-- 2,500 synthetic rows is >10x the inspected 30-day average (7,483 / 30).
-- Unique item sets prevent accidental sibling copies in this load fixture.
insert into public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,raw_address,
 quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,scheduled_date,items_fingerprint)
select md5('scale-order-'||n)::uuid,md5('same-customer-vendor-a')::uuid,md5('same-customer-product-1')::uuid,
 'Scale recipient '||n,'080'||lpad(((n-1)/2)::text,8,'0'),'Scale address '||n,
 1,10000,3000,4000,date '2030-01-05','scale-items-'||n from generate_series(1,2500) n;
analyze public.deliveries;
do $$ declare started timestamptz; elapsed_ms numeric; timings numeric[]:='{}'; page jsonb; begin
  for attempt in 1..10 loop
    started:=clock_timestamp(); page:=public.list_same_customer_orders('2030-01-05');
    elapsed_ms:=extract(epoch from clock_timestamp()-started)*1000;
    timings:=array_append(timings,elapsed_ms);
    perform pg_temp.check_ok((page->>'total_groups')::int=1250 and jsonb_array_length(page->'groups')=50,
      'complete counts with paged results at 10x daily volume');
  end loop;
  select percentile_disc(0.95) within group(order by v) into elapsed_ms from unnest(timings) v;
  raise notice 'Discovery p95 over 10 local calls, 2,500 rows: % ms',elapsed_ms;
  perform pg_temp.check_ok(elapsed_ms<300,'local discovery p95 below initial 300ms target');
end $$;
rollback to scale_case;
rollback;
do $$ begin
  if exists(select 1 from public.deliveries) or exists(select 1 from public.users)
    or exists(select 1 from public.same_customer_decisions) or exists(select 1 from public.same_customer_assignment_requests) then
    raise exception 'Test fixtures were not rolled back';
  end if;
end $$;
select 'PASS: discovery, duplicate handling, pagination, filters, corrections, permissions, and rollback' as result;
