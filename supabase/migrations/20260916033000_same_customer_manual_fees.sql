-- Audited manual exceptions and group acknowledgement. Still shadow-only:
-- existing explicit charge corrections retain their ordinary payable behavior.
begin;
alter table public.same_customer_earnings
  add column if not exists manual_decision_id bigint,
  add column if not exists manual_event_review boolean not null default false;
alter table public.same_customer_pay_groups
  add column if not exists manual_review_signature text;

create table if not exists public.same_customer_fee_decisions (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries(id),
  amount numeric(12,2),
  reason text not null check(length(btrim(reason))>0),
  actor_id uuid not null references public.users(id),
  source text not null check(source in ('charge_correction','clear_exception')),
  request_id uuid unique,
  expected_revision bigint,
  created_at timestamptz not null default clock_timestamp(),
  check(amount is null or (amount>=0 and amount::text not in ('NaN','Infinity','-Infinity')))
);
create index if not exists same_customer_fee_decisions_delivery_idx
  on public.same_customer_fee_decisions(delivery_id,id desc);
create table if not exists public.same_customer_manual_reviews (
  request_id uuid primary key,
  group_id uuid not null references public.same_customer_pay_groups(id),
  expected_revision bigint not null,
  signature text not null,
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  actor_id uuid not null references public.users(id),
  reviewed_members jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.same_customer_fee_decisions enable row level security;
alter table public.same_customer_manual_reviews enable row level security;
revoke all on public.same_customer_fee_decisions,public.same_customer_manual_reviews from public,anon,authenticated;

create or replace function public._same_customer_track_manual_fee(d public.deliveries)
returns boolean language sql stable security definer set search_path=public as $$
  select d.order_type='delivery' and (coalesce((select enabled from public.feature_flags where key='same_customer_pay_shadow'),false)
    or exists(select 1 from public.same_customer_earnings where delivery_id=d.id))
$$;
create or replace function public._same_customer_record_manual_fee(p_id uuid,p_amount numeric,p_reason text)
returns void language plpgsql security definer set search_path=public,auth as $$
declare d public.deliveries%rowtype;
begin
  select * into strict d from public.deliveries where id=p_id;
  if not public._same_customer_track_manual_fee(d) then return; end if;
  if p_amount is null or p_amount<0 or p_amount::text in ('NaN','Infinity','-Infinity') then
    raise exception 'manual rider fee must be a finite non-negative amount' using errcode='22023';
  end if;
  if exists(select 1 from public.same_customer_earnings e join public.settlements s
    on s.subject_type='agent' and s.subject_id=e.rider_id and s.period_date=e.accounting_date and s.voided_at is null
    where e.delivery_id=p_id and e.active) then
    raise exception 'cannot change the agent payout: the successful rider period is already settled' using errcode='23505';
  end if;
  insert into public.same_customer_fee_decisions(delivery_id,amount,reason,actor_id,source)
    values(p_id,round(p_amount,2),btrim(p_reason),auth.uid(),'charge_correction');
end $$;

create or replace function public._same_customer_manual_signature(p_group uuid)
returns text language sql stable security definer set search_path=public as $$
  select md5(coalesce(jsonb_agg(jsonb_build_array(delivery_id,completion_event_id,rider_id,customer_key,business_date,
    base_fee,manual_decision_id,manual_amount,manual_event_review) order by delivery_id),'[]'::jsonb)::text)
  from public.same_customer_earnings where group_id=p_group and active
$$;

create or replace function public._recalculate_customer_day_pay(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,auth as $$
declare g public.same_customer_pay_groups%rowtype; v_state text; v_signature text;
begin
  if p_group_id is null then return; end if;
  select * into strict g from public.same_customer_pay_groups where id=p_group_id;
  perform public._same_customer_lock_orders(array(select delivery_id from public.same_customer_earnings where group_id=p_group_id and active),array[g.rider_id],false);
  perform pg_advisory_xact_lock(hashtextextended(public._same_customer_pay_lock_key(g.rider_id,g.customer_key,g.business_date),0));
  select * into strict g from public.same_customer_pay_groups where id=p_group_id for update;
  v_signature:=public._same_customer_manual_signature(p_group_id);
  select case
    when count(*) filter(where base_fee is null or base_fee<0 or base_fee::text in ('NaN','Infinity','-Infinity'))>0 or count(distinct base_fee)>1 then 'rate_mismatch'
    when ((count(*) filter(where manual_amount is not null)>0 and count(*)>1)
       or count(*) filter(where manual_amount is not null and manual_event_review)>0)
       and g.manual_review_signature is distinct from v_signature then 'manual_review'
    else 'ready' end into v_state
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

create or replace function pg_temp.patch_manual_fee(p_function regprocedure,p_old text,p_new text)
returns void language plpgsql as $$ declare v_definition text; begin
  select pg_get_functiondef(p_function) into v_definition;
  if strpos(v_definition,p_new)>0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
    raise exception 'Unexpected source in %; inspect manual-fee integration',p_function;
  end if;
  execute replace(v_definition,p_old,p_new);
end $$;

-- Record the explicit exception before the delivery UPDATE triggers recalculation.
select pg_temp.patch_manual_fee('public.correct_delivery_charge(uuid,numeric,numeric,text)',
  'update public.deliveries',
  E'if v_agent_changed then\n    perform public._same_customer_record_manual_fee(p_delivery_id,p_agent_payment,p_reason);\n  end if;\n  update public.deliveries');
select pg_temp.patch_manual_fee('public.correct_delivery_charge(uuid,numeric,numeric,text)',
  'agent_payment_snapshot = p_agent_payment,',
  E'agent_payment_snapshot = p_agent_payment,\n         agent_payment_base_snapshot = case when v_agent_changed and public._same_customer_track_manual_fee(v_row) then public._same_customer_normal_fee(v_row) else agent_payment_base_snapshot end,\n         agent_payment_base_captured_at = case when v_agent_changed and public._same_customer_track_manual_fee(v_row) then clock_timestamp() else agent_payment_base_captured_at end,');

-- Read the latest immutable decision, including exceptions entered before first
-- completion. A new completion or identity/day context preserves the amount but
-- requires review, even if the resulting group contains only one delivery.
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'v_old_group uuid; v_new_group uuid;',
  'v_manual public.same_customer_fee_decisions%rowtype; v_manual_event_review boolean; v_old_group uuid; v_new_group uuid;');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'v_customer:=public._same_customer_key(d);',
  E'select * into v_manual from public.same_customer_fee_decisions where delivery_id=p_delivery_id order by id desc limit 1;\n  v_manual_event_review:=v_manual.amount is not null and v_exists and e.manual_decision_id=v_manual.id\n    and (e.manual_event_review or e.completion_event_id is distinct from v_event\n      or e.customer_key is distinct from public._same_customer_key(d) or e.business_date is distinct from v_day or e.rider_id is distinct from v_rider);\n  v_customer:=public._same_customer_key(d);');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'base_fee,group_id,active,date_review_reason,pay_state,review_reason)',
  'base_fee,group_id,active,date_review_reason,pay_state,review_reason,manual_amount,manual_reason,manual_decision_id,manual_event_review)');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'v_new_group,v_active,v_date_reason,case when v_active then ''pending'' else ''reversed'' end,v_date_reason)',
  'v_new_group,v_active,v_date_reason,case when v_active then ''pending'' else ''reversed'' end,v_date_reason,v_manual.amount,case when v_manual.amount is not null then v_manual.reason end,v_manual.id,coalesce(v_manual_event_review,false))');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'base_fee=excluded.base_fee,group_id=excluded.group_id,',
  E'manual_amount=excluded.manual_amount,manual_reason=excluded.manual_reason,manual_decision_id=excluded.manual_decision_id,manual_event_review=excluded.manual_event_review,\n    base_fee=excluded.base_fee,group_id=excluded.group_id,');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'same_customer_earnings.active,same_customer_earnings.business_date)',
  'same_customer_earnings.active,same_customer_earnings.business_date,same_customer_earnings.manual_decision_id,same_customer_earnings.manual_event_review)');
