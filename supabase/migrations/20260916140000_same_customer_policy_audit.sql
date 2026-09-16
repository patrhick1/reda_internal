-- Private deployment controls. No application role can activate rider payment.
begin;
create table if not exists public.same_customer_policy_audit (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default clock_timestamp(),
  database_actor text not null default session_user,
  action text not null check(action in ('schedule','suspend')),
  effective_day date not null,
  release_reference text not null,
  reason text not null,
  before_policy jsonb not null,
  after_policy jsonb not null
);
alter table public.same_customer_policy_audit enable row level security;
revoke all on public.same_customer_policy_audit from public,anon,authenticated;

create or replace function public.configure_same_customer_pay(
  p_action text,p_day date,p_release_reference text,p_reason text)
returns void language plpgsql security invoker set search_path=public as $$
declare v_before jsonb; v_after jsonb; v_start date;
begin
  if p_action is null or p_action not in ('schedule','suspend')
    or p_day is null or p_day<=(clock_timestamp() at time zone 'Africa/Lagos')::date
    or nullif(btrim(p_release_reference),'') is null or nullif(btrim(p_reason),'') is null then
    raise exception 'future Lagos day, release reference and reason required' using errcode='22023';
  end if;
  select to_jsonb(p),active_from into strict v_before,v_start
    from public.same_customer_pay_policy p where singleton for update;
  if p_action='schedule' then
    if v_start is not null or exists(select 1 from public.same_customer_pay_policy_days where enabled) then
      raise exception 'payment policy was already scheduled; do not reprice enrolled days' using errcode='22023';
    end if;
    update public.same_customer_pay_policy set active_from=p_day,inactive_from=null where singleton;
  else
    if v_start is null or p_day<=v_start then
      raise exception 'suspension must follow the scheduled start' using errcode='22023';
    end if;
    update public.same_customer_pay_policy set inactive_from=p_day where singleton;
  end if;
  select to_jsonb(p) into v_after from public.same_customer_pay_policy p where singleton;
  insert into public.same_customer_policy_audit(action,effective_day,release_reference,reason,before_policy,after_policy)
    values(p_action,p_day,btrim(p_release_reference),btrim(p_reason),v_before,v_after);
end $$;
revoke all on function public.configure_same_customer_pay(text,date,text,text) from public,anon,authenticated,service_role;
commit;
