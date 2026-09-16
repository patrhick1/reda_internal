-- Counts and assignment attention share the paginated group definition. No order or pay writes.
begin;
create or replace function public.list_same_customer_orders(
  p_day date,p_after text default null,p_limit integer default 50,
  p_agent_id uuid default null,p_client_id uuid default null,p_search text default null
)
returns jsonb language plpgsql stable security definer set search_path=public,auth
as $$
declare v_result jsonb;
begin
  if not public.is_admin_or_dispatcher() then raise exception 'operations role required' using errcode='42501'; end if;
  if p_day is null or p_limit<0 or p_limit>100 or p_limit is null then
    raise exception 'day and limit between 0 and 100 required' using errcode='22023'; end if;
  if not coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false) then
    return jsonb_build_object('groups','[]'::jsonb,'total_groups',0,'attention_groups',0,'next_cursor',null); end if;
  with orders as materialized (select * from public._same_customer_day_orders(p_day)),
  groups as (
    select g.group_id,g.match_kind,g.delivery_ids,
      count(*)::integer as order_count,count(distinct o.client_id)::integer as vendor_count,
      count(distinct o.agent_id)::integer as rider_count,
      bool_or(o.agent_id is null) as has_unassigned,
      (bool_or(coalesce(s.category,'')<>'terminal')
        and (count(distinct o.agent_id)>1 or bool_or(o.agent_id is null))) as needs_assignment,
      count(distinct public._norm_address(o.raw_address))>1 as addresses_differ,
      min(o.customer_name) as customer_name,
      count(*) filter(where
        (p_agent_id is null or o.agent_id=p_agent_id)
        and (p_client_id is null or o.client_id=p_client_id)
        and (nullif(btrim(p_search),'') is null
          or o.customer_name ilike '%' || btrim(p_search) || '%'
          or o.phone like '%' || nullif(regexp_replace(p_search,'\D','','g'),'') || '%'
          or o.phone_alt like '%' || nullif(regexp_replace(p_search,'\D','','g'),'') || '%'))::integer as matching_order_count
    from public._same_customer_day_groups(p_day) g
    cross join lateral unnest(g.delivery_ids) member_id
    join orders o on o.delivery_id=member_id
    left join public.delivery_status_defs s on s.status=o.current_status
    group by g.group_id,g.match_kind,g.delivery_ids
  ), filtered as (select * from groups where matching_order_count>0),
  page as (select * from filtered where p_after is null or group_id>p_after order by group_id limit p_limit),
  boundary as (select max(group_id) as last_id from page)
  select jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(p) order by group_id) from page p),'[]'::jsonb),
    'total_groups',(select count(*) from filtered),
    'attention_groups',(select count(*) from filtered where needs_assignment),
    'next_cursor',case when p_limit>0 and exists(select 1 from filtered where group_id>(select last_id from boundary))
      then (select last_id from boundary) end) into v_result;
  return v_result;
end $$;

notify pgrst,'reload schema';
commit;
