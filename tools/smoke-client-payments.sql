-- Smoke test for client_payments (vendor pays Reda what they owe). Run AFTER
-- applying supabase/migrations/20260910090000_client_payments.sql, or in the
-- SAME transaction as a dry run of it. Creates two throwaway vendors with one
-- delivered delivery each (inserted directly as postgres, so no stock moves),
-- acts as the first active admin, asserts the ledger + cap invariants, and
-- rolls everything back.
--
--   Vendor A: owed 2,500 entering today, and delivered 3,000 today. Models the
--             "morning transfer, evening delivery" case: the day already closes
--             positive, but the transfer must still be recordable up to the
--             carried debt, and today's remit must then be the full 3,000.
--   Vendor B: no carried debt; a fee-heavy delivery today puts them 2,500 in the
--             red. Models SommyV: the charge is settled the same day it arose.
\set ON_ERROR_STOP on

begin;

select (now() at time zone 'Africa/Lagos')::date as today \gset
select id as admin_id from public.users
 where role = 'admin' and is_active order by created_at limit 1 \gset

insert into public.clients(name) values ('__client_payment_smoke_a__') returning id as client_a \gset
insert into public.clients(name) values ('__client_payment_smoke_b__') returning id as client_b \gset

-- Delivered rows feed client_financial_activity directly; no agent, no stock.
-- The ledger keys on client_id only, so any active product satisfies the
-- delivery-shape check constraint.
select id as any_product from public.product_catalog where is_active order by created_at limit 1 \gset
insert into public.deliveries(
  client_id, product_catalog_id, customer_name, customer_phone, raw_address,
  quantity_ordered, quantity_delivered, customer_price,
  paid, charged_snapshot, cash_pos_fee_snapshot,
  current_status, scheduled_date, order_type
) values
  (:'client_a', :'any_product', 'Smoke Payment A', '0800 000 0001', '1 Smoke Street',
   1, 1, 3000, 3000, 0, 0, 'delivered', :'today', 'delivery'),
  (:'client_b', :'any_product', 'Smoke Payment B', '0800 000 0002', '2 Smoke Street',
   1, 1, 3000, 3000, 5500, 0, 'delivered', :'today', 'delivery');

select set_config('request.jwt.claims',
  json_build_object('sub', :'admin_id', 'role', 'authenticated')::text, true);
select set_config('x.client_a', :'client_a', true);
select set_config('x.client_b', :'client_b', true);
select set_config('x.today', :'today', true);
set local role authenticated;

-- Vendor A owed 2,500 entering yesterday; nothing happened yesterday, so the
-- debt carries into today.
select public.set_client_balance_opening(
  'smoke-pay-opening-a', :'client_a'::uuid, :'today'::date - 1, -2500, 'rollback-only'
);

do $$
declare
  v_a uuid := current_setting('x.client_a')::uuid;
  v_b uuid := current_setting('x.client_b')::uuid;
  d date := current_setting('x.today')::date;
  v_before numeric; v_cur numeric; v_limit numeric;
begin
  select balance_before_period, current_balance into v_before, v_cur
    from public.client_account_balances(d, d) where client_id = v_a;
  if v_before <> -2500 or v_cur <> 500 then
    raise exception 'fixture A: expected -2500 carried / +500 closing, got %/%', v_before, v_cur;
  end if;
  raise notice 'PASS: fixture A — 2,500 debt carried in, +3,000 delivery, day closes +500';

  select balance_before_period, current_balance into v_before, v_cur
    from public.client_account_balances(d, d) where client_id = v_b;
  if v_before <> 0 or v_cur <> -2500 then
    raise exception 'fixture B: expected 0 carried / -2500 closing, got %/%', v_before, v_cur;
  end if;
  raise notice 'PASS: fixture B — no carry, fee-heavy delivery puts vendor 2,500 in the red';

  -- The cap is the debt the vendor could be asked for on that day, NOT the
  -- closing balance (which is already positive for A).
  v_limit := public.client_payment_limit(v_a, d);
  if v_limit <> 2500 then raise exception 'limit A: expected 2500, got %', v_limit; end if;
  v_limit := public.client_payment_limit(v_b, d);
  if v_limit <> 2500 then raise exception 'limit B: expected 2500, got %', v_limit; end if;
  v_limit := public.client_payment_limit(v_a, d - 1);
  if v_limit <> 2500 then raise exception 'limit A yesterday: expected 2500, got %', v_limit; end if;
  v_limit := public.client_payment_limit(v_a, d - 2);
  if v_limit <> 0 then raise exception 'limit A before tracking: expected 0, got %', v_limit; end if;
  raise notice 'PASS: limit = carried debt (A) / same-day charge (B); 0 before tracking starts';

  begin
    perform public.record_client_payment('smoke-pay-over', v_a, d, 2501, null);
    raise exception 'overpayment unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: overpayment refused';
  end;
  begin
    perform public.record_client_payment('smoke-pay-future', v_a, d + 1, 100, null);
    raise exception 'future-dated payment unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: future date refused';
  end;
  begin
    perform public.record_client_payment('smoke-pay-early', v_a, d - 2, 100, null);
    raise exception 'payment before tracking start unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: date before tracking start refused';
  end;
  begin
    perform public.record_client_payment('smoke-pay-zero', v_a, d, 0, null);
    raise exception 'zero payment unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: zero amount refused';
  end;
