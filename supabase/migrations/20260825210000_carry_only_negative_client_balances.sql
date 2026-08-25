-- Reda's positive daily remittances are paid externally through a Kuda bulk
-- transfer. Uzo does not record a second payout action in Reda. Therefore only
-- negative balances carry into the next day; positive balances close at day end.

begin;

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
  with recursive openings as (
    select c.id as client_id, o.effective_date, o.opening_balance
      from public.clients c
      left join public.client_balance_openings o on o.client_id = c.id
  ), payout_events as (
    select p.client_id, p.payout_date as event_date, p.amount
      from public.client_payouts p
     where p.voided_at is null
    union all
    select s.subject_id, s.period_date, s.expected_amount
      from public.settlements s
     where s.subject_type = 'client'
       and s.voided_at is null
       and s.expected_amount > 0
  ), daily_events as (
    select
      e.client_id,
      e.event_date,
      sum(e.activity) as activity,
      sum(e.payout) as payout
    from (
      select a.client_id, a.activity_date as event_date, a.amount as activity, 0::numeric as payout
        from public.client_financial_activity a
        join openings o on o.client_id = a.client_id
       where o.effective_date is not null
         and a.activity_date between o.effective_date and p_to
      union all
      select pe.client_id, pe.event_date, 0::numeric, pe.amount
        from payout_events pe
        join openings o on o.client_id = pe.client_id
       where o.effective_date is not null
         and pe.event_date between o.effective_date and p_to
    ) e
    group by e.client_id, e.event_date
  ), daily_ledger(client_id, balance_date, closing_balance) as (
    select
      o.client_id,
      o.effective_date,
      o.opening_balance + coalesce(e.activity, 0) - coalesce(e.payout, 0)
    from openings o
    left join daily_events e
      on e.client_id = o.client_id and e.event_date = o.effective_date
    where o.effective_date is not null and o.effective_date <= p_to

    union all

    select
      l.client_id,
      l.balance_date + 1,
      least(l.closing_balance, 0) + coalesce(e.activity, 0) - coalesce(e.payout, 0)
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
    ), 0) else 0 end
  from openings o
  left join period_activity_totals a on a.client_id = o.client_id
  left join period_payout_totals pt on pt.client_id = o.client_id;
end;
$function$;

notify pgrst, 'reload schema';

commit;
