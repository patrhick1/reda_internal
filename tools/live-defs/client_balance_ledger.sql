-- ============================================================================
-- Client remittance balance ledger
-- ============================================================================
-- Positive balance: Reda owes the client.
-- Negative balance: the client owes Reda (for example a standalone pickup).
--
-- This is intentionally separate from delivery rows. Deliveries and replacement
-- attempts remain immutable accounting events; payouts are independent money
-- movements. That lets a negative day carry into the next positive day and also
-- supports partial payouts without mutating historical delivery figures.
--
-- Existing positive client settlements on/after a client's effective date are
-- treated as legacy payouts. This makes adoption incremental and prevents an
-- already-recorded transfer from becoming payable again at cutover.
-- ============================================================================

begin;

create table if not exists public.client_balance_openings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  effective_date date not null,
  opening_balance numeric not null default 0,
  note text,
  setup_request_uuid text not null unique,
  -- Null means the opening was created automatically by the system cutover or
  -- the new-client trigger. Admin-configured openings retain their actor.
  set_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_payouts (
  id uuid primary key default gen_random_uuid(),
  client_uuid text not null unique,
  client_id uuid not null references public.clients(id),
  payout_date date not null,
  amount numeric not null check (amount > 0),
  balance_before numeric not null,
  balance_after numeric not null,
  note text,
  paid_by uuid not null references public.users(id),
  paid_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.users(id),
  void_reason text,
  created_at timestamptz not null default now()
);

create index if not exists client_payouts_client_date_active
  on public.client_payouts(client_id, payout_date, paid_at)
  where voided_at is null;

create index if not exists deliveries_client_ledger_activity
  on public.deliveries(client_id, scheduled_date)
  where current_status = 'delivered' and deleted_at is null;

create index if not exists replacement_attempts_ledger_activity
  on public.replacement_attempts(attempted_at, delivery_id);

alter table public.client_balance_openings enable row level security;
alter table public.client_payouts enable row level security;
-- Older installations required an admin actor. Automatic initialization is a
-- system action, so make the audit actor optional before backfilling.
alter table public.client_balance_openings alter column set_by drop not null;
revoke all on public.client_balance_openings from anon, authenticated;
revoke all on public.client_payouts from anon, authenticated;

-- Balance tracking is automatic for every client. August 24, 2026 is the
-- ledger cutover: earlier financial activity remains in the legacy books, while
-- activity from this date onward carries until it is paid out. Existing manual
-- openings are deliberately preserved.
insert into public.client_balance_openings(
  client_id, effective_date, opening_balance, note, setup_request_uuid, set_by
)
select
  c.id,
  greatest(
    date '2026-08-24',
    (coalesce(c.created_at, now()) at time zone 'Africa/Lagos')::date
  ),
  0,
  'Automatically enabled at the client balance ledger cutover',
  'auto:' || c.id::text,
  null
from public.clients c
on conflict (client_id) do nothing;

create or replace function public.tg_auto_initialize_client_balance()
returns trigger
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
begin
  insert into public.client_balance_openings(
    client_id, effective_date, opening_balance, note, setup_request_uuid, set_by
  ) values (
    new.id,
    greatest(
      date '2026-08-24',
      (coalesce(new.created_at, now()) at time zone 'Africa/Lagos')::date
    ),
    0,
    'Automatically enabled when the client was created',
    'auto:' || new.id::text,
    null
  )
  on conflict (client_id) do nothing;
  return new;
end;
$function$;

drop trigger if exists clients_auto_initialize_balance on public.clients;
create trigger clients_auto_initialize_balance
after insert on public.clients
for each row execute function public.tg_auto_initialize_client_balance();

-- A single normalized stream is the source of truth for the running balance.
-- Replacement delivery envelopes never reach `delivered`; the explicit filter
-- also protects against a future status change double-counting their attempts.
create or replace view public.client_financial_activity as
select
  d.client_id,
  d.scheduled_date as activity_date,
  'delivery'::text as entry_type,
  d.id as entry_id,
  coalesce(d.paid, 0)
    - coalesce(d.charged_snapshot, 0)
    - coalesce(d.cash_pos_fee_snapshot, 0) as amount
