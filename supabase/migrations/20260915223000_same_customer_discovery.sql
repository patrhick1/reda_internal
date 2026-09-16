-- Same-customer discovery with explicit manual assignment. No payout mutations.
-- Defaults OFF; deploy compatible clients before enabling discovery.
begin;

create or replace function public._same_customer_phone_v1(p_phone text)
returns text language sql immutable parallel safe set search_path = public
as $$
  with raw as (
    select case when btrim(coalesce(p_phone,'')) ~ '^[+0-9(). -]+$'
      then regexp_replace(p_phone, '[^0-9]', '', 'g') end as digits
  ), subscriber as (
    select case when digits like '00234%' then substring(digits from 6)
      when digits like '234%' then substring(digits from 4)
      when digits like '0%' then substring(digits from 2) else digits end as n
    from raw
  )
  -- A plausible Nigerian mobile number, not proof of identity/reachability.
  select case when n ~ '^[789][0-9]{9}$' then '+234' || n end from subscriber;
$$;

alter table public.deliveries
  add column if not exists same_customer_phone text
    generated always as (public._same_customer_phone_v1(customer_phone)) stored,
  add column if not exists same_customer_phone_alt text
    generated always as (public._same_customer_phone_v1(customer_phone_alt)) stored,
  add column if not exists same_customer_key_override uuid,
  add column if not exists same_customer_match_mode text not null default 'auto'
    check (same_customer_match_mode in ('auto','linked','separate')),
  add column if not exists same_customer_match_revision bigint not null default 0;

create index if not exists deliveries_same_customer_primary_idx
  on public.deliveries(scheduled_date,same_customer_phone)
  where deleted_at is null and order_type='delivery' and same_customer_phone is not null;
create index if not exists deliveries_same_customer_alt_idx
  on public.deliveries(scheduled_date,same_customer_phone_alt)
  where deleted_at is null and order_type='delivery' and same_customer_phone_alt is not null;
create index if not exists deliveries_same_customer_override_idx
  on public.deliveries(same_customer_key_override,scheduled_date)
  where deleted_at is null and same_customer_key_override is not null;

-- Table UPDATE permissions must not bypass the reason/revision/audit RPC.
-- SECURITY INVOKER deliberately distinguishes direct API writes from the
-- owner's SECURITY DEFINER correction function. Contact edits stale old forms.
create or replace function public._guard_same_customer_identity()
returns trigger language plpgsql set search_path=public as $$
declare v_owner name; v_changed boolean;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid=TG_RELID;
  if TG_OP='INSERT' then
    v_changed:=new.same_customer_key_override is not null or new.same_customer_match_mode<>'auto'
      or new.same_customer_match_revision<>0;
  else
    v_changed:=(new.same_customer_key_override,new.same_customer_match_mode,new.same_customer_match_revision)
      is distinct from (old.same_customer_key_override,old.same_customer_match_mode,old.same_customer_match_revision);
  end if;
  if v_changed and current_user<>v_owner then
    raise exception 'use the audited customer-match correction action' using errcode='42501';
  end if;
  if TG_OP='UPDATE' and (new.customer_phone,new.customer_phone_alt,new.scheduled_date)
      is distinct from (old.customer_phone,old.customer_phone_alt,old.scheduled_date) then
    new.same_customer_match_revision:=old.same_customer_match_revision+1;
  end if;
  return new;
end $$;
revoke all on function public._guard_same_customer_identity() from public,anon,authenticated;
drop trigger if exists guard_same_customer_identity on public.deliveries;
create trigger guard_same_customer_identity before insert or update on public.deliveries
  for each row execute function public._guard_same_customer_identity();

create table if not exists public.same_customer_decisions (
  request_id uuid primary key,
  actor_id uuid not null references public.users(id),
  action text not null check(action in ('link','split','reset')),
  delivery_ids uuid[] not null,
  request_orders jsonb not null default '[]'::jsonb,
  reason text not null check(length(btrim(reason))>0),
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.same_customer_decisions add column if not exists request_orders jsonb not null default '[]'::jsonb;
alter table public.same_customer_decisions enable row level security;
revoke all on public.same_customer_decisions from public,anon,authenticated;

create table if not exists public.same_customer_assignment_requests (
  request_id uuid primary key, actor_id uuid not null references public.users(id),
  agent_id uuid not null references public.users(id), delivery_ids uuid[] not null,
  result jsonb not null, created_at timestamptz not null default now()
);
alter table public.same_customer_assignment_requests enable row level security;
revoke all on public.same_customer_assignment_requests from public,anon,authenticated;

insert into public.feature_flags(key,enabled,description)
values ('same_customer_discovery',false,'Find separate orders for the same customer. Assignment stays manual.')
on conflict(key) do nothing;

create or replace function public.get_same_customer_config()
returns jsonb language plpgsql stable security definer set search_path=public,auth
as $$ begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  return jsonb_build_object('discovery_enabled',
    coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false),
    'normalization_version',1);
