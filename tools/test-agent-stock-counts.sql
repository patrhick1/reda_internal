-- Integration test: run ONLY in an empty disposable PostgreSQL database.
-- Creates a minimal fixture of Reda's existing tables/functions, installs the
-- actual migration, and exercises its public API under authenticated roles.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() not like 'reda_count_tests%' then
    raise exception 'Run only in a disposable database named reda_count_tests…';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated;
create table public.users(id uuid primary key, role text, is_active boolean default true,
  display_name text, warehouse_id uuid, created_at timestamptz default '2026-01-01');
create table public.product_catalog(id uuid primary key, product_name text, is_active boolean default true);
create table public.current_stock(agent_id uuid, product_catalog_id uuid, quantity_on_hand integer);
create function public.is_admin_or_dispatcher() returns boolean language sql stable security definer as $$
  select coalesce((select role in ('admin','dispatcher','rep') from public.users where id = auth.uid()), false)
$$;
create function public.is_warehouse() returns boolean language sql stable security definer as $$
  select coalesce((select role = 'warehouse' from public.users where id = auth.uid()), false)
$$;
create function public.write_audit(text,uuid,jsonb,jsonb,text,uuid) returns void language sql as $$ select $$;
\ir live-defs/stock_counts.sql
\ir ../supabase/migrations/20260903120000_agent_weekly_stock_counts.sql

insert into public.users(id,role,display_name) values
 ('00000000-0000-0000-0000-000000000001','agent','Agent A'),
 ('00000000-0000-0000-0000-000000000002','agent','Agent B'),
 ('00000000-0000-0000-0000-000000000003','dispatcher','Dispatcher'),
 ('00000000-0000-0000-0000-000000000004','agent','Agent Pending');
insert into public.product_catalog(id,product_name) values
 ('10000000-0000-0000-0000-000000000001','Product A'),
 ('10000000-0000-0000-0000-000000000002','Product B'),
 ('10000000-0000-0000-0000-000000000003','Unexpected product');
insert into public.current_stock values
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',5),
 ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',-2);

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
do $$
declare
  today date := (now() at time zone 'Africa/Lagos')::date;
  week date;
  receipt jsonb;
  retry jsonb;
  expected jsonb := '{"10000000-0000-0000-0000-000000000001":5,"10000000-0000-0000-0000-000000000002":-2}';
  items jsonb := '[{"product_catalog_id":"10000000-0000-0000-0000-000000000001","counted_qty":4},{"product_catalog_id":"10000000-0000-0000-0000-000000000002","counted_qty":0},{"product_catalog_id":"10000000-0000-0000-0000-000000000003","counted_qty":1}]';
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,'[]',expected,null,true);
    raise exception 'FAIL partial count accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,items,'{}',null,false);
    raise exception 'FAIL stale stock accepted';
  exception when sqlstate '40001' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week-7,items,expected,null,false);
    raise exception 'FAIL old week accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,items||items,expected,null,false);
    raise exception 'FAIL duplicate product accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,jsonb_set(items,'{0,counted_qty}','-1'),expected,null,false);
    raise exception 'FAIL negative physical count accepted';
  exception when sqlstate '22023' then null; end;
  receipt := public.record_agent_stock_count('20000000-0000-0000-0000-000000000001',week,items,expected,'Missing one unit',false);
  assert (receipt->>'recorded')::integer = 3 and (receipt->>'off')::integer = 3, 'variance/coverage incorrect';
  retry := public.record_agent_stock_count('20000000-0000-0000-0000-000000000001',week-7,'[]','{}',null,false);
  assert retry = receipt, 'retry did not return original receipt';
  assert (select count(*) = 3 from public.stock_counts), 'duplicate count rows';
  assert (select count(*) = 1 from public.list_stock_count_batches_v2()), 'self history missing';
  assert (select count(*) = 3 from public.list_stock_count_items('20000000-0000-0000-0000-000000000001')), 'detail missing';
  begin
    perform public.list_stock_count_batches_v2(p_holder_id => '00000000-0000-0000-0000-000000000002');
    raise exception 'FAIL another agent history accessible';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.list_weekly_agent_stock_counts(week);
    raise exception 'FAIL agent accessed operations checklist';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.record_stock_count(gen_random_uuid(),'00000000-0000-0000-0000-000000000002',items,null);
    raise exception 'FAIL agent used legacy count writer';
  exception when sqlstate '42501' then null; end;
  raise notice 'PASS: complete coverage, variances, unexpected products, retries, week boundaries, permissions';
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
do $$
declare today date := (now() at time zone 'Africa/Lagos')::date; week date; receipt jsonb;
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  assert (select count(*) = 0 from public.stock_counts), 'RLS leaked another agent counts';
  assert (select count(*) = 0 from public.list_stock_count_items('20000000-0000-0000-0000-000000000001')), 'detail leaked another agent counts';
  begin
    perform public.record_agent_stock_count('20000000-0000-0000-0000-000000000001',week,'[]','{}',null,true);
    raise exception 'FAIL batch theft';
  exception when sqlstate '42501' then null; end;
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,'[]','{}',null,false);
    raise exception 'FAIL no-stock without confirmation';
  exception when sqlstate '22023' then null; end;
  receipt := public.record_agent_stock_count('20000000-0000-0000-0000-000000000002',week,'[]','{}',null,true);
  assert (receipt->>'recorded')::integer = 0;
  assert (select count(*) = 1 from public.list_stock_count_batches_v2()), 'empty count absent from history';
  raise notice 'PASS: zero-stock confirmations persist; another agent cannot read or overwrite counts';
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
do $$
declare today date := (now() at time zone 'Africa/Lagos')::date; week date;
begin
  week := today - ((extract(dow from today)::integer+1)%7);
  -- Legacy partial counts remain valid but do not fulfil weekly self-counts.
  perform public.record_stock_count('20000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',
    '[{"product_catalog_id":"10000000-0000-0000-0000-000000000001","counted_qty":0}]',null);
  assert (select count(*) = 3 from public.list_stock_count_batches_v2()), 'combined history incorrect';
  assert (select count(*) = 2 from public.list_stock_count_batches_v2(p_week_ending => week)), 'weekly history includes partial count';
  assert (select count(*) = 3 from public.list_weekly_agent_stock_counts(week)), 'roster incorrect';
  assert (select count(*) = 2 from public.list_weekly_agent_stock_counts(week) where batch_id is not null), 'completion incorrect';
  assert (select count(*) = 1 from public.list_weekly_agent_stock_counts(week) where batch_id is null), 'pending missing';
  assert (select bool_and(is_late = (today > week)) from public.list_weekly_agent_stock_counts(week) where batch_id is not null), 'late classification incorrect';
  assert (select count(*) = 1 from public.list_stock_count_batches_v2(p_limit => 1)), 'pagination limit';
  begin
    perform public.record_agent_stock_count(gen_random_uuid(),week,'[]','{}',null,true);
    raise exception 'FAIL dispatcher impersonated agent';
  exception when sqlstate '42501' then null; end;
  raise notice 'PASS: operations checklist, legacy partial counts, combined history and late status';
end $$;
reset role;
do $$ begin
  assert (select sum(quantity_on_hand) = 3 from public.current_stock), 'count altered stock';
  assert not has_function_privilege('anon','public.record_agent_stock_count(uuid,date,jsonb,jsonb,text,boolean)','execute'), 'anon write permission';
  raise notice 'PASS: report-only and anonymous access blocked';
end $$;
