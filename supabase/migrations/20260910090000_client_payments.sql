-- Vendors sometimes settle what they owe Reda by bank transfer instead of
-- letting the debt net against their next remittance (SommyV and Remxx,
-- 2026-09-07/08). The ledger only knew money going OUT (client_payouts), so
-- the app kept insisting the vendor still owed, and Uzo redid the sums by hand.
--
-- This adds the mirror image: client_payments = money the vendor sent Reda.
--
--   * A payment reduces the vendor's debt on the day it arrived. The day-carry
--     rule is unchanged (only a negative close rolls into the next day), which
--     already yields the right outcome: the day closes at zero and the next
--     delivery is remitted in full.
--   * Cap (client_payment_limit): a payment may not exceed what the vendor could
--     legitimately be asked to pay on that day = debt carried into the day
--     + charges incurred that day - payments already recorded for that day.
--     The CLOSING balance is deliberately not the cap: a vendor who transfers
--     in the morning against yesterday's debt, and then has an evening delivery
--     that nets it, must still be recordable, otherwise the day's remit is
--     understated by exactly the transfer. Overpayments are refused outright:
--     recorded on a past day, a positive leftover would silently vanish at day
--     end under the carry rule.
--   * Same shape and rules as payouts: admin-only, idempotent on client_uuid,
--     date today-or-earlier and not before tracking started, voidable with a
--     reason, audited, and the opening balance locks once one exists.