from public.deliveries d
where d.current_status = 'delivered'
  and d.deleted_at is null
  and coalesce(d.order_type, 'delivery') <> 'replacement'
union all
select
  d.client_id,
  (a.attempted_at at time zone 'Africa/Lagos')::date,
  'replacement_attempt'::text,
  a.id,
  -coalesce(a.client_charge, 0)
from public.replacement_attempts a
join public.deliveries d on d.id = a.delivery_id
where d.deleted_at is null;

revoke all on public.client_financial_activity from anon, authenticated;

-- One row per client, including clients with no activity in the selected range.
-- `balance_before_period` is the carry entering the requested period;
-- `current_balance` is the balance after activity and payouts through p_to.
create or replace function public.client_account_balances(
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
  current_balance numeric
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
  with openings as (
    select c.id as client_id, o.effective_date, o.opening_balance
      from public.clients c
      left join public.client_balance_openings o on o.client_id = c.id
  ), activity_totals as (
    select
      o.client_id,
      coalesce(sum(a.amount) filter (where a.activity_date < p_from), 0) as before_period,
      coalesce(sum(a.amount) filter (
        where a.activity_date >= greatest(o.effective_date, p_from)
      ), 0) as in_period
    from openings o
    left join public.client_financial_activity a
      on a.client_id = o.client_id
     and a.activity_date >= o.effective_date
     and a.activity_date <= p_to
    where o.effective_date <= p_to
    group by o.client_id
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
  ), payout_totals as (
    select
      o.client_id,
      coalesce(sum(pe.amount) filter (where pe.event_date < p_from), 0) as before_period,
      coalesce(sum(pe.amount) filter (
        where pe.event_date >= greatest(o.effective_date, p_from)
      ), 0) as in_period
    from openings o
    left join payout_events pe
      on pe.client_id = o.client_id
     and pe.event_date >= o.effective_date
     and pe.event_date <= p_to
    where o.effective_date <= p_to
    group by o.client_id
  )
  select
    o.client_id,
    (o.effective_date is not null and o.effective_date <= p_to),
    o.effective_date,
    case when o.effective_date <= p_to then o.opening_balance else null end,
    case when o.effective_date <= p_to
      then o.opening_balance + coalesce(a.before_period, 0) - coalesce(pt.before_period, 0)
      else 0 end,
    case when o.effective_date <= p_to then coalesce(a.in_period, 0) else 0 end,
    case when o.effective_date <= p_to then coalesce(pt.in_period, 0) else 0 end,
    case when o.effective_date <= p_to
      then o.opening_balance + coalesce(a.before_period, 0) - coalesce(pt.before_period, 0)
           + coalesce(a.in_period, 0) - coalesce(pt.in_period, 0)
      else 0 end
  from openings o
  left join activity_totals a on a.client_id = o.client_id
  left join payout_totals pt on pt.client_id = o.client_id;
end;
$function$;

-- Start (or adjust, before the first new-ledger payout) a client's balance.
-- opening_balance is the signed amount at the START of effective_date.
create or replace function public.set_client_balance_opening(
  p_request_uuid text,
  p_client_id uuid,
  p_effective_date date,
  p_opening_balance numeric,
  p_note text default null
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
  ) then
    raise exception 'opening balance is locked after the first ledger payout'
      using errcode = '22023', hint = 'void the payout first if the cutover was incorrect';
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

-- Record the actual amount sent. Partial payouts are valid; the unpaid balance
-- remains visible. The advisory lock plus client_uuid prevents concurrent or
-- retried taps from overpaying a client.
create or replace function public.record_client_payout(
  p_client_uuid text,
  p_client_id uuid,
  p_payout_date date,
  p_amount numeric,
  p_note text default null
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing uuid;
  v_opening_date date;
  v_balance numeric;
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'only admin can record client payouts' using errcode = '42501';
  end if;
  if nullif(btrim(p_client_uuid), '') is null then
    raise exception 'client uuid required' using errcode = '22023';
  end if;
  if p_payout_date is null or p_payout_date > (now() at time zone 'Africa/Lagos')::date then
    raise exception 'payout date must be today or earlier' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'payout amount must be greater than zero' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text, 0));

  select p.id into v_existing from public.client_payouts p
   where p.client_uuid = p_client_uuid;
  if v_existing is not null then return v_existing; end if;

  select o.effective_date into v_opening_date
    from public.client_balance_openings o where o.client_id = p_client_id;
  if v_opening_date is null then
    raise exception 'start balance tracking for this client first' using errcode = '22023';
  end if;
  if p_payout_date < v_opening_date then
    raise exception 'payout date cannot be before balance tracking starts' using errcode = '22023';
  end if;

  select b.current_balance into v_balance
    from public.client_account_balances(p_payout_date, p_payout_date) b
   where b.client_id = p_client_id;
  v_balance := coalesce(v_balance, 0);
  if v_balance <= 0 then
    raise exception 'no payout is due; the balance is %', v_balance using errcode = '22023';
  end if;
  if p_amount > v_balance + 0.005 then
    raise exception 'payout % exceeds the available balance %', p_amount, v_balance
      using errcode = '22023';
  end if;

  insert into public.client_payouts(
    client_uuid, client_id, payout_date, amount, balance_before, balance_after,
    note, paid_by
  ) values (
    p_client_uuid, p_client_id, p_payout_date, p_amount, v_balance,
    v_balance - p_amount, nullif(btrim(p_note), ''), v_actor
  ) returning id into v_id;

  perform public.write_audit(
    'client_payout', v_id, null,
    jsonb_build_object(
      'client_id', p_client_id,
      'payout_date', p_payout_date,
      'amount', p_amount,
      'balance_before', v_balance,
      'balance_after', v_balance - p_amount,
      'note', nullif(btrim(p_note), '')
    ), 'create'
  );
  return v_id;