end $$;

select public.record_client_payment(
  'smoke-pay-a', :'client_a'::uuid, :'today'::date, 2500, 'smoke transfer A'
) as pay_a \gset
select set_config('x.pay_a', :'pay_a', true);
select public.record_client_payment(
  'smoke-pay-b', :'client_b'::uuid, :'today'::date, 2500, 'smoke transfer B'
) as pay_b \gset

do $$
declare
  v_a uuid := current_setting('x.client_a')::uuid;
  v_b uuid := current_setting('x.client_b')::uuid;
  d date := current_setting('x.today')::date;
  v_before numeric; v_cur numeric; v_pay numeric; v_out numeric;
  v_same uuid; v_n integer;
begin
  select current_balance, payments_in_period, payouts_in_period into v_cur, v_pay, v_out
    from public.client_account_balances(d, d) where client_id = v_a;
  if v_cur <> 3000 or v_pay <> 2500 or v_out <> 0 then
    raise exception 'A after payment: expected 3000 / 2500 paid / 0 payouts, got % / % / %', v_cur, v_pay, v_out;
  end if;
  raise notice 'PASS: A — transfer clears the carried debt; today remits the full 3,000';

  select current_balance, payments_in_period into v_cur, v_pay
    from public.client_account_balances(d, d) where client_id = v_b;
  if v_cur <> 0 or v_pay <> 2500 then
    raise exception 'B after payment: expected 0 / 2500 paid, got % / %', v_cur, v_pay;
  end if;
  raise notice 'PASS: B — same-day charge settled; balance is clear';

  -- Nothing carries into tomorrow for either vendor.
  select balance_before_period into v_before
    from public.client_account_balances(d + 1, d + 1) where client_id = v_a;
  if v_before <> 0 then raise exception 'A tomorrow should carry 0, got %', v_before; end if;
  select balance_before_period into v_before
    from public.client_account_balances(d + 1, d + 1) where client_id = v_b;
  if v_before <> 0 then raise exception 'B tomorrow should carry 0, got %', v_before; end if;
  raise notice 'PASS: nothing carries into tomorrow';

  -- A multi-day range reports the payment once and still nets correctly.
  select balance_before_period, current_balance, payments_in_period into v_before, v_cur, v_pay
    from public.client_account_balances(d - 1, d) where client_id = v_a;
  if v_before <> -2500 or v_cur <> 3000 or v_pay <> 2500 then
    raise exception 'A two-day range: expected -2500 / 3000 / 2500, got % / % / %', v_before, v_cur, v_pay;
  end if;
  raise notice 'PASS: two-day range shows the opening debt, the payment, and the full remit';

  -- Debt settled: the cap is now zero and a second payment is refused.
  if public.client_payment_limit(v_a, d) <> 0 then
    raise exception 'limit A after payment should be 0';
  end if;
  begin
    perform public.record_client_payment('smoke-pay-a2', v_a, d, 1, null);
    raise exception 'second payment unexpectedly succeeded';
  exception when sqlstate '22023' then
    raise notice 'PASS: no further payment once the debt is settled';
  end;

  -- Idempotent retry (offline queue replay) returns the same row.
  select public.record_client_payment('smoke-pay-a', v_a, d, 2500, 'retry') into v_same;
  select count(*) into v_n from public.list_client_payments(v_a, d, d);
  if v_same <> current_setting('x.pay_a')::uuid or v_n <> 1 then
    raise exception 'idempotent retry failed: id %, count %', v_same, v_n;
  end if;
  raise notice 'PASS: retry is idempotent and cannot double-record';

  -- The record itself carries the ledger position it was booked against.
  select count(*) into v_n from public.list_client_payments(v_a, d, d) p
   where p.amount = 2500 and p.note = 'smoke transfer A' and p.received_by_name is not null;
  if v_n <> 1 then raise exception 'listed payment row is wrong'; end if;
  raise notice 'PASS: payment lists with amount, note and who recorded it';

  -- The opening balance is locked while a payment exists.
  begin
    perform public.set_client_balance_opening('smoke-pay-relock', v_a, d, 0, null);
    raise exception 'opening rewrite unexpectedly succeeded with a payment on file';
  exception when sqlstate '22023' then
    raise notice 'PASS: opening is locked while a payment exists';
  end;

  -- Payouts still see the payment: A can now be paid out the full 3,000.
  perform public.record_client_payout('smoke-payout-a', v_a, d, 3000, 'kuda');
  select current_balance into v_cur
    from public.client_account_balances(d, d) where client_id = v_a;
  if v_cur <> 0 then raise exception 'payout after payment: expected 0, got %', v_cur; end if;
  raise notice 'PASS: payout of the full 3,000 is accepted after the payment';
  perform public.void_client_payout(
    (select payout_id from public.list_client_payouts(v_a, d, d) limit 1), 'smoke undo'
  );

  -- Void needs a reason; voiding restores the debt and the cap.
  begin
    perform public.void_client_payment(current_setting('x.pay_a')::uuid, '  ');
    raise exception 'blank void reason accepted';
  exception when sqlstate '22023' then
    raise notice 'PASS: blank void reason refused';
  end;
