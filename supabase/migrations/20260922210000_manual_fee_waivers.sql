-- Explicit manager payouts are final decisions, including zero. Only amounts
-- still calculated automatically need compatible baselines. Preserve the
-- existing completion-context and settled-period protections.
begin;

create or replace function public._same_customer_pay_calculation(
  p_group_id uuid,p_override_id uuid default null,p_override_amount numeric default null
) returns table(delivery_id uuid,multiplier numeric,amount numeric,state text,reason text)
language sql stable security definer set search_path=public as $$
  with members as (
    select e.*,case when e.delivery_id=p_override_id then p_override_amount else e.manual_amount end chosen,
      row_number() over(order by e.recorded_at,e.completion_event_id,e.delivery_id) position
    from public.same_customer_earnings e where e.group_id=p_group_id and e.active
  ), checks as (
    select count(*) filter(where chosen is null and (base_fee is null or base_fee<0
      or base_fee::text in ('NaN','Infinity','-Infinity')))>0
      or count(distinct base_fee) filter(where chosen is null)>1 mismatch,
      case when bool_or(manual_event_review and chosen is not null)
        then public._same_customer_manual_signature(p_group_id) end signature from members
  ), decisions as (
    select m.*,case
      when m.date_review_reason is not null then m.date_review_reason
      when m.chosen is not null and m.manual_event_review and m.delivery_id is distinct from p_override_id
        and g.manual_review_signature is distinct from c.signature then 'manual_review'
      when m.chosen is null and c.mismatch then 'rate_mismatch'
    end issue
    from members m cross join checks c join public.same_customer_pay_groups g on g.id=p_group_id
  )
  select delivery_id,case when position=1 then 1::numeric else 0.5::numeric end,
    case when issue is null then coalesce(chosen,round(base_fee*case when position=1 then 1 else 0.5 end,2)) end,
    case when issue is null then 'ready' else 'pending' end,issue from decisions
$$;
revoke all on function public._same_customer_pay_calculation(uuid,uuid,numeric) from public,anon,authenticated;

create or replace function public._recalculate_customer_day_pay(p_group_id uuid)
returns void language plpgsql security definer set search_path=public,auth as $$
declare g public.same_customer_pay_groups%rowtype; v_state text;
begin
  if p_group_id is null then return; end if;
  select * into strict g from public.same_customer_pay_groups where id=p_group_id;
  perform public._same_customer_lock_orders(array(select delivery_id from public.same_customer_earnings where group_id=p_group_id and active),array[g.rider_id],false);
  perform pg_advisory_xact_lock(hashtextextended(public._same_customer_pay_lock_key(g.rider_id,g.customer_key,g.business_date),0));
  perform 1 from public.same_customer_pay_groups where id=p_group_id for update;
  update public.same_customer_earnings e set multiplier=c.multiplier,expected_amount=c.amount,
    pay_state=c.state,review_reason=c.reason,revision=e.revision+1,updated_at=clock_timestamp()
  from public._same_customer_pay_calculation(p_group_id) c where e.delivery_id=c.delivery_id
    and (e.multiplier,e.expected_amount,e.pay_state,e.review_reason) is distinct from (c.multiplier,c.amount,c.state,c.reason);
  select case when bool_or(pay_state='pending' and review_reason='rate_mismatch') then 'rate_mismatch'
    when bool_or(pay_state='pending') then 'manual_review' else 'ready' end into v_state
    from public.same_customer_earnings where group_id=p_group_id and active;
  update public.same_customer_pay_groups set state=v_state,revision=revision+1,updated_at=clock_timestamp() where id=p_group_id;
end $$;

-- Preview and save share the same calculation. The revision covers every member
-- of the group so a newly completed order cannot race a saved preview.
create or replace function public.preview_delivery_charge_correction(
  p_delivery_id uuid,p_charged numeric default null,p_agent_payment numeric default null,
  p_apply_agent_override boolean default false
) returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare d public.deliveries%rowtype; e public.same_customer_earnings%rowtype;
  v_rows jsonb; v_total numeric; v_revision text; v_pending boolean;
