-- Run after loading tools/live-defs/client_balance_ledger.sql in the SAME
-- transaction. Uses one existing admin/client, writes only transactional fixture
-- rows, asserts the ledger invariants, then rolls everything back.
\set ON_ERROR_STOP on

begin;

do $$
declare v_missing integer;
begin
  select count(*) into v_missing
    from public.clients c
    left join public.client_balance_openings o on o.client_id = c.id
   where o.client_id is null;
  if v_missing <> 0 then
    raise exception 'automatic balance tracking missing for % clients', v_missing;
  end if;
  raise notice 'PASS: every existing client has balance tracking enabled';
end $$;

select id as test_admin_id from public.users
 where role = 'admin' and is_active
 order by created_at limit 1 \gset
select id as test_client_id from public.clients
 order by is_active desc, created_at limit 1 \gset
insert into public.clients(name)
values ('__client_balance_rollover_smoke__')
returning id as rollover_client_id \gset

select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'test_admin_id', 'role', 'authenticated')::text,
  true
);
select set_config('x.test_client_id', :'test_client_id', true);
set local role authenticated;
select set_config('x.rollover_client_id', :'rollover_client_id', true);

-- A positive daily balance is assumed paid through the external Kuda batch and
-- must not enter the next day. A negative balance must enter the next day.
select public.set_client_balance_opening(
  'smoke-rollover-positive',
  :'rollover_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date - 1,
  1000,
  'rollback-only positive reset smoke'
);

do $$
declare v_before numeric; v_current numeric;
begin
  select balance_before_period, current_balance into v_before, v_current
    from public.client_account_balances(
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) where client_id = current_setting('x.rollover_client_id')::uuid;
  if v_before <> 0 or v_current <> 0 then
    raise exception 'positive rollover expected 0/0, got %/%', v_before, v_current;
  end if;
  raise notice 'PASS: positive daily balance resets after the Kuda payout day';
end $$;

select public.set_client_balance_opening(
  'smoke-rollover-negative',
  :'rollover_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date - 1,
  -2000,
  'rollback-only negative rollover smoke'
);

do $$
declare v_before numeric; v_current numeric;
begin
  select balance_before_period, current_balance into v_before, v_current
    from public.client_account_balances(
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) where client_id = current_setting('x.rollover_client_id')::uuid;
  if v_before <> -2000 or v_current <> -2000 then
    raise exception 'negative rollover expected -2000/-2000, got %/%', v_before, v_current;
  end if;
  raise notice 'PASS: negative daily balance carries into the next day';
end $$;

-- First configure zero, then use the security-definer balance RPC to normalize
-- for any production activity/legacy payout already on the chosen client/day.
select public.set_client_balance_opening(
  'smoke-opening-baseline',
  :'test_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date,
  0,
  'rollback-only baseline smoke'
);
select current_balance as baseline_balance
  from public.client_account_balances(
    (now() at time zone 'Africa/Lagos')::date,
    (now() at time zone 'Africa/Lagos')::date
  ) where client_id = :'test_client_id'::uuid \gset

select public.set_client_balance_opening(
  'smoke-opening-negative',
  :'test_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date,
  -2000 - :'baseline_balance'::numeric,
  'rollback-only negative carry smoke'
);

do $$
declare v numeric;
begin
  select current_balance into v
    from public.client_account_balances(
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) where client_id = current_setting('x.test_client_id')::uuid;
  if v <> -2000 then raise exception 'negative carry expected -2000, got %', v; end if;
  raise notice 'PASS: negative balance carries and remains non-payable (%)', v;

  begin
    perform public.record_client_payout(
      'smoke-not-due', current_setting('x.test_client_id')::uuid,
      (now() at time zone 'Africa/Lagos')::date, 1, null
    );
    raise exception 'negative balance payout unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: payout is blocked while the client owes Reda';
  end;
end $$;

-- Reconfigure before any payout by adding 9,500 to the opening. This models a
-- -2,000 carry followed by +9,500 activity without depending on the selected
-- production client's particular deliveries.
select configured_opening_balance as negative_opening
  from public.client_account_balances(
    (now() at time zone 'Africa/Lagos')::date,
    (now() at time zone 'Africa/Lagos')::date
  ) where client_id = :'test_client_id'::uuid \gset

select public.set_client_balance_opening(
  'smoke-opening-positive',
  :'test_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date,
  :'negative_opening'::numeric + 9500,
  'rollback-only positive carry smoke'
);

select public.record_client_payout(
  'smoke-partial-payout', :'test_client_id'::uuid,
  (now() at time zone 'Africa/Lagos')::date, 5000, 'partial payout smoke'
) as payout_id \gset
select set_config('x.test_payout_id', :'payout_id', true);

do $$
declare v numeric; v_count integer; v_same uuid;
begin
  select current_balance into v
    from public.client_account_balances(
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) where client_id = current_setting('x.test_client_id')::uuid;
  if v <> 2500 then raise exception 'partial payout residual expected 2500, got %', v; end if;
  raise notice 'PASS: partial payout leaves the correct residual (%)', v;

  select public.record_client_payout(
    'smoke-partial-payout', current_setting('x.test_client_id')::uuid,
    (now() at time zone 'Africa/Lagos')::date, 5000, 'retry'
  ) into v_same;
  select count(*) into v_count
    from public.list_client_payouts(
      current_setting('x.test_client_id')::uuid,
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) p where p.payout_id = v_same;
  if v_same <> current_setting('x.test_payout_id')::uuid or v_count <> 1 then
    raise exception 'idempotent retry failed: id %, count %', v_same, v_count;
  end if;
  raise notice 'PASS: retry is idempotent and cannot double-pay';

  begin
    perform public.record_client_payout(
      'smoke-overpay', current_setting('x.test_client_id')::uuid,
      (now() at time zone 'Africa/Lagos')::date, 2501, null
    );
    raise exception 'overpayment unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: overpayment is rejected server-side';
  end;

  begin
    perform public.set_client_balance_opening(
      'smoke-rewrite-after-payout', current_setting('x.test_client_id')::uuid,
      (now() at time zone 'Africa/Lagos')::date, 0, null
    );
    raise exception 'opening rewrite unexpectedly succeeded after payout';
  exception when sqlstate '22023' then
    raise notice 'PASS: opening is locked while a payout exists';
  end;
end $$;

select public.void_client_payout(:'payout_id'::uuid, 'rollback smoke reversal');

do $$
declare v numeric;
begin
  select current_balance into v
    from public.client_account_balances(
      (now() at time zone 'Africa/Lagos')::date,
      (now() at time zone 'Africa/Lagos')::date
    ) where client_id = current_setting('x.test_client_id')::uuid;
  if v <> 7500 then raise exception 'void should restore 7500, got %', v; end if;
  raise notice 'PASS: voiding a payout restores the client balance (%)', v;
end $$;

reset role;
rollback;
