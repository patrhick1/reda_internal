-- Captured from the box (root@178.104.73.186) on 2026-09-10 after applying
-- supabase/migrations/20260910090000_client_payments.sql. Every function body
-- below was diffed against pg_get_functiondef at capture time.
--
-- client_payments = money a vendor sent Reda to settle what they owe. The
-- ledger arithmetic (client_account_balances) and the opening-balance lock
-- (set_client_balance_opening) live in client_balance_ledger.sql and were
-- refreshed by the same migration; see that file.
--
-- Cap rule (client_payment_limit): debt carried into the day + charges incurred
-- that day - payments already recorded for that day. NOT the closing balance:
-- a morning transfer against yesterday's debt must stay recordable after an
-- evening delivery nets it, or the day's remit is understated.

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

revoke execute on function public.client_payment_limit(uuid, date) from public, anon;
grant execute on function public.client_payment_limit(uuid, date) to authenticated, service_role;

revoke execute on function public.record_client_payment(text, uuid, date, numeric, text) from public, anon;
grant execute on function public.record_client_payment(text, uuid, date, numeric, text)
  to authenticated, service_role;

revoke execute on function public.void_client_payment(uuid, text) from public, anon;
grant execute on function public.void_client_payment(uuid, text) to authenticated, service_role;

revoke execute on function public.list_client_payments(uuid, date, date) from public, anon;
grant execute on function public.list_client_payments(uuid, date, date) to authenticated, service_role;
