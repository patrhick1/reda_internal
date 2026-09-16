-- Explicit pending amounts for updated finance clients. Policy remains off.
begin;
create index if not exists same_customer_final_period_idx
  on public.same_customer_earnings(accounting_date,rider_id,delivery_id) where policy_applied and active;

create or replace function public._same_customer_financial_rows(p_from date,p_to date)
returns table(delivery_id uuid,rider_id uuid,accounting_date date,quantity numeric,paid numeric,
  amount numeric,pay_state text,pay_reason text,business_date date,multiplier numeric,manual boolean)
language sql stable security definer set search_path=public as $$
  select d.id,d.assigned_agent_id,d.scheduled_date,d.quantity_delivered,d.paid,
    coalesce(d.agent_payment_snapshot,0),'legacy'::text,null::text,null::date,null::numeric,false
  from public.deliveries d
  where d.current_status='delivered' and d.deleted_at is null and d.scheduled_date between p_from and p_to
    and not exists(select 1 from public.same_customer_earnings e where e.delivery_id=d.id and e.policy_applied)
  union all
  select e.delivery_id,e.rider_id,e.accounting_date,d.quantity_delivered,d.paid,
    case when e.final_state='ready' then e.final_amount end,
    case when e.final_state='ready' and e.final_amount is not null then 'ready' else 'pending' end,
    e.final_review_reason,e.business_date,e.multiplier,e.manual_amount is not null
  from public.same_customer_earnings e join public.deliveries d on d.id=e.delivery_id
  where e.policy_applied and e.active and e.accounting_date between p_from and p_to
    and d.current_status='delivered' and d.deleted_at is null
$$;

create or replace function public.agent_earnings_summary_v2(p_from date,p_to date)
returns table(agent_id uuid,agent_name text,deliveries_count bigint,total_quantity numeric,
  total_earnings numeric,total_collected numeric,total_remit numeric,known_earnings numeric,pending_pay_count bigint)
language plpgsql stable security definer set search_path=public,auth as $$ begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'valid date range required' using errcode='22023'; end if;
  return query
  select u.id,u.display_name,count(*),coalesce(sum(f.quantity),0),
    case when count(*) filter(where f.pay_state='pending')=0 then coalesce(sum(f.amount),0) end,
    coalesce(sum(f.paid),0),
    case when count(*) filter(where f.pay_state='pending')=0 then coalesce(sum(f.paid),0)-coalesce(sum(f.amount),0) end,
    coalesce(sum(f.amount) filter(where f.pay_state<>'pending'),0),count(*) filter(where f.pay_state='pending')
  from public._same_customer_financial_rows(p_from,p_to) f join public.users u on u.id=f.rider_id
  where u.role='agent' and (public.is_manager() or u.id=auth.uid())
  group by u.id,u.display_name order by u.display_name,u.id;
end $$;

-- Old clients must receive an explicit error instead of treating pending as 0.
-- Completed amounts also use successful ownership, so reassignment cannot move earnings.
create or replace function public.agent_earnings_summary(p_from date,p_to date)
returns table(agent_id uuid,agent_name text,deliveries_count bigint,total_quantity numeric,
  total_earnings numeric,total_collected numeric,total_remit numeric)
language plpgsql stable security definer set search_path=public,auth as $$
declare r record; begin
  for r in select * from public.agent_earnings_summary_v2(p_from,p_to) loop
    if r.pending_pay_count>0 then raise exception 'Rider pay needs review. Update the app to see pending earnings.' using errcode='P0001'; end if;
    agent_id:=r.agent_id; agent_name:=r.agent_name; deliveries_count:=r.deliveries_count;
    total_quantity:=r.total_quantity; total_earnings:=r.total_earnings; total_collected:=r.total_collected; total_remit:=r.total_remit;
    return next;
  end loop;
end $$;

create or replace function public.list_my_earnings_v2(p_from date,p_to date,
  p_after_date date default null,p_after_id uuid default null,p_limit integer default 200)
