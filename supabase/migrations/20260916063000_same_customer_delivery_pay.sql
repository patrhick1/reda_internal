-- Bounded, role-scoped pay metadata for delivery details and future list adapters.
-- This does not activate the policy or change operational delivery visibility.
begin;
create or replace function public.get_delivery_pay_state(p_delivery_ids uuid[])
returns table(delivery_id uuid,mode text,state text,amount numeric,margin numeric,
  business_date date,multiplier numeric,manual_exception boolean)
language plpgsql stable security definer set search_path=public,auth as $$
declare v_admin boolean:=public.is_admin(); v_actor uuid:=auth.uid();
begin
  if v_actor is null or not (v_admin or exists(select 1 from public.users where id=v_actor and role='agent')) then
    raise exception 'admin or agent role required' using errcode='42501'; end if;
  if p_delivery_ids is null or cardinality(p_delivery_ids)>500 then
    raise exception 'provide at most 500 delivery ids' using errcode='22023'; end if;
  return query
  with visible as (
    select d.id,d.charged_snapshot,d.agent_payment_snapshot,e.policy_applied,e.active,
      e.final_state,e.final_amount,e.business_date,e.multiplier,e.manual_amount,
      (v_admin or e.rider_id=v_actor) owns_earning
    from public.deliveries d left join public.same_customer_earnings e on e.delivery_id=d.id
    where d.id=any(p_delivery_ids) and d.deleted_at is null
      and (v_admin or d.assigned_agent_id=v_actor or (e.policy_applied and e.rider_id=v_actor))
  ), classified as (
    select *,case
      when coalesce(policy_applied,false) and not owns_earning then 'not_earned'
      when coalesce(policy_applied,false) and not active then 'reversed'
      when coalesce(policy_applied,false) and final_state='ready' and final_amount is not null then 'ready'
      when coalesce(policy_applied,false) then 'pending'
      else 'legacy' end resolved_state
    from visible
  ), priced as (
    select *,case when resolved_state='ready' then final_amount
      when resolved_state='legacy' then agent_payment_snapshot end payable
    from classified
  )
  select id,case when coalesce(policy_applied,false) then 'final' else 'legacy' end,
    resolved_state,payable,
    case when v_admin and resolved_state in ('ready','legacy') then coalesce(charged_snapshot,0)-coalesce(payable,0) end,
    case when owns_earning and policy_applied then priced.business_date end,
    case when owns_earning and policy_applied then priced.multiplier end,
    coalesce(owns_earning and policy_applied and manual_amount is not null,false)
  from priced order by id;
end $$;
revoke all on function public.get_delivery_pay_state(uuid[]) from public,anon;
grant execute on function public.get_delivery_pay_state(uuid[]) to authenticated;

create or replace function public.get_negative_margin_delivery_ids(p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path=public,auth as $$
declare v_result jsonb;
begin
  if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  with priced as (
    select d.id,d.created_at,coalesce(d.charged_snapshot,0)-case
      when coalesce(e.policy_applied,false) then case when e.active and e.final_state='ready' then e.final_amount end
      else coalesce(d.agent_payment_snapshot,0) end margin
    from public.deliveries d left join public.same_customer_earnings e on e.delivery_id=d.id
    where d.deleted_at is null and d.order_type='delivery'
  ), negative as (
    select * from priced where margin<0
  ), page as (
    select * from negative order by created_at desc,id desc limit greatest(0,least(coalesce(p_limit,200),200))
  )
  select jsonb_build_object('total_count',(select count(*) from negative),
    'delivery_ids',coalesce((select jsonb_agg(id order by created_at desc,id desc) from page),'[]'::jsonb)) into v_result;
  return v_result;
end $$;
revoke all on function public.get_negative_margin_delivery_ids(integer) from public,anon;
grant execute on function public.get_negative_margin_delivery_ids(integer) to authenticated;
commit;
