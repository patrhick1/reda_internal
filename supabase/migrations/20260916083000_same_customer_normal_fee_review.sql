-- Correct a successful delivery's normal baseline independently of exceptions.
begin;
create table if not exists public.same_customer_normal_fee_reviews (
  request_id uuid primary key,
  delivery_id uuid not null references public.deliveries(id),
  actor_id uuid not null references public.users(id),
  completion_event_id uuid not null references public.delivery_status_history(id),
  expected_revision bigint not null,
  normal_fee numeric(10,2) not null check(normal_fee>=0 and normal_fee::text not in ('NaN','Infinity','-Infinity')),
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  before_value jsonb not null,
  after_value jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists same_customer_normal_fee_reviews_delivery_idx
  on public.same_customer_normal_fee_reviews(delivery_id,created_at desc);
alter table public.same_customer_normal_fee_reviews enable row level security;
revoke all on public.same_customer_normal_fee_reviews from public,anon,authenticated;

create or replace function public.correct_same_customer_normal_fee(
  p_request_id uuid,p_delivery_id uuid,p_expected_revision bigint,p_normal_fee numeric,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare d public.deliveries%rowtype; e public.same_customer_earnings%rowtype;
  r public.same_customer_normal_fee_reviews%rowtype; v_after jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required for normal-fee correction' using errcode='42501'; end if;
  if p_request_id is null or p_delivery_id is null or p_expected_revision is null or p_normal_fee is null
    or p_normal_fee::text in ('NaN','Infinity','-Infinity') or p_normal_fee<0 or p_normal_fee>99999999.99
    or round(p_normal_fee,2)<>p_normal_fee or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>2000 then
    raise exception 'request, delivery, revision, finite non-negative fee with at most two decimals, and reason required' using errcode='22023';
  end if;
  perform public._same_customer_lock_orders(array[p_delivery_id]);
  perform pg_advisory_xact_lock(hashtextextended('same-customer-normal-fee-review:'||p_request_id::text,0));
  select * into r from public.same_customer_normal_fee_reviews where request_id=p_request_id;
  if found then
    if (r.actor_id,r.delivery_id,r.expected_revision,r.normal_fee,r.reason)
      is distinct from (auth.uid(),p_delivery_id,p_expected_revision,p_normal_fee,btrim(p_reason)) then
      raise exception 'request id already used for a different normal-fee correction' using errcode='22023'; end if;
    return r.after_value;
  end if;
  select * into d from public.deliveries where id=p_delivery_id for update;
  if not found then raise exception 'delivery not found' using errcode='P0002'; end if;
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id for update;
  if not found or not e.active or d.current_status<>'delivered' or d.deleted_at is not null or d.order_type<>'delivery' then
    raise exception 'an active successful earning is required' using errcode='22023'; end if;
  if e.revision<>p_expected_revision then raise exception 'earning changed; refresh before correcting its normal fee' using errcode='40001'; end if;
  if e.base_fee is not distinct from p_normal_fee then raise exception 'normal fee is unchanged' using errcode='22023'; end if;
  if exists(select 1 from public.same_customer_earnings x join public.settlements s
    on s.subject_type='agent' and s.subject_id=x.rider_id and s.period_date=x.accounting_date and s.voided_at is null
    where x.active and (x.delivery_id=e.delivery_id or x.group_id=e.group_id)) then
    raise exception 'affected rider period is settled; resolve settlement before correcting the normal fee' using errcode='22023'; end if;
  -- Existing triggers preserve explicit provenance and recalculate every affected
  -- earning. This never creates, clears or overwrites a manual fee decision.
  update public.deliveries set agent_payment_base_snapshot=p_normal_fee,
    agent_payment_base_captured_at=clock_timestamp() where id=p_delivery_id;
  select to_jsonb(x) into v_after from public.same_customer_earnings x where delivery_id=p_delivery_id;
  insert into public.same_customer_normal_fee_reviews(request_id,delivery_id,actor_id,completion_event_id,
    expected_revision,normal_fee,reason,before_value,after_value)
  values(p_request_id,p_delivery_id,auth.uid(),e.completion_event_id,p_expected_revision,p_normal_fee,btrim(p_reason),to_jsonb(e),v_after);
  return v_after;
end $$;
revoke all on function public.correct_same_customer_normal_fee(uuid,uuid,bigint,numeric,text) from public,anon;
grant execute on function public.correct_same_customer_normal_fee(uuid,uuid,bigint,numeric,text) to authenticated;

do $$ declare v_definition text; v_old text:='''last_date_review'',';
  v_new text:=$patch$'last_normal_fee_review',(select jsonb_build_object('normal_fee',r.normal_fee,'reason',r.reason,
      'reviewed_by',a.display_name,'reviewed_at',r.created_at) from public.same_customer_normal_fee_reviews r
      join public.users a on a.id=r.actor_id where r.delivery_id=e.delivery_id and r.completion_event_id=e.completion_event_id
      order by r.created_at desc,r.request_id desc limit 1),'last_date_review',$patch$;
begin
  select pg_get_functiondef('public.get_same_customer_shadow_pay(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,v_new)=0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old)<>1 then
      raise exception 'Unexpected pay review source; inspect normal-fee review integration'; end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end $$;
commit;