begin;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.client_payments (
  id uuid primary key default gen_random_uuid(),
  client_uuid text not null unique,
  client_id uuid not null references public.clients(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
  balance_before numeric not null,
  balance_after numeric not null,
  note text,
  received_by uuid not null references public.users(id),
  received_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.users(id),
  void_reason text,
  created_at timestamptz not null default now()
);

create index if not exists client_payments_client_date_active
  on public.client_payments(client_id, payment_date, received_at)
  where voided_at is null;

alter table public.client_payments enable row level security;
revoke all on public.client_payments from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ledger: payments are a third event stream. The return shape gains
-- payments_in_period at the END so existing readers are unaffected; the
-- signature change forces a drop + create.
-- ---------------------------------------------------------------------------
drop function if exists public.client_account_balances(date, date);

create function public.client_account_balances(
  p_from date,
  p_to date
) returns table(
  client_id uuid,
  is_initialized boolean,
  effective_date date,
  configured_opening_balance numeric,
  balance_before_period numeric,
  period_activity numeric,
  payouts_in_period numeric,
  current_balance numeric,
  payments_in_period numeric
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'valid from/to dates required' using errcode = '22023';
  end if;

  return query
  with recursive openings as (
    select c.id as client_id, o.effective_date, o.opening_balance
      from public.clients c
      left join public.client_balance_openings o on o.client_id = c.id
  ), payout_events as (
    select p.client_id, p.payout_date as event_date, p.amount
      from public.client_payouts p
     where p.voided_at is null
    union all
    -- Before this ledger existed, a positive client settlement represented an
    -- actual bank transfer. Preserve it as a payout during incremental cutover.
    select s.subject_id, s.period_date, s.expected_amount
      from public.settlements s
     where s.subject_type = 'client'
       and s.voided_at is null
       and s.expected_amount > 0
  ), payment_events as (
    -- Money the vendor sent Reda. Reduces their debt on the day it arrived.
    select p.client_id, p.payment_date as event_date, p.amount
      from public.client_payments p
     where p.voided_at is null
  ), daily_events as (
    select
      e.client_id,
      e.event_date,
      sum(e.activity) as activity,
      sum(e.payout) as payout,
      sum(e.payment) as payment
    from (
      select a.client_id, a.activity_date as event_date,
             a.amount as activity, 0::numeric as payout, 0::numeric as payment
        from public.client_financial_activity a
        join openings o on o.client_id = a.client_id
       where o.effective_date is not null
         and a.activity_date between o.effective_date and p_to
      union all
      select pe.client_id, pe.event_date, 0::numeric, pe.amount, 0::numeric
        from payout_events pe
        join openings o on o.client_id = pe.client_id
       where o.effective_date is not null
         and pe.event_date between o.effective_date and p_to
      union all
      select pm.client_id, pm.event_date, 0::numeric, 0::numeric, pm.amount
        from payment_events pm
        join openings o on o.client_id = pm.client_id
       where o.effective_date is not null
         and pm.event_date between o.effective_date and p_to
    ) e
    group by e.client_id, e.event_date
  ), daily_ledger(client_id, balance_date, closing_balance) as (
    select
      o.client_id,
      o.effective_date,
      o.opening_balance
        + coalesce(e.activity, 0) - coalesce(e.payout, 0) + coalesce(e.payment, 0)
    from openings o
    left join daily_events e
      on e.client_id = o.client_id and e.event_date = o.effective_date
    where o.effective_date is not null and o.effective_date <= p_to

    union all

    -- Only a negative close carries: a positive close is paid out through the
    -- external Kuda batch the same evening.
    select
      l.client_id,
      l.balance_date + 1,
      least(l.closing_balance, 0)
        + coalesce(e.activity, 0) - coalesce(e.payout, 0) + coalesce(e.payment, 0)
    from daily_ledger l
    left join daily_events e
      on e.client_id = l.client_id and e.event_date = l.balance_date + 1
    where l.balance_date < p_to
  ), period_activity_totals as (
    select
      o.client_id,
      coalesce(sum(a.amount), 0) as amount
    from openings o
    left join public.client_financial_activity a
      on a.client_id = o.client_id
     and a.activity_date between greatest(o.effective_date, p_from) and p_to
    where o.effective_date <= p_to
    group by o.client_id
  ), period_payout_totals as (
    select
      o.client_id,
      coalesce(sum(pe.amount), 0) as amount
    from openings o
    left join payout_events pe
      on pe.client_id = o.client_id
     and pe.event_date between greatest(o.effective_date, p_from) and p_to
    where o.effective_date <= p_to
    group by o.client_id
  ), period_payment_totals as (
    select
      o.client_id,
      coalesce(sum(pm.amount), 0) as amount
    from openings o
    left join payment_events pm
      on pm.client_id = o.client_id
     and pm.event_date between greatest(o.effective_date, p_from) and p_to
    where o.effective_date <= p_to
    group by o.client_id
  )
  select
    o.client_id,
    (o.effective_date is not null and o.effective_date <= p_to),
    o.effective_date,
    case when o.effective_date <= p_to then o.opening_balance else null end,
    case
      when o.effective_date is null or o.effective_date > p_to then 0
      when o.effective_date = p_from then o.opening_balance
      when o.effective_date > p_from then 0
      else coalesce((
        select least(l.closing_balance, 0)
          from daily_ledger l
         where l.client_id = o.client_id and l.balance_date = p_from - 1
      ), 0)
    end,
    case when o.effective_date <= p_to then coalesce(a.amount, 0) else 0 end,
    case when o.effective_date <= p_to then coalesce(pt.amount, 0) else 0 end,
    case when o.effective_date <= p_to then coalesce((
      select l.closing_balance
        from daily_ledger l
       where l.client_id = o.client_id and l.balance_date = p_to
    ), 0) else 0 end,
    case when o.effective_date <= p_to then coalesce(pm.amount, 0) else 0 end
  from openings o
  left join period_activity_totals a on a.client_id = o.client_id
  left join period_payout_totals pt on pt.client_id = o.client_id
  left join period_payment_totals pm on pm.client_id = o.client_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- How much a vendor may pay Reda for a given day. Single source of truth for
-- the cap: record_client_payment enforces it, the app displays it.
--   debt carried into the day  (balance entering the day, if negative)
-- + charges incurred that day  (negative activity entries only: fee-heavy
--                               deliveries, replacement charges; the day's
--                               credits are NOT netted against them here)
-- - payments already recorded for that day
-- ---------------------------------------------------------------------------
create or replace function public.client_payment_limit(
  p_client_id uuid,
  p_date date
) returns numeric
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
declare
  v_opening_date date;
  v_before numeric;
  v_charges numeric;
  v_paid numeric;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_client_id is null or p_date is null then
    raise exception 'client and date required' using errcode = '22023';
  end if;

  select o.effective_date into v_opening_date
    from public.client_balance_openings o where o.client_id = p_client_id;
  if v_opening_date is null or p_date < v_opening_date then
    return 0;
  end if;

  select b.balance_before_period into v_before
    from public.client_account_balances(p_date, p_date) b
   where b.client_id = p_client_id;

  select coalesce(-sum(a.amount), 0) into v_charges
    from public.client_financial_activity a
   where a.client_id = p_client_id
     and a.activity_date = p_date
     and a.amount < 0;

  select coalesce(sum(p.amount), 0) into v_paid
    from public.client_payments p
   where p.client_id = p_client_id
     and p.payment_date = p_date
     and p.voided_at is null;

  return greatest(0, greatest(0, -coalesce(v_before, 0)) + v_charges - v_paid);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Record money received from the vendor.
-- ---------------------------------------------------------------------------
create or replace function public.record_client_payment(
  p_client_uuid text,
  p_client_id uuid,
  p_payment_date date,
  p_amount numeric,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing uuid;
  v_opening_date date;
  v_limit numeric;
  v_balance numeric;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'only admin can record client payments' using errcode = '42501';
  end if;
  if nullif(btrim(p_client_uuid), '') is null then
    raise exception 'client uuid required' using errcode = '22023';
  end if;
  if p_payment_date is null or p_payment_date > (now() at time zone 'Africa/Lagos')::date then
    raise exception 'payment date must be today or earlier' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'payment amount must be greater than zero' using errcode = '22023';
  end if;

  -- Same lock key as record_client_payout so the two directions serialize
  -- per client.
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));

  select p.id into v_existing from public.client_payments p
   where p.client_uuid = p_client_uuid;
  if v_existing is not null then return v_existing; end if;

  select o.effective_date into v_opening_date
    from public.client_balance_openings o where o.client_id = p_client_id;
  if v_opening_date is null then
    raise exception 'start balance tracking for this client first' using errcode = '22023';
  end if;
  if p_payment_date < v_opening_date then
    raise exception 'payment date cannot be before balance tracking starts' using errcode = '22023';
  end if;

  v_limit := public.client_payment_limit(p_client_id, p_payment_date);
  if v_limit <= 0 then
    raise exception 'nothing was owed on %; there is no debt to settle', p_payment_date
      using errcode = '22023';
  end if;
  if p_amount > v_limit + 0.005 then
    raise exception 'payment % exceeds the % the client owed on %', p_amount, v_limit, p_payment_date
      using errcode = '22023';
  end if;

  select b.current_balance into v_balance
    from public.client_account_balances(p_payment_date, p_payment_date) b
   where b.client_id = p_client_id;
  v_balance := coalesce(v_balance, 0);

  insert into public.client_payments(
    client_uuid, client_id, payment_date, amount, balance_before, balance_after,
    note, received_by
  ) values (
    p_client_uuid, p_client_id, p_payment_date, p_amount, v_balance,
    v_balance + p_amount, nullif(btrim(p_note), ''), v_actor
  ) returning id into v_id;

  perform public.write_audit(
    'client_payment', v_id, null,
    jsonb_build_object(
      'client_id', p_client_id,
      'payment_date', p_payment_date,
      'amount', p_amount,
      'balance_before', v_balance,
      'balance_after', v_balance + p_amount,
      'note', nullif(btrim(p_note), '')
    ), 'create'
  );
  return v_id;
end;
$function$;

create or replace function public.void_client_payment(
  p_payment_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row public.client_payments%rowtype;
begin
  if not public.is_admin() then
    raise exception 'only admin can void client payments' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'void reason required' using errcode = '22023';
  end if;
  select * into v_row from public.client_payments where id = p_payment_id for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if v_row.voided_at is not null then return; end if;

  update public.client_payments set
    voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
  where id = p_payment_id;

  perform public.write_audit(
    'client_payment', p_payment_id, to_jsonb(v_row),
    to_jsonb(v_row) || jsonb_build_object(
      'voided_at', now(), 'voided_by', v_actor, 'void_reason', btrim(p_reason)
    ), 'void'
  );
end;
$function$;

create or replace function public.list_client_payments(
  p_client_id uuid,
  p_from date,
  p_to date
) returns table(
  payment_id uuid,
  payment_date date,
  amount numeric,
  received_at timestamptz,
  received_by_name text,
  note text
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not public.is_admin() then
    raise exception 'only admin can view payment records' using errcode = '42501';
  end if;
  return query
  select p.id, p.payment_date, p.amount, p.received_at, u.display_name, p.note
    from public.client_payments p
    left join public.users u on u.id = p.received_by
   where p.client_id = p_client_id
     and p.payment_date between p_from and p_to
     and p.voided_at is null
   order by p.payment_date desc, p.received_at desc;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The opening balance locks once a payment exists, exactly as it does for a
-- payout: rewriting the cutover under a recorded transfer would misstate it.
-- ---------------------------------------------------------------------------
create or replace function public.set_client_balance_opening(
  p_request_uuid text,
  p_client_id uuid,
  p_effective_date date,
  p_opening_balance numeric,
  p_note text DEFAULT NULL::text
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing_request uuid;
  v_old jsonb;
begin
  if not public.is_admin() then
    raise exception 'only admin can configure client balances' using errcode = '42501';
  end if;
  if nullif(btrim(p_request_uuid), '') is null then
    raise exception 'request uuid required' using errcode = '22023';
  end if;
  if p_effective_date is null or p_effective_date > (now() at time zone 'Africa/Lagos')::date then
    raise exception 'effective date must be today or earlier' using errcode = '22023';
  end if;
  if p_opening_balance is null then
    raise exception 'opening balance required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id) then
    raise exception 'client not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));

  select o.client_id into v_existing_request
    from public.client_balance_openings o
   where o.setup_request_uuid = p_request_uuid;
  if v_existing_request is not null then
    if v_existing_request <> p_client_id then
      raise exception 'request uuid already belongs to another client' using errcode = '23505';
    end if;
    return v_existing_request;
  end if;

  if exists (
    select 1 from public.client_payouts p
     where p.client_id = p_client_id and p.voided_at is null
  ) or exists (
    select 1 from public.client_payments p
     where p.client_id = p_client_id and p.voided_at is null
  ) then
    raise exception 'opening balance is locked after the first ledger payout or payment'
      using errcode = '22023',
            hint = 'void the payout or payment first if the cutover was incorrect';
  end if;

  select to_jsonb(o) into v_old
    from public.client_balance_openings o where o.client_id = p_client_id;

  insert into public.client_balance_openings(
    client_id, effective_date, opening_balance, note,
    setup_request_uuid, set_by, updated_at
  ) values (
    p_client_id, p_effective_date, p_opening_balance, nullif(btrim(p_note), ''),
    p_request_uuid, v_actor, now()
  )
  on conflict (client_id) do update set
    effective_date = excluded.effective_date,
    opening_balance = excluded.opening_balance,
    note = excluded.note,
    setup_request_uuid = excluded.setup_request_uuid,
    set_by = excluded.set_by,
    updated_at = now();

  perform public.write_audit(
    'client_balance_opening', p_client_id, v_old,
    jsonb_build_object(
      'client_id', p_client_id,
      'effective_date', p_effective_date,
      'opening_balance', p_opening_balance,
      'note', nullif(btrim(p_note), '')
    ),
    case when v_old is null then 'create' else 'update' end
  );
  return p_client_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Grants. The box's default privileges hand EXECUTE to anon as well; the
-- functions gate on is_admin* internally, but there is no reason anon should
-- reach them at all.
-- ---------------------------------------------------------------------------
revoke execute on function public.client_account_balances(date, date) from public, anon;
grant execute on function public.client_account_balances(date, date) to authenticated, service_role;

revoke execute on function public.client_payment_limit(uuid, date) from public, anon;
grant execute on function public.client_payment_limit(uuid, date) to authenticated, service_role;

revoke execute on function public.record_client_payment(text, uuid, date, numeric, text) from public, anon;
grant execute on function public.record_client_payment(text, uuid, date, numeric, text)
  to authenticated, service_role;

revoke execute on function public.void_client_payment(uuid, text) from public, anon;
grant execute on function public.void_client_payment(uuid, text) to authenticated, service_role;

revoke execute on function public.list_client_payments(uuid, date, date) from public, anon;
grant execute on function public.list_client_payments(uuid, date, date) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