end $$;

-- Private identity adapter. Blank/invalid contacts never form a shared key.
create or replace function public._same_customer_key(p_delivery public.deliveries)
returns text language sql immutable set search_path=public
as $$ select case when p_delivery.same_customer_key_override is not null
    then 'override:' || p_delivery.same_customer_key_override::text
    when p_delivery.same_customer_phone is not null then 'phone:' || p_delivery.same_customer_phone
    else 'solo:' || p_delivery.id::text end $$;

-- One representative per logical open/fulfilled order, never per race copy.
-- This read adapter does NOT change _find_sibling_deliveries or its triggers.
create or replace function public._same_customer_day_orders(p_day date)
returns table (
  delivery_id uuid,customer_key text,phone text,phone_alt text,match_mode text,
  customer_name text,raw_address text,client_id uuid,agent_id uuid,current_status text,
  revision bigint
)
language sql stable security definer set search_path=public
as $$
  with recursive candidates as materialized (
    select d.*, public._same_customer_key(d) as customer_key
    from public.deliveries d join public.delivery_status_defs s on s.status=d.current_status
    where d.scheduled_date=p_day and d.deleted_at is null and d.order_type='delivery'
      and (s.category<>'terminal' or d.current_status='delivered')
  ), edges as materialized (
    -- Mirror the live sibling predicate, including matching forwarded text.
    -- Identity corrections do not turn race copies into extra payable orders.
    select a.id as a_id,b.id as b_id from candidates a join candidates b
      on a.id<>b.id and a.customer_phone_normalized=b.customer_phone_normalized
      and a.items_fingerprint=b.items_fingerprint
      and (a.text_fingerprint=b.text_fingerprint
        or public._norm_address(a.raw_address)=public._norm_address(b.raw_address))
  ), reachable(origin_id,member_id) as (
    select id,id from candidates
    union
    select r.origin_id,e.b_id from reachable r join edges e on e.a_id=r.member_id
  ), components as (
    select member_id,min(origin_id::text) as logical_key from reachable group by member_id
  ), ranked as (
    select c.*,row_number() over(partition by k.logical_key
      order by (current_status='delivered') desc,created_at,id) as copy_rank
    from candidates c join components k on k.member_id=c.id
  )
  select id,customer_key,same_customer_phone,same_customer_phone_alt,same_customer_match_mode,
    customer_name,raw_address,client_id,assigned_agent_id,current_status,same_customer_match_revision
  from ranked where copy_rank=1;
$$;

create or replace function public._same_customer_day_groups(p_day date)
returns table(group_id text,match_kind text,delivery_ids uuid[])
language sql stable security definer set search_path=public
as $$
  with orders as materialized (select * from public._same_customer_day_orders(p_day)),
  primary_groups as (
    select md5(p_day::text || '|' || customer_key) as group_id,
      case when bool_or(match_mode='linked') then 'linked' else 'primary' end as match_kind,
      array_agg(delivery_id order by delivery_id) as delivery_ids
    from orders group by customer_key having count(*)>1
  ), contacts as (
    select delivery_id,phone from orders where phone is not null
    union
    select delivery_id,phone_alt from orders where phone_alt is not null
  ), alternate_pairs as (
    select distinct a.delivery_id as a_id,b.delivery_id as b_id
    from contacts ca join contacts cb on ca.phone=cb.phone and ca.delivery_id<cb.delivery_id
    join orders a on a.delivery_id=ca.delivery_id join orders b on b.delivery_id=cb.delivery_id
    where a.customer_key<>b.customer_key
      and (ca.phone=a.phone_alt or ca.phone=b.phone_alt)
      and a.match_mode<>'separate' and b.match_mode<>'separate'
      and not (a.match_mode='linked' and b.match_mode='linked')
  )
  select * from primary_groups
  union all
  select md5(p_day::text || '|alternate|' || a_id::text || '|' || b_id::text),
    'alternate',array[a_id,b_id] from alternate_pairs;
$$;

