-- Agent self-counts reuse stock_counts. A submission header distinguishes a
-- COMPLETE weekly self-count from existing partial dispatcher/warehouse counts,
-- and represents an explicit no-stock confirmation without fake product rows.
begin;

create table if not exists public.agent_stock_count_submissions (
  batch_id uuid primary key,
  agent_id uuid not null references public.users(id),
  week_ending date not null check (extract(dow from week_ending) = 6),
  counted_at timestamptz not null default now(),
  note text,
  items_count integer not null,
  off_count integer not null,
  -- Snapshot names as well as quantities for a durable historical reference.
  items jsonb not null
);
create index if not exists agent_stock_count_week_idx
  on public.agent_stock_count_submissions(week_ending, agent_id, counted_at desc);
alter table public.agent_stock_count_submissions enable row level security;
revoke all on public.agent_stock_count_submissions from anon, authenticated;
grant select on public.agent_stock_count_submissions to authenticated;
drop policy if exists agent_stock_count_submissions_select on public.agent_stock_count_submissions;
create policy agent_stock_count_submissions_select on public.agent_stock_count_submissions
  for select to authenticated using (
    (select public.is_admin_or_dispatcher()) or (select public.is_warehouse()) or agent_id = (select auth.uid())
  );

-- Preserve operations/warehouse reads and add only the agent's OWN counts.
drop policy if exists stock_counts_select on public.stock_counts;
create policy stock_counts_select on public.stock_counts for select to authenticated
  using ((select public.is_admin_or_dispatcher()) or (select public.is_warehouse()) or holder_id = (select auth.uid()));

create or replace function public.record_agent_stock_count(
  p_batch_id uuid, p_week_ending date, p_items jsonb, p_expected jsonb,
  p_note text default null, p_no_stock boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $fn$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_week date;
  v_actual jsonb;
  v_items jsonb;
  v_prior public.agent_stock_count_submissions%rowtype;
  v_count integer;
  v_off integer;
begin
  if not exists (select 1 from public.users where id = v_actor and role = 'agent' and is_active) then
    raise exception 'Only active agents can submit their own weekly count' using errcode = '42501';
  end if;
  if p_batch_id is null then raise exception 'Count reference required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('agent-count:' || p_batch_id::text, 0));
  select * into v_prior from public.agent_stock_count_submissions where batch_id = p_batch_id;
  if found then
    if v_prior.agent_id <> v_actor then raise exception 'Count reference belongs to another agent' using errcode = '42501'; end if;
    -- A retry returns the original receipt, even if stock or week has changed.
    return jsonb_build_object('recorded', v_prior.items_count, 'matched', v_prior.items_count - v_prior.off_count,
      'off', v_prior.off_count, 'items', v_prior.items, 'week_ending', v_prior.week_ending);
  end if;
  if exists (select 1 from public.stock_counts where batch_id = p_batch_id) then
    raise exception 'Count reference already used' using errcode = '22023';
  end if;
  v_week := v_today - ((extract(dow from v_today)::integer + 1) % 7);
  if p_week_ending is distinct from v_week then
    raise exception 'A new count week has started. Reload stock and count again.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_typeof(p_expected) is distinct from 'object' then
    raise exception 'Count items and stock snapshot required' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) i
    where jsonb_typeof(i->'counted_qty') is distinct from 'number'
       or (i->>'counted_qty') !~ '^[0-9]{1,6}$'
       or i->>'product_catalog_id' is null
  ) then raise exception 'Enter a whole physical quantity of zero or more for every product' using errcode = '22023'; end if;
  if (select count(*) <> count(distinct i->>'product_catalog_id') from jsonb_array_elements(p_items) i) then
    raise exception 'A product cannot be counted twice' using errcode = '22023';
  end if;

  select coalesce(jsonb_object_agg(s.product_catalog_id::text, s.quantity_on_hand), '{}'::jsonb)
    into v_actual from public.current_stock s where s.agent_id = v_actor and s.quantity_on_hand <> 0;
  if v_actual <> p_expected then
    raise exception 'Stock changed while you were counting. Reload stock and recheck your quantities.' using errcode = '40001';
  end if;
  if exists (select 1 from jsonb_object_keys(v_actual) k where not exists (
    select 1 from jsonb_array_elements(p_items) i where i->>'product_catalog_id' = k
  )) then raise exception 'Count every product before submitting' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) i where not exists (
    select 1 from public.product_catalog p where p.id = (i->>'product_catalog_id')::uuid
      and (p.is_active or v_actual ? p.id::text)
  )) then raise exception 'A counted product is unavailable. Reload stock.' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) = 0 and not coalesce(p_no_stock, false) then
    raise exception 'Confirm that you physically hold no stock' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_catalog_id', p.id, 'product_name', p.product_name,
    'expected_qty', coalesce((v_actual->>p.id::text)::integer, 0),
    'counted_qty', (i->>'counted_qty')::integer,
    'variance', (i->>'counted_qty')::integer - coalesce((v_actual->>p.id::text)::integer, 0)
  ) order by p.product_name), '[]'::jsonb) into v_items
  from jsonb_array_elements(p_items) i join public.product_catalog p on p.id = (i->>'product_catalog_id')::uuid;
  v_count := jsonb_array_length(v_items);
  select count(*) into v_off from jsonb_array_elements(v_items) i where (i->>'variance')::integer <> 0;
  insert into public.agent_stock_count_submissions(batch_id, agent_id, week_ending, note, items_count, off_count, items)
    values (p_batch_id, v_actor, v_week, nullif(trim(p_note), ''), v_count, v_off, v_items);
  insert into public.stock_counts(batch_id, holder_id, product_catalog_id, expected_qty, counted_qty, variance, counted_by, note)
    select p_batch_id, v_actor, (i->>'product_catalog_id')::uuid, (i->>'expected_qty')::integer,
      (i->>'counted_qty')::integer, (i->>'variance')::integer, v_actor, nullif(trim(p_note), '')
    from jsonb_array_elements(v_items) i;
  perform public.write_audit('stock_count', p_batch_id, null,
    jsonb_build_object('holder_id', v_actor, 'week_ending', v_week, 'recorded', v_count, 'off', v_off),
    'agent weekly stock count', v_actor);
  return jsonb_build_object('recorded', v_count, 'matched', v_count - v_off, 'off', v_off,
    'items', v_items, 'week_ending', v_week);
