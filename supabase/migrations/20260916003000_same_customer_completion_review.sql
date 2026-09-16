-- Preserve the explicit occurrence claim before the legacy status RPC replaces
-- a missing effective_at with now(). All changes here remain shadow-only.
begin;

alter table public.delivery_status_history
  add column if not exists reported_occurred_at timestamptz;
comment on column public.delivery_status_history.reported_occurred_at is
  'Explicit client occurrence claim. NULL means unknown, including pre-migration history. effective_at may contain a legacy server fallback.';

-- Preserve the installed stock/status implementation and its function identity.
-- Fail closed on unexpected source, rather than replacing a newer RPC body with
-- an old copied definition. These exact fragments were verified on the schema.
do $migration$
declare
  v_function regprocedure := 'public.change_delivery_status(text,uuid,text,text,text,integer,numeric,text,timestamptz,date,jsonb)'::regprocedure;
  v_definition text;
  v_columns text := 'delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at, reason, notes';
  v_values text := 'p_delivery_id, v_delivery.current_status, p_to_status, v_actor, p_client_uuid, v_effective, p_reason, p_notes';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if strpos(v_definition,'reported_occurred_at')=0 then
    if (length(v_definition)-length(replace(v_definition,v_columns,'')))/length(v_columns)<>1
       or (length(v_definition)-length(replace(v_definition,v_values,'')))/length(v_values)<>1 then
      raise exception 'Unexpected change_delivery_status definition; review occurrence instrumentation before migrating';
    end if;
    v_definition:=replace(v_definition,v_columns,v_columns||', reported_occurred_at');
    v_definition:=replace(v_definition,v_values,v_values||', p_effective_at');
    execute v_definition;
  end if;
  select pg_get_functiondef('public._sync_same_customer_shadow(uuid,uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'v_occurred:=h.reported_occurred_at')=0 then
    if strpos(v_definition,'v_occurred:=h.effective_at')=0 then
      raise exception 'Unexpected shadow occurrence definition; review before migrating';
    end if;
    execute replace(v_definition,'v_occurred:=h.effective_at','v_occurred:=h.reported_occurred_at');
  end if;
end $migration$;

create table if not exists public.same_customer_completion_reviews (
  request_id uuid primary key,
  delivery_id uuid not null references public.deliveries(id),
  completion_event_id uuid not null references public.delivery_status_history(id),
  expected_revision bigint not null,
  accepted_day date not null,
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  actor_id uuid not null references public.users(id),
  before_value jsonb not null,
  after_value jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.same_customer_completion_reviews enable row level security;
create index if not exists same_customer_completion_reviews_event_idx
  on public.same_customer_completion_reviews(delivery_id,completion_event_id,created_at desc,request_id desc);
revoke all on public.same_customer_completion_reviews from public,anon,authenticated;

create or replace function public.review_same_customer_completion_day(
  p_request_id uuid,p_delivery_id uuid,p_expected_revision bigint,p_accepted_day date,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare
  d public.deliveries%rowtype;
  e public.same_customer_earnings%rowtype;
  v_previous public.same_customer_completion_reviews%rowtype;
  v_lock text; v_group uuid; v_before jsonb; v_after jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required for completion-date review' using errcode='42501'; end if;
  if p_request_id is null or p_delivery_id is null or p_expected_revision is null or p_accepted_day is null
     or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>2000 then
    raise exception 'request, delivery, revision, completion day and reason required' using errcode='22023';
  end if;
  -- Same-request serialization makes retries safe even before their first commit.
  perform pg_advisory_xact_lock(hashtextextended('same-customer-day-review:'||p_request_id::text,0));
  select * into v_previous from public.same_customer_completion_reviews where request_id=p_request_id;
  if found then
    if (v_previous.actor_id,v_previous.delivery_id,v_previous.expected_revision,v_previous.accepted_day,v_previous.reason)
       is distinct from (auth.uid(),p_delivery_id,p_expected_revision,p_accepted_day,btrim(p_reason)) then
      raise exception 'request id already used for a different correction' using errcode='22023';
    end if;
    return v_previous.after_value;
  end if;
  if not isfinite(p_accepted_day) or p_accepted_day>(clock_timestamp() at time zone 'Africa/Lagos')::date then
    raise exception 'completion day must be a finite Lagos date no later than today' using errcode='22023';
  end if;
  -- Shadow-only lock order matches status and identity correction. Final-pay
  -- integration must acquire the shared outer settlement locks before this row.
  select * into d from public.deliveries where id=p_delivery_id for update;
  if not found then raise exception 'delivery not found' using errcode='P0002'; end if;
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id;
  if not found or not e.active or d.current_status<>'delivered' or d.deleted_at is not null then
    raise exception 'an active successful earning is required' using errcode='22023';
  end if;
  for v_lock in select distinct k from unnest(array[
    public._same_customer_pay_lock_key(e.rider_id,e.customer_key,e.business_date),
    public._same_customer_pay_lock_key(e.rider_id,e.customer_key,p_accepted_day)
  ]) k where k is not null order by k loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock,0));
  end loop;
  -- A different order's completion can change this earning while we wait.
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id for update;
  if e.revision<>p_expected_revision then
    raise exception 'earning changed; refresh before reviewing its completion date' using errcode='40001';
  end if;
  select id into v_group from public.same_customer_pay_groups
    where rider_id=e.rider_id and customer_key=e.customer_key and business_date=p_accepted_day and policy_version=e.policy_version;
  if exists (
    select 1 from public.same_customer_earnings x join public.settlements s
      on s.subject_type='agent' and s.subject_id=x.rider_id and s.period_date=x.accounting_date and s.voided_at is null
    where x.active and (x.delivery_id=e.delivery_id or x.group_id=e.group_id or x.group_id=v_group)
  ) then
    raise exception 'affected rider period is settled; resolve that settlement before changing the completion day' using errcode='22023';
  end if;
  v_before:=to_jsonb(e);
  if v_group is null then
    insert into public.same_customer_pay_groups(rider_id,customer_key,business_date,policy_version)
      values(e.rider_id,e.customer_key,p_accepted_day,e.policy_version) returning id into v_group;
  end if;
  update public.same_customer_earnings set business_date=p_accepted_day,group_id=v_group,date_review_reason=null,
    pay_state='pending',review_reason=null,expected_amount=null,multiplier=null,revision=revision+1,updated_at=clock_timestamp()
    where delivery_id=p_delivery_id;
  perform public._recalculate_customer_day_pay(e.group_id);
  if v_group is distinct from e.group_id then perform public._recalculate_customer_day_pay(v_group); end if;
  select to_jsonb(x) into v_after from public.same_customer_earnings x where delivery_id=p_delivery_id;
  insert into public.same_customer_completion_reviews(request_id,delivery_id,completion_event_id,expected_revision,accepted_day,reason,actor_id,before_value,after_value)
    values(p_request_id,p_delivery_id,e.completion_event_id,p_expected_revision,p_accepted_day,btrim(p_reason),auth.uid(),v_before,v_after);
  return v_after;
end $$;

revoke all on function public.review_same_customer_completion_day(uuid,uuid,bigint,date,text) from public,anon;
grant execute on function public.review_same_customer_completion_day(uuid,uuid,bigint,date,text) to authenticated;

create or replace function public.get_same_customer_config()
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$ begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  return jsonb_build_object('discovery_enabled',
    coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false),
    'normalization_version',1,'shadow_review_enabled',public.is_admin() and (
      coalesce((select enabled from public.feature_flags where key='same_customer_pay_shadow'),false)
      or exists(select 1 from public.same_customer_earnings)));
end $$;

create or replace function public.get_same_customer_shadow_pay(p_delivery_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required for shadow pay' using errcode='42501'; end if;
  select jsonb_build_object('mode','shadow','delivery_id',e.delivery_id,'normal_fee',e.base_fee,
    'multiplier',e.multiplier,'expected_amount',e.expected_amount,'current_payable_amount',d.agent_payment_snapshot,
    'business_date',e.business_date,'accounting_date',e.accounting_date,'state',e.pay_state,
    'review_reason',e.review_reason,'active',e.active,'revision',e.revision,
    'reported_occurred_at',e.occurred_at,'recorded_at',e.recorded_at,'rider_name',u.display_name,
    'last_date_review',(select jsonb_build_object('accepted_day',r.accepted_day,'reason',r.reason,
      'reviewed_by',a.display_name,'reviewed_at',r.created_at) from public.same_customer_completion_reviews r
      join public.users a on a.id=r.actor_id where r.delivery_id=e.delivery_id and r.completion_event_id=e.completion_event_id
      order by r.created_at desc,r.request_id desc limit 1))
    into v_result from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
    join public.users u on u.id=e.rider_id where e.delivery_id=p_delivery_id;
  return v_result;
end $$;
commit;
