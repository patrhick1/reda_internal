-- Final-pay authority. The policy has NO public activation API yet: compatible
-- finance readers and rollout validation must ship before configuring it.
begin;
create table if not exists public.same_customer_pay_policy (
  singleton boolean primary key default true check(singleton),
  active_from date,
  inactive_from date,
  check(inactive_from is null or (active_from is not null and inactive_from>active_from))
);
insert into public.same_customer_pay_policy(singleton) values(true) on conflict do nothing;
create table if not exists public.same_customer_pay_policy_days (
  business_date date primary key,
  enabled boolean not null,
  policy_version integer not null default 1 check(policy_version=1),
  recorded_at timestamptz not null default clock_timestamp()
);
-- Private transaction-scoped recursion guard. Unlike a caller-settable GUC or
-- advisory key, an API caller cannot forge this to suppress a projection.
create table if not exists public.same_customer_projection_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  primary key(backend_pid,transaction_id)
);
alter table public.same_customer_pay_policy enable row level security;
alter table public.same_customer_pay_policy_days enable row level security;
alter table public.same_customer_projection_context enable row level security;
revoke all on public.same_customer_pay_policy,public.same_customer_pay_policy_days,public.same_customer_projection_context from public,anon,authenticated;
alter table public.same_customer_earnings
  add column if not exists policy_applied boolean not null default false,
  add column if not exists legacy_amount numeric(12,2),
  add column if not exists final_amount numeric(12,2),
  add column if not exists final_state text not null default 'shadow' check(final_state in ('shadow','legacy','ready','pending','reversed')),
  add column if not exists final_review_reason text;
create index if not exists same_customer_final_pending_idx on public.same_customer_earnings(rider_id,accounting_date)
  where active and policy_applied and final_state='pending';

create or replace function public._same_customer_policy_for_day(p_day date)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_enabled boolean; p public.same_customer_pay_policy%rowtype;
begin
  if p_day is null then return false; end if;
  select enabled into v_enabled from public.same_customer_pay_policy_days where business_date=p_day;
  if found then return v_enabled; end if;
  select * into p from public.same_customer_pay_policy where singleton;
  if p.active_from is null then return false; end if;
  v_enabled:=p_day>=p.active_from and (p.inactive_from is null or p_day<p.inactive_from);
  insert into public.same_customer_pay_policy_days(business_date,enabled) values(p_day,v_enabled) on conflict do nothing;
  select enabled into strict v_enabled from public.same_customer_pay_policy_days where business_date=p_day;
  return v_enabled;
end $$;

