-- Live-schema smoke test. All submissions/audit entries roll back. No inventory
-- movement, user, or product is created, changed, or deleted.
\set ON_ERROR_STOP on
begin;
set local statement_timeout = '30s';
select id as test_agent from public.users where role='agent' and is_active
  and display_name='Test Agent' limit 1 \gset
select id as test_dispatcher from public.users where role='dispatcher' and is_active
  and display_name='Test Dispatcher' limit 1 \gset
select u.id as stocked_agent from public.users u where u.role='agent' and u.is_active
  and exists(select 1 from public.current_stock s where s.agent_id=u.id and s.quantity_on_hand<>0)
  and u.id <> :'test_agent'::uuid order by u.id limit 1 \gset
select set_config('count_test.agent', :'test_agent', true);
select set_config('count_test.dispatcher', :'test_dispatcher', true);
select set_config('count_test.stocked_agent', :'stocked_agent', true);
select set_config('count_test.empty_batch', gen_random_uuid()::text, true);
select set_config('count_test.stock_batch', gen_random_uuid()::text, true);
select set_config('count_test.before_rows', count(*)::text, true) from public.stock_counts;
select set_config('count_test.before_submissions', count(*)::text, true) from public.agent_stock_count_submissions;
select set_config('count_test.expected', coalesce(jsonb_object_agg(product_catalog_id::text,quantity_on_hand),'{}')::text,true)
  from public.current_stock where agent_id=:'stocked_agent'::uuid and quantity_on_hand<>0;
select set_config('count_test.items',jsonb_agg(jsonb_build_object('product_catalog_id',product_catalog_id,
  'counted_qty',greatest(quantity_on_hand,0)))::text,true)
  from public.current_stock where agent_id=:'stocked_agent'::uuid and quantity_on_hand<>0;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'test_agent', true);
do $$
declare today date := (now() at time zone 'Africa/Lagos')::date; week date; result jsonb;
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  result := public.record_agent_stock_count(current_setting('count_test.empty_batch')::uuid,week,'[]','{}','rollback-only live smoke',true);
  assert (result->>'recorded')::integer=0;
  assert exists(select 1 from public.list_stock_count_batches_v2() where batch_id=current_setting('count_test.empty_batch')::uuid), 'no-stock submission missing from history';
  begin
    perform public.list_weekly_agent_stock_counts(week);
    raise exception 'Agent accessed operations checklist';
  exception when sqlstate '42501' then null; end;
  raise notice 'PASS live: no-stock confirmation, agent history, operations access restriction';
end $$;

select set_config('request.jwt.claim.sub', :'stocked_agent', true);
do $$
declare
  today date := (now() at time zone 'Africa/Lagos')::date; week date;
  expected jsonb := current_setting('count_test.expected')::jsonb;
  items jsonb := current_setting('count_test.items')::jsonb;
  result jsonb; retry jsonb;
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,'[]',expected,null,true);
    raise exception 'Partial count accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,items,'{}',null,false);
    raise exception 'Stale stock snapshot accepted';
  exception when sqlstate '40001' then null; end;
  -- Deliberate discrepancy in the rollback-only report, never a stock change.
  items := jsonb_set(items,'{0,counted_qty}',to_jsonb((items->0->>'counted_qty')::integer+1));
  result := public.record_agent_stock_count(current_setting('count_test.stock_batch')::uuid,week,items,expected,'rollback-only live smoke',false);
  assert (result->>'recorded')::integer=jsonb_array_length(items);
  assert (result->>'off')::integer>0;
  retry := public.record_agent_stock_count(current_setting('count_test.stock_batch')::uuid,week,items,expected,'retry',false);
  assert retry=result, 'retry returned a different receipt';
  assert (select count(*) from public.list_stock_count_items(current_setting('count_test.stock_batch')::uuid))=jsonb_array_length(items);
  assert not exists(select 1 from public.list_stock_count_batches_v2() where holder_id<>auth.uid()), 'history leaked another holder';
  assert not exists(select 1 from public.list_stock_count_items(current_setting('count_test.empty_batch')::uuid)), 'detail leaked another holder';
  raise notice 'PASS live: full stock count, discrepancies, incomplete/stale rejection, retry and history isolation';
end $$;

select set_config('request.jwt.claim.sub', :'test_dispatcher', true);
do $$
declare today date := (now() at time zone 'Africa/Lagos')::date; week date;
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  assert exists(select 1 from public.list_weekly_agent_stock_counts(week) where batch_id=current_setting('count_test.empty_batch')::uuid and items_count=0);
  assert exists(select 1 from public.list_weekly_agent_stock_counts(week) where batch_id=current_setting('count_test.stock_batch')::uuid and off_count>0);
  assert (select count(*) from public.list_stock_count_batches_v2(p_week_ending=>week)
    where batch_id in (current_setting('count_test.empty_batch')::uuid,current_setting('count_test.stock_batch')::uuid))=2;
  assert exists(select 1 from public.list_stock_count_batches_v2() where week_ending is null), 'legacy count history missing';
  assert exists(select 1 from public.list_weekly_agent_stock_counts(week) where batch_id is null), 'remaining agents missing';
  raise notice 'PASS live: dispatcher checklist, submitted-with-differences, remaining agents and combined history';
end $$;
reset role;
do $$
declare expected jsonb;
begin
  select coalesce(jsonb_object_agg(product_catalog_id::text,quantity_on_hand),'{}') into expected
  from public.current_stock where agent_id=current_setting('count_test.stocked_agent')::uuid and quantity_on_hand<>0;
  assert expected=current_setting('count_test.expected')::jsonb, 'Stock unexpectedly changed';
  raise notice 'PASS live: inventory unchanged. Rolling back every test submission and audit entry.';
end $$;
rollback;
select count(*) as persisted_submissions from public.agent_stock_count_submissions;
select count(*) as existing_count_rows from public.stock_counts;