create or replace function public.list_same_customer_orders(
  p_day date,p_after text default null,p_limit integer default 50,
  p_agent_id uuid default null,p_client_id uuid default null,p_search text default null
)
returns jsonb language plpgsql stable security definer set search_path=public,auth
as $$
declare v_result jsonb;
begin
  if not public.is_admin_or_dispatcher() then raise exception 'operations role required' using errcode='42501'; end if;
  if p_day is null or p_limit<1 or p_limit>100 or p_limit is null then
    raise exception 'day and limit between 1 and 100 required' using errcode='22023'; end if;
  if not coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false) then
    return jsonb_build_object('groups','[]'::jsonb,'total_groups',0,'next_cursor',null); end if;
  with orders as materialized (select * from public._same_customer_day_orders(p_day)),
  groups as (
    select g.group_id,g.match_kind,g.delivery_ids,
      count(*)::integer as order_count,count(distinct o.client_id)::integer as vendor_count,
      count(distinct o.agent_id)::integer as rider_count,
      bool_or(o.agent_id is null) as has_unassigned,
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
    group by g.group_id,g.match_kind,g.delivery_ids
  ), filtered as (select * from groups where matching_order_count>0),
  page as (select * from filtered where p_after is null or group_id>p_after order by group_id limit p_limit),
  boundary as (select max(group_id) as last_id from page)
  select jsonb_build_object('groups',coalesce((select jsonb_agg(to_jsonb(p) order by group_id) from page p),'[]'::jsonb),
    'total_groups',(select count(*) from filtered),
    'next_cursor',case when exists(select 1 from filtered where group_id>(select last_id from boundary))
      then (select last_id from boundary) end) into v_result;
  return v_result;
end $$;

create or replace function public.get_same_customer_orders(p_day date,p_group_id text)
returns jsonb language plpgsql stable security definer set search_path=public,auth
as $$ declare v_ids uuid[]; v_kind text; v_orders jsonb;
begin
  if not public.is_admin_or_dispatcher() then raise exception 'operations role required' using errcode='42501'; end if;
  if not coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false) then
    return null; end if;
  select g.delivery_ids,g.match_kind into v_ids,v_kind
    from public._same_customer_day_groups(p_day) g where g.group_id=p_group_id;
  -- A detail-screen entry keeps split/standalone orders reachable for reset.
  if v_ids is null and p_group_id ~ '^order:[0-9a-f-]{36}$' then
    select array[d.id],'single' into v_ids,v_kind from public.deliveries d
      where d.id=substring(p_group_id from 7)::uuid and d.scheduled_date=p_day
        and d.deleted_at is null and d.order_type='delivery';
  end if;
  if v_ids is null then return null; end if;
  select jsonb_agg(jsonb_build_object(
    'id',d.id,'customer_name',d.customer_name,'customer_phone',d.customer_phone,
    'customer_phone_alt',d.customer_phone_alt,'raw_address',d.raw_address,
    'scheduled_date',d.scheduled_date,'status',d.current_status,
    'client_name',c.name,'agent_id',d.assigned_agent_id,'agent_name',u.display_name,
    'revision',d.same_customer_match_revision,'match_mode',d.same_customer_match_mode,'instructions',d.delivery_instructions,
    'customer_price',d.customer_price,
    'agent_payment',case when public.is_admin() then d.agent_payment_snapshot end,
    'items',coalesce((select jsonb_agg(jsonb_build_object('product_name',p.product_name,
      'quantity',i.quantity_ordered) order by p.product_name,i.id)
      from public.delivery_items i join public.product_catalog p on p.id=i.product_catalog_id
      where i.delivery_id=d.id),'[]'::jsonb)) order by d.id) into v_orders
  from public.deliveries d join public.clients c on c.id=d.client_id
  left join public.users u on u.id=d.assigned_agent_id where d.id=any(v_ids);
  return jsonb_build_object('group_id',p_group_id,'day',p_day,'match_kind',v_kind,'orders',v_orders);
end $$;