create or replace function public._same_customer_policy_candidate(p_occurred timestamptz,p_received timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if public._same_customer_policy_for_day((p_received at time zone 'Africa/Lagos')::date) then return true; end if;
  if p_occurred is not null and p_occurred<=p_received
    and public._same_customer_policy_for_day((p_occurred at time zone 'Africa/Lagos')::date) then return true; end if;
  -- A legacy request after policy suspension may describe an offline completion
  -- inside the active window. It needs a date before it can be priced as legacy.
  return p_occurred is null and (
    exists(select 1 from public.same_customer_pay_policy where active_from is not null
      and active_from<=(p_received at time zone 'Africa/Lagos')::date)
    or exists(select 1 from public.same_customer_pay_policy_days where enabled and business_date<=(p_received at time zone 'Africa/Lagos')::date));
end $$;

create or replace function public._same_customer_track_manual_fee(d public.deliveries)
returns boolean language sql stable security definer set search_path=public as $$
  select d.order_type='delivery' and (
    coalesce((select enabled from public.feature_flags where key='same_customer_pay_shadow'),false)
    or exists(select 1 from public.same_customer_earnings where delivery_id=d.id)
    -- A later offline request may establish that the completion happened inside
    -- an earlier active window. Preserve explicit corrections after suspension.
    or exists(select 1 from public.same_customer_pay_policy where active_from is not null
      and active_from<=(clock_timestamp() at time zone 'Africa/Lagos')::date)
    or exists(select 1 from public.same_customer_pay_policy_days where enabled
      and business_date<=(clock_timestamp() at time zone 'Africa/Lagos')::date))
$$;

create or replace function public._project_same_customer_pay(p_delivery_id uuid)
returns void language plpgsql security definer set search_path=public,auth as $$
declare e public.same_customer_earnings%rowtype; d public.deliveries%rowtype;
  v_group uuid; v_ids uuid[]; v_id uuid; v_enabled boolean; v_amount numeric; v_state text; v_reason text;
  v_conflict boolean;
begin
  select group_id into v_group from public.same_customer_earnings where delivery_id=p_delivery_id;
  if not found then return; end if;
  insert into public.same_customer_projection_context values(pg_backend_pid(),txid_current()) on conflict do nothing;
  if not found then return; end if;
  select array_agg(delivery_id order by delivery_id) into v_ids from public.same_customer_earnings
    where delivery_id=p_delivery_id or (group_id=v_group and active);
  perform public._same_customer_lock_orders(v_ids,'{}'::uuid[],false);
  foreach v_id in array v_ids loop
    select * into strict e from public.same_customer_earnings where delivery_id=v_id;
    select * into strict d from public.deliveries where id=v_id;
    -- History is inserted before the operational row changes. Project only once
    -- their states agree; never let a payout UPDATE undo an in-flight completion.
    if (e.active and (d.current_status<>'delivered' or d.deleted_at is not null))
      or (not e.active and d.current_status='delivered' and d.deleted_at is null) then continue; end if;
    v_enabled:=case when e.business_date is not null then public._same_customer_policy_for_day(e.business_date)
      else public._same_customer_policy_candidate(e.occurred_at,e.recorded_at) end;
    if not v_enabled and not e.policy_applied and e.final_state<>'legacy' then continue; end if;
    v_reason:=null;
    if not v_enabled then
      v_state:='legacy'; v_amount:=coalesce(e.manual_amount,e.base_fee,e.legacy_amount);
    elsif not e.active then
      v_state:='reversed'; v_amount:=null;
    elsif e.pay_state='ready' then
      v_state:='ready'; v_amount:=e.expected_amount;
    else
      v_state:='pending'; v_amount:=null; v_reason:=e.review_reason;
    end if;
    update public.same_customer_earnings set policy_applied=v_enabled,
      legacy_amount=coalesce(legacy_amount,d.agent_payment_snapshot),final_amount=v_amount,
      final_state=v_state,final_review_reason=v_reason,revision=revision+1,updated_at=clock_timestamp()
    where delivery_id=v_id and (policy_applied,final_amount,final_state,final_review_reason)
      is distinct from (v_enabled,v_amount,v_state,v_reason);
  end loop;
  -- Frozen amounts are read from the immutable settlement snapshot, not from a
  -- mutable delivery row. Missing entries identify activity after handover.
  select exists(
    select 1 from public.same_customer_earnings x join public.deliveries dx on dx.id=x.delivery_id
    join public.settlements s on s.subject_type='agent' and s.subject_id=x.rider_id
      and s.period_date=x.accounting_date and s.voided_at is null
    left join lateral (select j.value from jsonb_array_elements(s.snapshot->'by_delivery') j
      where j.value->>'delivery_id'=x.delivery_id::text and coalesce(j.value->>'entry_type','delivery')='delivery' limit 1) frozen on true
    where x.delivery_id=any(v_ids) and x.active and x.policy_applied and dx.current_status='delivered' and dx.deleted_at is null
      and (frozen.value is null or (x.final_amount is not null and x.final_amount is distinct from (frozen.value->>'agent_payment')::numeric))
  ) into v_conflict;
  if v_conflict then
    update public.same_customer_earnings set final_state='pending',final_amount=null,
      final_review_reason='settled_period_conflict',revision=revision+1,updated_at=clock_timestamp()
    where delivery_id=any(v_ids) and active and policy_applied
      and (final_state,final_amount,final_review_reason) is distinct from ('pending'::text,null::numeric,'settled_period_conflict'::text);
  end if;
  update public.deliveries dx set agent_payment_snapshot=case when x.final_state='reversed' then x.base_fee else x.final_amount end
    from public.same_customer_earnings x where x.delivery_id=dx.id and x.delivery_id=any(v_ids)
      and x.final_state in ('ready','legacy','reversed')
      and ((x.active and dx.current_status='delivered' and dx.deleted_at is null)
        or (not x.active and (dx.current_status<>'delivered' or dx.deleted_at is not null)))
      and dx.agent_payment_snapshot is distinct from case when x.final_state='reversed' then x.base_fee else x.final_amount end;
  delete from public.same_customer_projection_context where backend_pid=pg_backend_pid() and transaction_id=txid_current();
end $$;

create or replace function public._guard_same_customer_settled_delivery()
returns trigger language plpgsql security definer set search_path=public as $$
declare e public.same_customer_earnings%rowtype;
begin
  if old.current_status<>'delivered' then return new; end if;
  if (old.current_status,old.deleted_at,old.paid,old.charged_snapshot,old.agent_payment_snapshot,old.cash_pos_fee_snapshot,
      old.client_id,old.scheduled_date,old.customer_phone,old.same_customer_key_override,old.agent_payment_base_snapshot)
    is not distinct from
     (new.current_status,new.deleted_at,new.paid,new.charged_snapshot,new.agent_payment_snapshot,new.cash_pos_fee_snapshot,
      new.client_id,new.scheduled_date,new.customer_phone,new.same_customer_key_override,new.agent_payment_base_snapshot) then return new; end if;
  select * into e from public.same_customer_earnings where delivery_id=old.id and policy_applied;
  if found and exists(select 1 from public.settlements where subject_type='agent' and subject_id=e.rider_id
    and period_date=e.accounting_date and voided_at is null) then
    raise exception 'rider period is settled; void the settlement before changing this delivery' using errcode='22023';
  end if;
  return new;
end $$;
drop trigger if exists same_customer_settled_delivery_guard on public.deliveries;
create trigger same_customer_settled_delivery_guard before update on public.deliveries
  for each row execute function public._guard_same_customer_settled_delivery();

create or replace function public._same_customer_final_rider(d public.deliveries)
returns uuid language sql stable security definer set search_path=public as $$
  select coalesce((select rider_id from public.same_customer_earnings where delivery_id=d.id and policy_applied),d.assigned_agent_id)
$$;
create or replace function public._same_customer_final_accounting_date(d public.deliveries)
returns date language sql stable security definer set search_path=public as $$
  select coalesce((select accounting_date from public.same_customer_earnings where delivery_id=d.id and policy_applied),d.scheduled_date)
$$;
create or replace function public._refresh_same_customer_pay_period(p_rider uuid,p_day date)
returns void language plpgsql security definer set search_path=public as $$ declare v_id uuid; begin
  for v_id in select min(delivery_id::text)::uuid from public.same_customer_earnings
    where rider_id=p_rider and accounting_date=p_day and active group by coalesce(group_id,delivery_id) loop
    perform public._project_same_customer_pay(v_id);
  end loop;
end $$;
create or replace function public._assert_same_customer_settlement_ready(p_subject text,p_id uuid,p_day date)
returns void language plpgsql security definer set search_path=public as $$ begin
  if p_subject<>'agent' then return; end if;
  perform public._refresh_same_customer_pay_period(p_id,p_day);
  if exists(select 1 from public.same_customer_earnings where rider_id=p_id and accounting_date=p_day
    and active and policy_applied and final_state='pending') then
    raise exception 'rider pay needs review before this period can be settled' using errcode='P0001';
  end if;
end $$;

create or replace function pg_temp.patch_final_pay(p_function regprocedure,p_old text,p_new text)
returns void language plpgsql as $$ declare v_definition text; begin
  select pg_get_functiondef(p_function) into v_definition;
  if strpos(v_definition,p_new)>0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
    raise exception 'Unexpected source in %; inspect final-pay integration',p_function; end if;
  execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.patch_final_pay('public._sync_same_customer_shadow(uuid,uuid)',
  'if not v_exists and not coalesce((select enabled from public.feature_flags where key=''same_customer_pay_shadow''),false) then return; end if;',
  'if not v_exists and not coalesce((select enabled from public.feature_flags where key=''same_customer_pay_shadow''),false) and not public._same_customer_policy_candidate(h.reported_occurred_at,clock_timestamp()) then return; end if;');
select pg_temp.patch_final_pay('public._recalculate_customer_day_pay(uuid)',
  'update public.same_customer_pay_groups set state=v_state,revision=revision+1,updated_at=clock_timestamp() where id=p_group_id;',
  E'update public.same_customer_pay_groups set state=v_state,revision=revision+1,updated_at=clock_timestamp() where id=p_group_id;\n  perform public._project_same_customer_pay((select delivery_id from public.same_customer_earnings where group_id=p_group_id order by active desc,delivery_id limit 1));');
select pg_temp.patch_final_pay('public._same_customer_shadow_delivery()',
  'perform public._sync_same_customer_shadow(new.id); return new;',
  'perform public._sync_same_customer_shadow(new.id); perform public._project_same_customer_pay(new.id); return new;');
select pg_temp.patch_final_pay('public._sync_same_customer_shadow(uuid,uuid)',
  'if v_new_group is distinct from v_old_group then perform public._recalculate_customer_day_pay(v_new_group); end if;',
  E'if v_new_group is distinct from v_old_group then perform public._recalculate_customer_day_pay(v_new_group); end if;\n  perform public._project_same_customer_pay(p_delivery_id);');
select pg_temp.patch_final_pay('public.settle_period(text,uuid,date,text)',
  'select id into v_existing from public.settlements',
  E'perform public._assert_same_customer_settlement_ready(p_subject_type,p_subject_id,p_period_date);\n  select id into v_existing from public.settlements');
select pg_temp.patch_final_pay('public.settle_period(text,uuid,date,text)',
  'where d.assigned_agent_id = p_subject_id and d.current_status = ''delivered''',
  'where public._same_customer_final_rider(d) = p_subject_id and d.current_status = ''delivered''');
-- Only the agent branch changes its accounting date; the client branch keeps
-- its established schedule-based accounting and replacement union unchanged.
do $$ declare v_definition text; v_match text[]; begin
  select pg_get_functiondef('public.settle_period(text,uuid,date,text)'::regprocedure) into v_definition;
  if strpos(v_definition,'public._same_customer_final_accounting_date(d)')=0 then
    v_match:=regexp_match(v_definition,'where public[.]_same_customer_final_rider[(]d[)] = p_subject_id and d[.]current_status = ''delivered''[[:space:]]+and d[.]scheduled_date = p_period_date');
    if v_match is null then raise exception 'Unexpected agent settlement date predicate'; end if;
    execute replace(v_definition,v_match[1],replace(v_match[1],'d.scheduled_date','public._same_customer_final_accounting_date(d)'));
  end if;
end $$;
select pg_temp.patch_final_pay('public.void_settlement(uuid,text)',
  'where id = p_settlement_id;',
  E'where id = p_settlement_id;\n  if v_row.subject_type=''agent'' then perform public._refresh_same_customer_pay_period(v_row.subject_id,v_row.period_date); end if;');

revoke all on function public._same_customer_policy_for_day(date),public._same_customer_policy_candidate(timestamptz,timestamptz),public._project_same_customer_pay(uuid),
 public._guard_same_customer_settled_delivery(),public._same_customer_final_rider(public.deliveries),
 public._same_customer_final_accounting_date(public.deliveries),public._refresh_same_customer_pay_period(uuid,date),
 public._assert_same_customer_settlement_ready(text,uuid,date) from public,anon,authenticated;
commit;