end $$;

select public.void_client_payment(:'pay_a'::uuid, 'rollback smoke reversal');

do $$
declare
  v_a uuid := current_setting('x.client_a')::uuid;
  d date := current_setting('x.today')::date;
  v_cur numeric; v_pay numeric; v_n integer;
begin
  select current_balance, payments_in_period into v_cur, v_pay
    from public.client_account_balances(d, d) where client_id = v_a;
  if v_cur <> 500 or v_pay <> 0 then
    raise exception 'void should restore +500 / 0 paid, got % / %', v_cur, v_pay;
  end if;
  if public.client_payment_limit(v_a, d) <> 2500 then
    raise exception 'void should restore the 2500 cap';
  end if;
  select count(*) into v_n from public.list_client_payments(v_a, d, d);
  if v_n <> 0 then raise exception 'voided payment still listed'; end if;
  raise notice 'PASS: voiding restores the debt, the cap, and drops the row from the list';

  -- Voiding twice is a no-op, not an error.
  perform public.void_client_payment(current_setting('x.pay_a')::uuid, 'again');
  raise notice 'PASS: second void is a no-op';

  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_client_payment', 'void_client_payment',
                       'list_client_payments', 'client_payment_limit',
                       'client_account_balances')
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v_n <> 5 then
    raise exception 'grants: expected 5 functions executable by authenticated and not anon, got %', v_n;
  end if;
  raise notice 'PASS: grants — authenticated yes, anon no';
end $$;

-- Non-admin callers are refused at the door.
reset role;
select id as dispatcher_id from public.users
 where role = 'dispatcher' and is_active order by created_at limit 1 \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'dispatcher_id', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  v_b uuid := current_setting('x.client_b')::uuid;
  d date := current_setting('x.today')::date;
  v_limit numeric;
begin
  -- Dispatchers may READ the cap (they see the reconcile screen)…
  v_limit := public.client_payment_limit(v_b, d);
  -- …but may not record or void.
  begin
    perform public.record_client_payment('smoke-pay-disp', v_b, d, 1, null);
    raise exception 'dispatcher recorded a payment';
  exception when sqlstate '42501' then
    raise notice 'PASS: dispatcher cannot record a payment';
  end;
  begin
    perform public.void_client_payment(current_setting('x.pay_a')::uuid, 'nope');
    raise exception 'dispatcher voided a payment';
  exception when sqlstate '42501' then
    raise notice 'PASS: dispatcher cannot void a payment';
  end;
end $$;

reset role;
rollback;