select pg_temp.patch_manual_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'excluded.base_fee,excluded.active,excluded.business_date);',
  'excluded.base_fee,excluded.active,excluded.business_date,excluded.manual_decision_id,excluded.manual_event_review);');
select pg_temp.patch_manual_fee('public.review_same_customer_completion_day(uuid,uuid,bigint,date,text)',
  'set business_date=p_accepted_day,group_id=v_group,date_review_reason=null,',
  'set business_date=p_accepted_day,group_id=v_group,date_review_reason=null,manual_event_review=manual_amount is not null and (manual_event_review or business_date is distinct from p_accepted_day),');

create or replace function public.review_same_customer_manual_pay(p_request_id uuid,p_group_id uuid,p_expected_revision bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare g public.same_customer_pay_groups%rowtype; r public.same_customer_manual_reviews%rowtype;
  v_signature text; v_members jsonb; v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required for manual-pay review' using errcode='42501'; end if;
  if p_request_id is null or p_group_id is null or p_expected_revision is null or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>2000 then
    raise exception 'request, group, revision and reason required' using errcode='22023'; end if;
  select * into g from public.same_customer_pay_groups where id=p_group_id;
  if not found then raise exception 'pay group not found' using errcode='P0002'; end if;
  perform public._same_customer_lock_orders(array(select delivery_id from public.same_customer_earnings where group_id=p_group_id and active),array[g.rider_id]);
  perform pg_advisory_xact_lock(hashtextextended('same-customer-manual-review:'||p_request_id::text,0));
  select * into r from public.same_customer_manual_reviews where request_id=p_request_id;
  if found then
    if (r.actor_id,r.group_id,r.expected_revision,r.reason) is distinct from (auth.uid(),p_group_id,p_expected_revision,btrim(p_reason)) then
      raise exception 'request id already used for a different review' using errcode='22023'; end if;
    return r.result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(public._same_customer_pay_lock_key(g.rider_id,g.customer_key,g.business_date),0));
  select * into strict g from public.same_customer_pay_groups where id=p_group_id for update;
  if g.revision<>p_expected_revision then raise exception 'pay group changed; refresh before review' using errcode='40001'; end if;
  if g.state<>'manual_review' then raise exception 'this group does not have a pending manual exception' using errcode='22023'; end if;
  if exists(select 1 from public.same_customer_earnings e join public.settlements s
    on s.subject_type='agent' and s.subject_id=e.rider_id and s.period_date=e.accounting_date and s.voided_at is null
    where e.group_id=p_group_id and e.active) then
    raise exception 'affected rider period is settled; resolve settlement before manual-pay review' using errcode='22023'; end if;
  v_signature:=public._same_customer_manual_signature(p_group_id);
  select jsonb_agg(to_jsonb(e) order by e.delivery_id) into v_members from public.same_customer_earnings e where group_id=p_group_id and active;
  update public.same_customer_pay_groups set manual_review_signature=v_signature where id=p_group_id;
  perform public._recalculate_customer_day_pay(p_group_id);
  select jsonb_build_object('group_id',p_group_id,'revision',revision,'state',state,
    'expected_total',(select sum(expected_amount) from public.same_customer_earnings where group_id=p_group_id and active))
    into v_result from public.same_customer_pay_groups where id=p_group_id;
  insert into public.same_customer_manual_reviews(request_id,group_id,expected_revision,signature,reason,actor_id,reviewed_members,result)
    values(p_request_id,p_group_id,p_expected_revision,v_signature,btrim(p_reason),auth.uid(),v_members,v_result);
  return v_result;