returns table(id uuid,customer_name text,scheduled_date date,agent_payment_snapshot numeric,product_name text,
  pay_state text,review_reason text,business_date date,multiplier numeric,manual_exception boolean)
language plpgsql stable security definer set search_path=public,auth as $$ begin
  if not exists(select 1 from public.users where users.id=auth.uid() and role='agent') then
    raise exception 'agent role required' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_from>p_to or (p_after_date is null)<>(p_after_id is null) then
    raise exception 'valid range and cursor required' using errcode='22023'; end if;
  return query
  select f.delivery_id,d.customer_name,f.accounting_date,f.amount,p.product_name,
    f.pay_state,f.pay_reason,f.business_date,f.multiplier,f.manual
  from public._same_customer_financial_rows(p_from,p_to) f join public.deliveries d on d.id=f.delivery_id
    left join public.product_catalog p on p.id=d.product_catalog_id
  where f.rider_id=auth.uid() and (p_after_date is null or (f.accounting_date,f.delivery_id)<(p_after_date,p_after_id))
  order by f.accounting_date desc,f.delivery_id desc limit greatest(1,least(coalesce(p_limit,200),200));
end $$;

-- Keep the existing review endpoints compatible in shadow mode, but never label
-- a live pay-changing review as a harmless preview.
create or replace function pg_temp.patch_financial_reader(p_function regprocedure,p_old text,p_new text)
returns void language plpgsql as $$ declare v_definition text; begin
  select pg_get_functiondef(p_function) into v_definition;
  if strpos(v_definition,p_new)>0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
    raise exception 'Unexpected source in %; inspect reader integration',p_function; end if;
  execute replace(v_definition,p_old,p_new);
end $$;
select pg_temp.patch_financial_reader('public.get_same_customer_shadow_pay(uuid)',
  '''mode'',''shadow''',
  '''mode'',case when e.policy_applied then ''final'' when e.final_state=''legacy'' then ''legacy'' else ''shadow'' end');
select pg_temp.patch_financial_reader('public.get_same_customer_shadow_pay(uuid)',
  '''expected_amount'',e.expected_amount,''current_payable_amount'',d.agent_payment_snapshot',
  '''expected_amount'',case when e.policy_applied or e.final_state=''legacy'' then e.final_amount else e.expected_amount end,''current_payable_amount'',case when e.policy_applied then e.final_amount else d.agent_payment_snapshot end');
select pg_temp.patch_financial_reader('public.get_same_customer_shadow_pay(uuid)',
  '''state'',e.pay_state',
  '''state'',case when e.policy_applied then e.final_state when e.final_state=''legacy'' then ''ready'' else e.pay_state end');
select pg_temp.patch_financial_reader('public.get_same_customer_shadow_pay(uuid)',
  '''review_reason'',e.review_reason',
  '''review_reason'',case when e.policy_applied then e.final_review_reason else e.review_reason end');
select pg_temp.patch_financial_reader('public.get_same_customer_pay_group(uuid,uuid,integer)',
  '''current_payable'',d.agent_payment_snapshot',
  '''current_payable'',case when p.policy_applied then p.final_amount else d.agent_payment_snapshot end');
select pg_temp.patch_financial_reader('public.get_same_customer_pay_group(uuid,uuid,integer)',
  '''total_count'',v_count',
  '''mode'',case when exists(select 1 from public.same_customer_earnings where group_id=g.id and active and policy_applied) then ''final'' else ''shadow'' end,''total_count'',v_count');

revoke all on function public._same_customer_financial_rows(date,date) from public,anon,authenticated;
revoke all on function public.agent_earnings_summary_v2(date,date),public.list_my_earnings_v2(date,date,date,uuid,integer) from public,anon;
grant execute on function public.agent_earnings_summary_v2(date,date),public.list_my_earnings_v2(date,date,date,uuid,integer) to authenticated;
commit;