begin
  if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  select * into d from public.deliveries where id=p_delivery_id and deleted_at is null;
  if not found then raise exception 'delivery not found' using errcode='P0002'; end if;
  if (p_charged is not null and (p_charged<0 or p_charged>99999999.99 or round(p_charged,2)<>p_charged
      or p_charged::text in ('NaN','Infinity','-Infinity')))
    or (p_agent_payment is not null and (p_agent_payment<0 or p_agent_payment>99999999.99
      or round(p_agent_payment,2)<>p_agent_payment or p_agent_payment::text in ('NaN','Infinity','-Infinity'))) then
    raise exception 'enter valid amounts with at most two decimal places' using errcode='22023'; end if;
  select * into e from public.same_customer_earnings where delivery_id=p_delivery_id;
  select md5(jsonb_build_array(d.updated_at,d.charged_snapshot,d.agent_payment_snapshot,e.revision,e.group_id,
    (select revision from public.same_customer_pay_groups where id=e.group_id))::text) into v_revision;
  if e.active and e.group_id is not null and public._same_customer_policy_for_day(e.business_date) then
    select jsonb_agg(jsonb_build_object('delivery_id',x.delivery_id,'customer_name',dx.customer_name,
      'amount',c.amount,'reason',c.reason,'manual',case when x.delivery_id=p_delivery_id and p_apply_agent_override
        then true else x.manual_amount is not null end) order by x.recorded_at,x.completion_event_id,x.delivery_id),
      case when bool_or(c.state='pending') then null else sum(c.amount) end,bool_or(c.state='pending')
    into v_rows,v_total,v_pending
    from public._same_customer_pay_calculation(e.group_id,
      case when p_apply_agent_override then p_delivery_id end,
      case when p_apply_agent_override then coalesce(p_agent_payment,d.agent_payment_snapshot) end) c
    join public.same_customer_earnings x on x.delivery_id=c.delivery_id join public.deliveries dx on dx.id=x.delivery_id;
  else
    v_pending:=coalesce(e.active and e.final_state='pending' and e.date_review_reason is not null,false);
    v_total:=case when v_pending then null else coalesce(p_agent_payment,d.agent_payment_snapshot) end;
    v_rows:=jsonb_build_array(jsonb_build_object('delivery_id',d.id,'customer_name',d.customer_name,
      'amount',v_total,'reason',case when v_pending then e.date_review_reason end,
      'manual',p_apply_agent_override or e.manual_amount is not null));
  end if;
  return jsonb_build_object('revision',v_revision,'charged',d.charged_snapshot,'agent_payment',d.agent_payment_snapshot,
    'proposed_charge',coalesce(p_charged,d.charged_snapshot),'orders',v_rows,'total',v_total,'pending',v_pending,
    'settled',exists(select 1 from public.settlements s where s.voided_at is null and s.subject_type='agent'
      and s.subject_id=e.rider_id and s.period_date=e.accounting_date));
end $$;
revoke all on function public.preview_delivery_charge_correction(uuid,numeric,numeric,boolean) from public,anon;
grant execute on function public.preview_delivery_charge_correction(uuid,numeric,numeric,boolean) to authenticated;

