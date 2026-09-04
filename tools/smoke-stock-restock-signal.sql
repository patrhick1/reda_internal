-- Smoke tests for stock_restock_signal (days-of-cover restock list).
-- Read-only; wrapped in a transaction that rolls back so it is safe on the box:
--   docker exec -i supabase-db psql -U postgres -d postgres < tools/smoke-stock-restock-signal.sql
--
-- Substitute the uuids below if those accounts change.
\set ON_ERROR_STOP off
begin;

\set admin '55898f73-b7d2-41b2-bac2-2b2318b04b14'
\set warehouse_staff 'b9d19685-49e4-48f5-9a64-57cdac8eb049'

-- 1 ---------------------------------------------------------------- ops read
set local request.jwt.claims = '{"sub":"55898f73-b7d2-41b2-bac2-2b2318b04b14","role":"authenticated"}';
set local role authenticated;
\echo '=== 1. admin: the action list (expect out first, then critical, then reorder) ==='
select tier, product_name, warehouse_qty, rate_per_day, days_cover
  from public.stock_restock_signal()
 where tier <> 'ok'
 order by days_cover, rate_per_day desc;

\echo '=== 2. invariants: tiers agree with days_cover and the lead time ==='
select
  count(*) filter (where tier = 'out'      and warehouse_qty > 0)                as bad_out,
  count(*) filter (where tier = 'critical' and (days_cover >= 1 or warehouse_qty <= 0)) as bad_critical,
  count(*) filter (where tier = 'reorder'  and (days_cover >= 3 or days_cover < 1))     as bad_reorder,
  count(*) filter (where tier = 'ok'       and days_cover < 3 and warehouse_qty > 0)    as bad_ok,
  count(*) filter (where rate_per_day <= 0)                                       as bad_rate,
  count(*) filter (where selling_days <= 0)                                       as bad_days
  from public.stock_restock_signal();
-- Every column above must be 0.

\echo '=== 3. lead time is a parameter: a longer lead must never shrink the list ==='
select (select count(*) from public.stock_restock_signal(28, 3) where tier <> 'ok') as at_3_days,
       (select count(*) from public.stock_restock_signal(28, 7) where tier <> 'ok') as at_7_days,
       (select count(*) from public.stock_restock_signal(28, 7) where tier <> 'ok')
       >= (select count(*) from public.stock_restock_signal(28, 3) where tier <> 'ok') as monotonic_ok;

\echo '=== 4. the flat 1-3 unit rule this replaces: how many of those are actually fine ==='
select count(*) filter (where warehouse_qty between 1 and 3 and tier = 'ok') as old_rule_false_alarms,
       count(*) filter (where warehouse_qty > 3 and tier <> 'ok')            as old_rule_misses
  from public.stock_restock_signal();

-- 5 -------------------------------------------------------- warehouse read
reset role;
set local request.jwt.claims = '{"sub":"b9d19685-49e4-48f5-9a64-57cdac8eb049","role":"authenticated"}';
set local role authenticated;
\echo '=== 5. warehouse staff can read it (expect a row count, not an error) ==='
select count(*) as rows_visible_to_warehouse from public.stock_restock_signal();

-- 6 ------------------------------------------------------------ agent denied
reset role;
\echo '=== 6. an agent must be refused (expect 42501 permission denied) ==='
select id as agent_used from public.users where role = 'agent' and is_active limit 1;
-- Re-run this block manually with that uuid; psql cannot SET from a subquery:
--   set local request.jwt.claims = '{"sub":"<agent-uuid>","role":"authenticated"}';
--   set local role authenticated;
--   select count(*) from public.stock_restock_signal();   -- expect 42501

reset role;
rollback;