end;
$function$;

create or replace function public.void_client_payout(
  p_payout_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row public.client_payouts%rowtype;
begin
  if not public.is_admin() then
    raise exception 'only admin can void client payouts' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'void reason required' using errcode = '22023';
  end if;
  select * into v_row from public.client_payouts where id = p_payout_id for update;
  if not found then raise exception 'payout not found' using errcode = 'P0002'; end if;
  if v_row.voided_at is not null then return; end if;

  update public.client_payouts set
    voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
  where id = p_payout_id;

  perform public.write_audit(
    'client_payout', p_payout_id, to_jsonb(v_row),
    to_jsonb(v_row) || jsonb_build_object(
      'voided_at', now(), 'voided_by', v_actor, 'void_reason', btrim(p_reason)
    ), 'void'
  );
end;
$function$;

create or replace function public.list_client_payouts(
  p_client_id uuid,
  p_from date,
  p_to date
) returns table(
  payout_id uuid,
  payout_date date,
  amount numeric,
  paid_at timestamptz,
  paid_by_name text,
  note text
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not public.is_admin() then
    raise exception 'only admin can view payout records' using errcode = '42501';
  end if;
  return query
  select p.id, p.payout_date, p.amount, p.paid_at, u.display_name, p.note
    from public.client_payouts p
    left join public.users u on u.id = p.paid_by
   where p.client_id = p_client_id
     and p.payout_date between p_from and p_to
     and p.voided_at is null
   order by p.payout_date desc, p.paid_at desc;
end;
$function$;

grant execute on function public.client_account_balances(date, date) to authenticated;
grant execute on function public.set_client_balance_opening(text, uuid, date, numeric, text)
  to authenticated;
grant execute on function public.record_client_payout(text, uuid, date, numeric, text)
  to authenticated;
grant execute on function public.void_client_payout(uuid, text) to authenticated;
grant execute on function public.list_client_payouts(uuid, date, date) to authenticated;

notify pgrst, 'reload schema';

commit;