create table if not exists public.delivery_charge_correction_requests (
  request_id uuid primary key,actor_id uuid not null references public.users(id),
  payload jsonb not null,result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table public.delivery_charge_correction_requests enable row level security;
revoke all on public.delivery_charge_correction_requests from public,anon,authenticated;

create or replace function public.correct_delivery_charge_v2(p_request_id uuid,p_delivery_id uuid,
  p_revision text,p_charged numeric,p_agent_payment numeric,p_reason text,p_apply_agent_override boolean
) returns jsonb language plpgsql security definer set search_path=public,auth as $$
declare d public.deliveries%rowtype; r public.delivery_charge_correction_requests%rowtype;
  v_payload jsonb; v_preview jsonb; v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  if p_request_id is null or p_delivery_id is null or p_revision is null or p_charged is null or p_agent_payment is null
    or p_apply_agent_override is null or nullif(btrim(p_reason),'') is null or length(btrim(p_reason))>2000 then
    raise exception 'request, revision, amounts and reason required' using errcode='22023'; end if;
  v_payload:=jsonb_build_array(p_delivery_id,p_revision,p_charged,p_agent_payment,btrim(p_reason),p_apply_agent_override);
  perform pg_advisory_xact_lock(hashtextextended('delivery-fee-save:'||p_request_id,0));
  select * into r from public.delivery_charge_correction_requests where request_id=p_request_id;
  if found then
    if r.actor_id<>auth.uid() or r.payload<>v_payload then raise exception 'request already used for a different adjustment' using errcode='22023'; end if;
    return r.result;
  end if;
  perform public._same_customer_lock_orders(array[p_delivery_id]);
  select * into strict d from public.deliveries where id=p_delivery_id for update;
  v_preview:=public.preview_delivery_charge_correction(p_delivery_id,p_charged,p_agent_payment,p_apply_agent_override);
  if v_preview->>'revision'<>p_revision then
    raise exception 'These orders changed. Refresh the amounts before saving.' using errcode='40001'; end if;
  if not p_apply_agent_override and p_agent_payment is distinct from d.agent_payment_snapshot then
    raise exception 'rider pay changed without an explicit adjustment' using errcode='22023'; end if;
  -- Saving an explicitly entered amount unchanged is still a valid decision.
  if p_apply_agent_override and p_agent_payment is not distinct from d.agent_payment_snapshot then
    perform public._same_customer_record_manual_fee(p_delivery_id,p_agent_payment,p_reason);
  end if;
  if (p_charged,p_agent_payment) is distinct from (d.charged_snapshot,d.agent_payment_snapshot) then
    perform public.correct_delivery_charge(p_delivery_id,p_charged,p_agent_payment,p_reason);
  elsif not p_apply_agent_override then
    raise exception 'amounts are unchanged' using errcode='22023';
  end if;
  perform public._sync_same_customer_shadow(p_delivery_id);
  v_result:=public.preview_delivery_charge_correction(p_delivery_id);
  insert into public.delivery_charge_correction_requests(request_id,actor_id,payload,result)
    values(p_request_id,auth.uid(),v_payload,v_result);
  return v_result;
end $$;
revoke all on function public.correct_delivery_charge_v2(uuid,uuid,text,numeric,numeric,text,boolean) from public,anon;
grant execute on function public.correct_delivery_charge_v2(uuid,uuid,text,numeric,numeric,text,boolean) to authenticated;

-- A bounded, indexed detail request is made only when a rider card is opened.
create or replace function public.list_agent_pay_details(p_agent_id uuid,p_from date,p_to date,
  p_after uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_from>p_to or p_limit not between 1 and 50 then
    raise exception 'valid range and page size required' using errcode='22023'; end if;
  with page as (
    select e.delivery_id,d.customer_name,e.final_state,e.final_review_reason,e.final_amount,
      e.manual_amount,e.manual_reason,u.display_name manual_actor,f.created_at manual_at
    from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
    left join public.same_customer_fee_decisions f on f.id=e.manual_decision_id
    left join public.users u on u.id=f.actor_id
    where e.rider_id=p_agent_id and e.accounting_date between p_from and p_to and e.active
      and (e.final_state='pending' or e.manual_amount is not null) and (p_after is null or e.delivery_id>p_after)
    order by e.delivery_id limit p_limit+1
  ), shown as (select * from page order by delivery_id limit p_limit)
  select jsonb_build_object('orders',coalesce((select jsonb_agg(to_jsonb(s) order by delivery_id) from shown s),'[]'::jsonb),
    'next_cursor',case when (select count(*) from page)>p_limit then (select delivery_id from shown order by delivery_id desc limit 1) end)
  into v_result;
  return v_result;
end $$;
revoke all on function public.list_agent_pay_details(uuid,date,date,uuid,integer) from public,anon;
grant execute on function public.list_agent_pay_details(uuid,date,date,uuid,integer) to authenticated;

-- No historical recalculation here: open affected groups are inspected and
-- reconciled separately during release; frozen handovers are never rewritten.
notify pgrst,'reload schema';
commit;
