-- Shadow earnings only. This migration NEVER writes delivery payout snapshots
-- or settlements. Financial activation requires the separate integration gates.
begin;

insert into public.feature_flags(key,enabled,description)
values ('same_customer_pay_shadow',false,'Calculate expected same-customer rider earnings without changing payable amounts.')
on conflict(key) do nothing;

create table if not exists public.same_customer_pay_groups (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.users(id),
  customer_key text not null,
  business_date date not null,
  policy_version integer not null default 1 check(policy_version=1),
  state text not null default 'ready' check(state in ('ready','rate_mismatch','manual_review')),
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique(rider_id,customer_key,business_date,policy_version)
);

create table if not exists public.same_customer_earnings (
  delivery_id uuid primary key references public.deliveries(id),
  completion_event_id uuid not null references public.delivery_status_history(id),
  rider_id uuid not null references public.users(id),
  customer_key text not null,
  recorded_at timestamptz not null,
  occurred_at timestamptz,
  business_date date,
  accounting_date date not null,
  base_fee numeric(12,2),
  multiplier numeric(3,2),
  expected_amount numeric(12,2),
  group_id uuid references public.same_customer_pay_groups(id),
  active boolean not null default true,
  date_review_reason text check(date_review_reason in ('date_discrepancy','clock_skew','missing_occurrence')),
  pay_state text not null default 'pending' check(pay_state in ('ready','pending','reversed')),
  review_reason text,
  manual_amount numeric(12,2) check(manual_amount>=0),
  manual_reason text,
  policy_version integer not null default 1 check(policy_version=1),
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  check((manual_amount is null)=(manual_reason is null)),
  check(manual_reason is null or length(btrim(manual_reason))>0),
  check(pay_state<>'ready' or (expected_amount is not null and business_date is not null))
);
create index if not exists same_customer_earnings_group_idx on public.same_customer_earnings(group_id,recorded_at,completion_event_id) where active;
-- Negative imported rates are reviewable data errors, not completion failures.
alter table public.same_customer_earnings drop constraint if exists same_customer_earnings_base_fee_check;
create index if not exists same_customer_earnings_period_idx on public.same_customer_earnings(rider_id,accounting_date) where active;