end $$;

create or replace function public.clear_same_customer_manual_fee(p_request_id uuid,p_delivery_id uuid,p_expected_revision bigint,p_reason text)
returns void language plpgsql security definer set search_path=public,auth as $$
declare e public.same_customer_earnings%rowtype; r public.same_customer_fee_decisions%rowtype;
begin
  if not public.is_admin() then raise exception 'admin role required for manual-pay correction' using errcode='42501'; end if;
  if p_request_id is null or p_delivery_id is null or p_expected_revision is null or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>2000 then
    raise exception 'request, delivery, revision and reason required' using errcode='22023'; end if;
  perform public._same_customer_lock_orders(array[p_delivery_id]);
  perform pg_advisory_xact_lock(hashtextextended('same-customer-fee-decision:'||p_request_id::text,0));
  select * into r from public.same_customer_fee_decisions where request_id=p_request_id;
  if found then
    if (r.actor_id,r.delivery_id,r.expected_revision,r.reason,r.source)
      is distinct from (auth.uid(),p_delivery_id,p_expected_revision,btrim(p_reason),'clear_exception'::text) then
      raise exception 'request id already used for another correction' using errcode='22023'; end if;
    return;
  end if;
  perform id from public.deliveries where id=p_delivery_id for update;
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id;
  if not found or not e.active then raise exception 'active earning required' using errcode='22023'; end if;
  if e.revision<>p_expected_revision then raise exception 'earning changed; refresh before correcting' using errcode='40001'; end if;
  if e.manual_amount is null then raise exception 'there is no manual exception to clear' using errcode='22023'; end if;
  if exists(select 1 from public.same_customer_earnings x join public.settlements s
    on s.subject_type='agent' and s.subject_id=x.rider_id and s.period_date=x.accounting_date and s.voided_at is null
    where x.active and (x.delivery_id=e.delivery_id or x.group_id=e.group_id)) then
    raise exception 'affected rider period is settled; resolve settlement before clearing the exception' using errcode='22023'; end if;
  insert into public.same_customer_fee_decisions(delivery_id,amount,reason,actor_id,source,request_id,expected_revision)
    values(p_delivery_id,null,btrim(p_reason),auth.uid(),'clear_exception',p_request_id,p_expected_revision);
  perform public._sync_same_customer_shadow(p_delivery_id);