end;
$fn$;

-- New read RPCs avoid altering the return contract used by older app builds.
create or replace function public.list_stock_count_batches_v2(
  p_limit integer default 30, p_cursor_at timestamptz default null,
  p_cursor_batch uuid default null, p_holder_id uuid default null, p_week_ending date default null
) returns table(batch_id uuid, holder_id uuid, counted_at timestamptz, counted_by uuid,
  note text, items_count integer, off_count integer, holder_name text, counted_by_name text, week_ending date)
language plpgsql stable security definer set search_path = public, auth
as $fn$
declare v_ops boolean := coalesce(public.is_admin_or_dispatcher() or public.is_warehouse(), false);
begin
  if auth.uid() is null or not exists (select 1 from public.users u where u.id = auth.uid() and u.is_active) then
    raise exception 'Sign in to view counts' using errcode = '42501';
  end if;
  if not v_ops and p_holder_id is not null and p_holder_id <> auth.uid() then
    raise exception 'You can only view your own counts' using errcode = '42501';
  end if;
  return query
  with batches as (
    select s.batch_id, s.agent_id as holder_id, s.counted_at, s.agent_id as counted_by,
      s.note, s.items_count, s.off_count, s.week_ending
    from public.agent_stock_count_submissions s
    where (v_ops or s.agent_id = auth.uid()) and (p_holder_id is null or s.agent_id = p_holder_id)
      and (p_week_ending is null or s.week_ending = p_week_ending)
    union all
    select c.batch_id, c.holder_id, max(c.counted_at), c.counted_by, c.note,
      count(*)::integer, count(*) filter(where c.variance <> 0)::integer, null::date
    from public.stock_counts c
    where (v_ops or c.holder_id = auth.uid()) and (p_holder_id is null or c.holder_id = p_holder_id)
      and p_week_ending is null
      and not exists (select 1 from public.agent_stock_count_submissions s where s.batch_id = c.batch_id)
    group by c.batch_id, c.holder_id, c.counted_by, c.note
  )
  select b.batch_id, b.holder_id, b.counted_at, b.counted_by, b.note, b.items_count, b.off_count,
    h.display_name::text, a.display_name::text, b.week_ending from batches b
    left join public.users h on h.id = b.holder_id left join public.users a on a.id = b.counted_by
  where p_cursor_at is null or (b.counted_at, b.batch_id) < (p_cursor_at, p_cursor_batch)
  order by b.counted_at desc, b.batch_id desc limit least(greatest(coalesce(p_limit, 30), 1), 100);