create or replace function public.same_customer_badges(p_delivery_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public,auth
as $$ declare v_result jsonb;
begin
  if not public.is_admin_or_dispatcher() then raise exception 'operations role required' using errcode='42501'; end if;
  if cardinality(p_delivery_ids)>500 then raise exception 'maximum 500 deliveries' using errcode='22023'; end if;
  if not coalesce((select enabled from public.feature_flags where key='same_customer_discovery'),false) then return '[]'::jsonb; end if;
  with days as (select distinct scheduled_date from public.deliveries where id=any(p_delivery_ids)),
  groups as (select d.scheduled_date,g.* from days d cross join lateral public._same_customer_day_groups(d.scheduled_date) g),
  badges as (
    select member_id as delivery_id,
      (array_agg(g.group_id order by (g.match_kind='alternate'),g.group_id))[1] as group_id,g.scheduled_date as day,
      (array_agg(cardinality(g.delivery_ids) order by (g.match_kind='alternate'),g.group_id))[1] as order_count,
      (count(*)-1)::integer as additional_groups,
      bool_and(g.match_kind='alternate') as possible_only
    from groups g cross join lateral unnest(g.delivery_ids) member_id
    where member_id=any(p_delivery_ids) group by member_id,g.scheduled_date
  ) select coalesce(jsonb_agg(to_jsonb(b)),'[]'::jsonb) into v_result from badges b;
  return v_result;
end $$;

-- Only managers may change identity facts; idempotency is actor/payload scoped.
-- Future payout migration attaches recalculation to these identity updates.
create or replace function public.correct_delivery_customer_match(
  p_request_id uuid,p_action text,p_orders jsonb,p_reason text
)
returns jsonb language plpgsql security definer set search_path=public,auth
as $$
declare v_ids uuid[]; v_key uuid:=gen_random_uuid(); v_row record; v_prior record; v_result jsonb; v_before jsonb;
begin
  if not public.is_manager() then raise exception 'manager role required' using errcode='42501'; end if;
  if p_request_id is null or p_action is null or p_action not in ('link','split','reset')
    or nullif(btrim(p_reason),'') is null or jsonb_typeof(p_orders) is distinct from 'array' then
    raise exception 'request, action, orders and reason required' using errcode='22023'; end if;
  if jsonb_array_length(p_orders)<1 or jsonb_array_length(p_orders)>100 then
    raise exception 'select between 1 and 100 orders' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_orders) o
      where o->>'id' is null or o->>'revision' is null) then
    raise exception 'order id and expected revision required' using errcode='22023'; end if;
  select array_agg(distinct (o->>'id')::uuid order by (o->>'id')::uuid) into v_ids
    from jsonb_array_elements(p_orders) o;
  if cardinality(v_ids)<>jsonb_array_length(p_orders) or (p_action='link' and cardinality(v_ids)<2) then
    raise exception 'select distinct orders; linking requires at least two' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('same-customer-request:' || p_request_id::text,0));
  select * into v_prior from public.same_customer_decisions where request_id=p_request_id;
  if found then
    if v_prior.actor_id<>auth.uid() or v_prior.action<>p_action or v_prior.delivery_ids<>v_ids
      or v_prior.request_orders<>p_orders or v_prior.reason<>btrim(p_reason) then
      raise exception 'request id already used for a different decision' using errcode='23505'; end if;
    return v_prior.result;
  end if;
  if (select count(*) from public.deliveries where id=any(v_ids) and deleted_at is null and order_type='delivery')<>cardinality(v_ids) then
    raise exception 'an order is missing, deleted or unsupported' using errcode='22023'; end if;
  for v_row in select d.* from public.deliveries d where d.id=any(v_ids) order by d.id for update loop
    if v_row.deleted_at is not null or v_row.order_type<>'delivery' then
      raise exception 'an order changed; refresh before trying again' using errcode='40001'; end if;
    if v_row.same_customer_match_revision<>(select (o->>'revision')::bigint from jsonb_array_elements(p_orders) o where (o->>'id')::uuid=v_row.id) then
      raise exception 'customer match changed; refresh before trying again' using errcode='40001'; end if;
    if v_row.current_status='delivered' and exists(select 1 from public.settlements s
      where s.subject_type='agent' and s.subject_id=v_row.assigned_agent_id
        and s.period_date=v_row.scheduled_date and s.voided_at is null) then
      raise exception 'rider period is settled; void and correct the settlement first' using errcode='23505'; end if;
  end loop;
  select jsonb_agg(jsonb_build_object('id',id,'key_override',same_customer_key_override,
    'mode',same_customer_match_mode,'revision',same_customer_match_revision) order by id)
    into v_before from public.deliveries where id=any(v_ids);
  if to_regprocedure('public._lock_same_customer_shadow_for_orders(uuid[])') is not null then
    perform public._lock_same_customer_shadow_for_orders(v_ids);
  end if;
  update public.deliveries set
    same_customer_key_override=case p_action when 'link' then v_key when 'split' then gen_random_uuid() else null end,
    same_customer_match_mode=case p_action when 'link' then 'linked' when 'split' then 'separate' else 'auto' end,
    same_customer_match_revision=same_customer_match_revision+1
  where id=any(v_ids);
  v_result:=jsonb_build_object('updated_count',cardinality(v_ids));
  insert into public.same_customer_decisions(request_id,actor_id,action,delivery_ids,request_orders,reason,result)
    values(p_request_id,auth.uid(),p_action,v_ids,p_orders,btrim(p_reason),v_result);
  perform public.write_audit(p_actor_id:=auth.uid(),p_entity_type:='same_customer',p_entity_id:=p_request_id,
    p_old:=jsonb_build_object('orders',v_before),
    p_new:=jsonb_build_object('action',p_action,'delivery_ids',v_ids,'orders',
      (select jsonb_agg(jsonb_build_object('id',id,'key_override',same_customer_key_override,
        'mode',same_customer_match_mode,'revision',same_customer_match_revision) order by id)
        from public.deliveries where id=any(v_ids))),p_reason:=btrim(p_reason));
  return v_result;