end $$;

create or replace function public.get_same_customer_pay_group(p_group_id uuid,p_after uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare g public.same_customer_pay_groups%rowtype; v_rows jsonb; v_count integer; v_total numeric;
  v_next uuid; v_name text; v_limit integer:=greatest(1,least(coalesce(p_limit,50),100));
begin
  if not public.is_admin() then raise exception 'admin role required for pay-group review' using errcode='42501'; end if;
  select * into g from public.same_customer_pay_groups where id=p_group_id;
  if not found then return null; end if;
  select display_name into v_name from public.users where id=g.rider_id;
  with ranked as (
    select e.*,row_number() over(order by recorded_at,completion_event_id,delivery_id) position
    from public.same_customer_earnings e where group_id=p_group_id and active
  ), amounts as (
    select *,case when g.state<>'rate_mismatch' then coalesce(manual_amount,round(base_fee*case when position=1 then 1 else 0.5 end,2)) end proposal
    from ranked
  ), page as (
    select * from amounts where p_after is null or delivery_id>p_after order by delivery_id limit v_limit
  )
  select (select count(*) from amounts),(select sum(proposal) from amounts),
    coalesce(jsonb_agg(jsonb_build_object('delivery_id',p.delivery_id,'customer_name',d.customer_name,'vendor_name',c.name,
      'normal_fee',p.base_fee,'multiplier',case when p.position=1 then 1 else 0.5 end,'current_payable',d.agent_payment_snapshot,
      'manual_amount',p.manual_amount,'manual_reason',p.manual_reason,'proposed_amount',p.proposal,'accounting_date',p.accounting_date)
      order by p.delivery_id),'[]'::jsonb),
    case when exists(select 1 from amounts where delivery_id>(select delivery_id from page order by delivery_id desc limit 1))
      then (select delivery_id from page order by delivery_id desc limit 1) end
    into v_count,v_total,v_rows,v_next from page p join public.deliveries d on d.id=p.delivery_id join public.clients c on c.id=d.client_id;
  return jsonb_build_object('group_id',g.id,'revision',g.revision,'state',g.state,'rider_name',v_name,'business_date',g.business_date,
    'total_count',v_count,'proposed_total',v_total,'orders',v_rows,'next_cursor',v_next);
end $$;
select pg_temp.patch_manual_fee('public.get_same_customer_shadow_pay(uuid)',
  '''review_reason'',e.review_reason,''active'',e.active,''revision'',e.revision,',
  '''review_reason'',e.review_reason,''active'',e.active,''revision'',e.revision,''group_id'',e.group_id,''manual_amount'',e.manual_amount,''manual_reason'',e.manual_reason,');

revoke all on function public._same_customer_track_manual_fee(public.deliveries),
 public._same_customer_record_manual_fee(uuid,numeric,text),public._same_customer_manual_signature(uuid),
 public._recalculate_customer_day_pay(uuid) from public,anon,authenticated;
revoke all on function public.get_same_customer_pay_group(uuid,uuid,integer),public.review_same_customer_manual_pay(uuid,uuid,bigint,text),
 public.clear_same_customer_manual_fee(uuid,uuid,bigint,text) from public,anon;
grant execute on function public.get_same_customer_pay_group(uuid,uuid,integer),public.review_same_customer_manual_pay(uuid,uuid,bigint,text),
 public.clear_same_customer_manual_fee(uuid,uuid,bigint,text) to authenticated;
commit;