end;
$fn$;

create or replace function public.list_stock_count_items(p_batch_id uuid)
returns table(id uuid, batch_id uuid, holder_id uuid, product_catalog_id uuid, expected_qty integer,
  counted_qty integer, variance integer, counted_by uuid, counted_at timestamptz, note text, product_name text)
language plpgsql stable security definer set search_path = public, auth
as $fn$
begin
  if auth.uid() is null or not exists (select 1 from public.users u where u.id = auth.uid() and u.is_active) then
    raise exception 'Sign in to view counts' using errcode = '42501';
  end if;
  return query select c.id, c.batch_id, c.holder_id, c.product_catalog_id, c.expected_qty,
    c.counted_qty, c.variance, c.counted_by, c.counted_at, c.note,
    coalesce(saved.item->>'product_name', p.product_name)::text
  from public.stock_counts c join public.product_catalog p on p.id = c.product_catalog_id
  left join public.agent_stock_count_submissions s on s.batch_id = c.batch_id
  left join lateral (
    select i as item from jsonb_array_elements(s.items) i where i->>'product_catalog_id' = c.product_catalog_id::text
  ) saved on true
  where c.batch_id = p_batch_id
    and (public.is_admin_or_dispatcher() or public.is_warehouse() or c.holder_id = auth.uid())
  order by p.product_name;
end;
$fn$;

create or replace function public.list_weekly_agent_stock_counts(p_week_ending date)
returns table(agent_id uuid, agent_name text, batch_id uuid, counted_at timestamptz,
  items_count integer, off_count integer, is_late boolean)
language plpgsql stable security definer set search_path = public, auth
as $fn$
begin
  if not coalesce(public.is_admin_or_dispatcher(), false) then
    raise exception 'Operations access required' using errcode = '42501';
  end if;
  if p_week_ending is null or extract(dow from p_week_ending) <> 6 then
    raise exception 'Choose a Saturday' using errcode = '22023';
  end if;
  return query select u.id, u.display_name::text, s.batch_id, s.counted_at, s.items_count, s.off_count,
    coalesce((s.counted_at at time zone 'Africa/Lagos')::date > p_week_ending, false)
  from public.users u
  left join lateral (
    select sub.* from public.agent_stock_count_submissions sub
    where sub.agent_id = u.id and sub.week_ending = p_week_ending
    order by sub.counted_at desc, sub.batch_id desc limit 1
  ) s on true
  where u.role = 'agent' and (u.is_active or s.batch_id is not null)
    and (u.created_at at time zone 'Africa/Lagos')::date < p_week_ending + 7
  order by (s.batch_id is not null), u.display_name;
end;
$fn$;

-- Catalog names only, for reporting physical stock absent from the app list.
create or replace function public.list_agent_count_products()
returns table(id uuid, product_name text)
language sql stable security definer set search_path = public, auth
as $fn$
  select p.id, p.product_name::text from public.product_catalog p
  where p.is_active and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'agent' and u.is_active)
  order by p.product_name;
$fn$;

revoke all on function public.record_agent_stock_count(uuid,date,jsonb,jsonb,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.list_stock_count_batches_v2(integer,timestamptz,uuid,uuid,date) from public, anon, authenticated, service_role;
revoke all on function public.list_stock_count_items(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_weekly_agent_stock_counts(date) from public, anon, authenticated, service_role;
revoke all on function public.list_agent_count_products() from public, anon, authenticated, service_role;
grant execute on function public.record_agent_stock_count(uuid,date,jsonb,jsonb,text,boolean) to authenticated;
grant execute on function public.list_stock_count_batches_v2(integer,timestamptz,uuid,uuid,date) to authenticated;
grant execute on function public.list_stock_count_items(uuid) to authenticated;
grant execute on function public.list_weekly_agent_stock_counts(date) to authenticated;
grant execute on function public.list_agent_count_products() to authenticated;
notify pgrst, 'reload schema';
commit;