create table if not exists public.same_customer_earning_revisions (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries(id),
  actor_id uuid,
  old_value jsonb,
  new_value jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.same_customer_pay_groups enable row level security;
alter table public.same_customer_earnings enable row level security;
alter table public.same_customer_earning_revisions enable row level security;
revoke all on public.same_customer_pay_groups,public.same_customer_earnings,public.same_customer_earning_revisions from public,anon,authenticated;

create or replace function public._same_customer_earning_audit()
returns trigger language plpgsql security definer set search_path=public,auth as $$
begin
  insert into public.same_customer_earning_revisions(delivery_id,actor_id,old_value,new_value)
    values(new.delivery_id,auth.uid(),case when TG_OP='UPDATE' then to_jsonb(old) end,to_jsonb(new));
  return new;
end $$;
drop trigger if exists same_customer_earning_audit on public.same_customer_earnings;
create trigger same_customer_earning_audit after insert or update on public.same_customer_earnings
  for each row execute function public._same_customer_earning_audit();

create or replace function public._same_customer_pay_lock_key(p_rider uuid,p_customer text,p_day date)
returns text language sql immutable set search_path=public as $$
  select 'same-customer-pay:v1:'||p_rider::text||':'||p_day::text||':'||p_customer
$$;

-- Identity corrections lock every existing and possible reset group before the
-- multi-row UPDATE starts. New link/split override keys are private fresh UUIDs.
create or replace function public._lock_same_customer_shadow_for_orders(p_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare v_key text;
begin
  for v_key in
    select distinct k from (
      select public._same_customer_pay_lock_key(e.rider_id,e.customer_key,e.business_date) k
        from public.same_customer_earnings e where delivery_id=any(p_ids) and business_date is not null
      union
      select public._same_customer_pay_lock_key(e.rider_id,coalesce('phone:'||d.same_customer_phone,'solo:'||d.id::text),e.business_date)
        from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
        where e.delivery_id=any(p_ids) and e.business_date is not null
    ) keys order by k
  loop perform pg_advisory_xact_lock(hashtextextended(v_key,0)); end loop;
end $$;

-- Caller holds the group lock before touching earnings. No other delivery rows
-- are updated here: shadow mode cannot race with settlement snapshot writes.
create or replace function public._recalculate_customer_day_pay(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,auth as $$
declare g public.same_customer_pay_groups%rowtype; v_state text; v_count integer;
begin
  if p_group_id is null then return; end if;
  select * into strict g from public.same_customer_pay_groups where id=p_group_id;
  perform pg_advisory_xact_lock(hashtextextended(public._same_customer_pay_lock_key(g.rider_id,g.customer_key,g.business_date),0));
  perform id from public.same_customer_pay_groups where id=p_group_id for update;
  select count(*),case
    when count(*) filter(where base_fee is null or base_fee<0)>0 or count(distinct base_fee)>1 then 'rate_mismatch'
    when count(*) filter(where manual_amount is not null)>0 and count(*)>1 then 'manual_review'
    else 'ready' end into v_count,v_state
  from public.same_customer_earnings where group_id=p_group_id and active;

  with ranked as (
    select delivery_id,row_number() over(order by recorded_at,completion_event_id,delivery_id) as position
      from public.same_customer_earnings where group_id=p_group_id and active
  ), calculation as (
    select e.delivery_id,
      case when v_state='ready' then case when r.position=1 then 1::numeric else 0.5::numeric end end as factor,
      case when v_state='ready' then coalesce(e.manual_amount,round(e.base_fee*case when r.position=1 then 1 else 0.5 end,2)) end as amount,
      case when v_state='ready' then 'ready' else 'pending' end as state,
      case when v_state<>'ready' then v_state end as reason
    from ranked r join public.same_customer_earnings e using(delivery_id)
  )
  update public.same_customer_earnings e set multiplier=c.factor,expected_amount=c.amount,
    pay_state=c.state,review_reason=c.reason,revision=e.revision+1,updated_at=clock_timestamp()
  from calculation c where e.delivery_id=c.delivery_id
    and (e.multiplier,e.expected_amount,e.pay_state,e.review_reason) is distinct from (c.factor,c.amount,c.state,c.reason);
  update public.same_customer_pay_groups set state=v_state,revision=revision+1,updated_at=clock_timestamp() where id=p_group_id;
end $$;

-- The completion event snapshots the successful rider and accounting date.
-- Assignment edits never transfer an existing earning. Same-day client claims
-- use the server's Lagos day; cross-day/future claims remain pending review.
create or replace function public._sync_same_customer_shadow(p_delivery_id uuid,p_event_id uuid default null)
returns void language plpgsql security definer set search_path=public,auth as $$
declare
  d public.deliveries%rowtype; e public.same_customer_earnings%rowtype;
  h public.delivery_status_history%rowtype; v_exists boolean;
  v_rider uuid; v_customer text; v_day date; v_accounting date; v_active boolean;
  v_occurred timestamptz; v_recorded timestamptz; v_event uuid; v_date_reason text;
  v_old_group uuid; v_new_group uuid; v_lock text; v_old_lock text; v_new_lock text;
begin
  select * into d from public.deliveries where id=p_delivery_id;
  if not found or d.order_type<>'delivery' then return; end if;
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id;
  v_exists:=found;
  if p_event_id is not null then
    select * into strict h from public.delivery_status_history where id=p_event_id and delivery_id=p_delivery_id;
    if h.to_status='delivered' then
      if not v_exists and not coalesce((select enabled from public.feature_flags where key='same_customer_pay_shadow'),false) then return; end if;
      if d.assigned_agent_id is null then return; end if;
      if v_exists and e.completion_event_id=h.id then return; end if;
      v_rider:=d.assigned_agent_id; v_accounting:=d.scheduled_date;
      v_recorded:=clock_timestamp(); v_occurred:=h.effective_at; v_event:=h.id; v_active:=true;
      v_day:=(v_recorded at time zone 'Africa/Lagos')::date;
      v_date_reason:=case when v_occurred is null then 'missing_occurrence'
        when v_occurred>v_recorded+interval '5 minutes' then 'clock_skew'
        when (v_occurred at time zone 'Africa/Lagos')::date<>v_day then 'date_discrepancy' end;
      if v_date_reason is not null then v_day:=null; end if;
    elsif h.from_status='delivered' and v_exists then
      v_active:=false;
    else return; end if;
  elsif not v_exists then return;
  else v_active:=d.current_status='delivered' and d.deleted_at is null;
  end if;
  if v_rider is null then
    v_rider:=e.rider_id; v_accounting:=e.accounting_date; v_day:=e.business_date;
    v_recorded:=e.recorded_at; v_occurred:=e.occurred_at; v_event:=e.completion_event_id;
    v_date_reason:=e.date_review_reason;
  end if;
  v_customer:=public._same_customer_key(d);
  v_old_group:=e.group_id;
  if v_exists and e.business_date is not null then
    v_old_lock:=public._same_customer_pay_lock_key(e.rider_id,e.customer_key,e.business_date); end if;
  if v_day is not null then v_new_lock:=public._same_customer_pay_lock_key(v_rider,v_customer,v_day); end if;
  for v_lock in select distinct x from unnest(array[v_old_lock,v_new_lock]) x where x is not null order by x loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock,0));
  end loop;
  if v_day is not null then
    insert into public.same_customer_pay_groups(rider_id,customer_key,business_date)
      values(v_rider,v_customer,v_day) on conflict(rider_id,customer_key,business_date,policy_version) do nothing;
    select id into strict v_new_group from public.same_customer_pay_groups
      where rider_id=v_rider and customer_key=v_customer and business_date=v_day and policy_version=1;
  end if;
  insert into public.same_customer_earnings(delivery_id,completion_event_id,rider_id,customer_key,
    recorded_at,occurred_at,business_date,accounting_date,base_fee,group_id,active,date_review_reason,pay_state,review_reason)
  values(d.id,v_event,v_rider,v_customer,v_recorded,v_occurred,v_day,v_accounting,d.agent_payment_snapshot,
    v_new_group,v_active,v_date_reason,case when v_active then 'pending' else 'reversed' end,v_date_reason)
  on conflict(delivery_id) do update set completion_event_id=excluded.completion_event_id,
    rider_id=excluded.rider_id,customer_key=excluded.customer_key,recorded_at=excluded.recorded_at,
    occurred_at=excluded.occurred_at,business_date=excluded.business_date,accounting_date=excluded.accounting_date,
    base_fee=excluded.base_fee,group_id=excluded.group_id,active=excluded.active,date_review_reason=excluded.date_review_reason,
    pay_state=excluded.pay_state,review_reason=excluded.review_reason,multiplier=null,expected_amount=null,
    revision=same_customer_earnings.revision+1,updated_at=clock_timestamp()
  where (same_customer_earnings.completion_event_id,same_customer_earnings.customer_key,same_customer_earnings.base_fee,
    same_customer_earnings.active,same_customer_earnings.business_date)
    is distinct from (excluded.completion_event_id,excluded.customer_key,excluded.base_fee,excluded.active,excluded.business_date);
  perform public._recalculate_customer_day_pay(v_old_group);
  if v_new_group is distinct from v_old_group then perform public._recalculate_customer_day_pay(v_new_group); end if;
end $$;

create or replace function public._same_customer_shadow_history()
returns trigger language plpgsql security definer set search_path=public,auth as $$ begin
  perform public._sync_same_customer_shadow(new.delivery_id,new.id); return new;
end $$;
drop trigger if exists same_customer_shadow_history on public.delivery_status_history;
create trigger same_customer_shadow_history after insert on public.delivery_status_history
  for each row when (new.to_status='delivered' or new.from_status='delivered')
  execute function public._same_customer_shadow_history();

create or replace function public._same_customer_shadow_delivery()
returns trigger language plpgsql security definer set search_path=public,auth as $$ begin
  -- The existing status RPC inserts history BEFORE writing its final scheduled
  -- date. Postponed completions move to today, so finalize the accounting snapshot
  -- from the resulting row in the same transaction, never from the old schedule.
  if old.current_status<>'delivered' and new.current_status='delivered' then
    update public.same_customer_earnings set accounting_date=new.scheduled_date,
      revision=revision+1,updated_at=clock_timestamp()
    where delivery_id=new.id and active and accounting_date is distinct from new.scheduled_date;
  end if;
  perform public._sync_same_customer_shadow(new.id); return new;
end $$;
drop trigger if exists same_customer_shadow_delivery on public.deliveries;
create trigger same_customer_shadow_delivery after update of current_status,deleted_at,customer_phone,
  same_customer_key_override,agent_payment_snapshot on public.deliveries for each row
  when ((old.current_status,old.deleted_at,old.customer_phone,old.same_customer_key_override,old.agent_payment_snapshot)
    is distinct from (new.current_status,new.deleted_at,new.customer_phone,new.same_customer_key_override,new.agent_payment_snapshot))
  execute function public._same_customer_shadow_delivery();

create or replace function public.get_same_customer_shadow_pay(p_delivery_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required for shadow pay' using errcode='42501'; end if;
  select jsonb_build_object('mode','shadow','delivery_id',e.delivery_id,'normal_fee',e.base_fee,
    'multiplier',e.multiplier,'expected_amount',e.expected_amount,'current_payable_amount',d.agent_payment_snapshot,
    'business_date',e.business_date,'accounting_date',e.accounting_date,'state',e.pay_state,
    'review_reason',e.review_reason,'active',e.active,'revision',e.revision)
    into v_result from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
    where e.delivery_id=p_delivery_id;
  return v_result;
end $$;

revoke all on function public._same_customer_earning_audit(),public._same_customer_pay_lock_key(uuid,text,date),public._lock_same_customer_shadow_for_orders(uuid[]),
 public._recalculate_customer_day_pay(uuid),public._sync_same_customer_shadow(uuid,uuid),
 public._same_customer_shadow_history(),public._same_customer_shadow_delivery() from public,anon,authenticated;
revoke all on function public.get_same_customer_shadow_pay(uuid) from public,anon;
grant execute on function public.get_same_customer_shadow_pay(uuid) to authenticated;
commit;