end $$;

-- Explicit manual assignment only. Report every selected order, including those
-- the existing bulk RPC intentionally skips, and preserve request retry results.
create or replace function public.assign_same_customer_orders(p_request_id uuid,p_delivery_ids uuid[],p_agent_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth
as $$ declare v_ids uuid[]; v_prior record; v_result jsonb; v_updated integer;
begin
  if not public.is_manager() then raise exception 'manager role required' using errcode='42501'; end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_delivery_ids) x where x is not null;
  if p_request_id is null or p_agent_id is null or coalesce(cardinality(v_ids),0) not between 1 and 100 then
    raise exception 'request, rider and between 1 and 100 orders required' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('same-customer-assignment:' || p_request_id::text,0));
  select * into v_prior from public.same_customer_assignment_requests where request_id=p_request_id;
  if found then
    if v_prior.actor_id<>auth.uid() or v_prior.agent_id<>p_agent_id or v_prior.delivery_ids<>v_ids then
      raise exception 'assignment request already used for different input' using errcode='23505'; end if;
    return v_prior.result;
  end if;
  perform d.id from public.deliveries d where d.id=any(v_ids) order by d.id for update;
  if exists(select 1 from public.deliveries where id=any(v_ids) and order_type<>'delivery') then
    raise exception 'only ordinary deliveries can be selected here' using errcode='22023'; end if;
  select jsonb_agg(jsonb_build_object('delivery_id',x,'outcome',case
    when d.id is null or d.deleted_at is not null then 'unavailable'
    when s.category='terminal' then 'closed'
    when d.assigned_agent_id=p_agent_id then 'already_assigned'
    else 'assigned' end) order by x) into v_result
  from unnest(v_ids) x left join public.deliveries d on d.id=x
    left join public.delivery_status_defs s on s.status=d.current_status;
  v_updated:=public.bulk_assign_deliveries(v_ids,p_agent_id);
  v_result:=jsonb_build_object('updated_count',v_updated,'orders',v_result);
  insert into public.same_customer_assignment_requests(request_id,actor_id,agent_id,delivery_ids,result)
    values(p_request_id,auth.uid(),p_agent_id,v_ids,v_result);
  return v_result;
end $$;

revoke all on function public.assign_same_customer_orders(uuid,uuid[],uuid) from public,anon;
grant execute on function public.assign_same_customer_orders(uuid,uuid[],uuid) to authenticated;
revoke all on function public._same_customer_phone_v1(text),public._same_customer_key(public.deliveries),
  public._same_customer_day_orders(date),public._same_customer_day_groups(date) from public,anon,authenticated;
-- Generated column calculation needs the immutable adapter for authorized writes.
grant execute on function public._same_customer_phone_v1(text) to authenticated;
revoke all on function public.get_same_customer_config(),public.list_same_customer_orders(date,text,integer,uuid,uuid,text),
  public.get_same_customer_orders(date,text),public.same_customer_badges(uuid[]),
  public.correct_delivery_customer_match(uuid,text,jsonb,text) from public,anon;
grant execute on function public.get_same_customer_config(),public.list_same_customer_orders(date,text,integer,uuid,uuid,text),
  public.get_same_customer_orders(date,text),public.same_customer_badges(uuid[]),
  public.correct_delivery_customer_match(uuid,text,jsonb,text) to authenticated;

commit;
