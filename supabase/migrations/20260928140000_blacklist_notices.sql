-- One durable notice per refused bot message, with per-user acknowledgment.
-- No historical backfill: deploying must not alert staff about old refusals.
begin;
create table public.blacklist_order_notices (
  id bigint generated always as identity primary key,
  inbound_id uuid not null unique references public.bot_inbound_messages(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create table public.blacklist_notice_reads (
  user_id uuid primary key references public.users(id) on delete cascade,
  through_id bigint not null default 0 check (through_id >= 0)
);
create table public.blacklist_notice_push_state (
  singleton boolean primary key default true check (singleton),
  last_sent_at timestamptz
);
insert into public.blacklist_notice_push_state(singleton) values(true);
alter table public.blacklist_order_notices enable row level security;
alter table public.blacklist_notice_reads enable row level security;
alter table public.blacklist_notice_push_state enable row level security;
revoke all on public.blacklist_order_notices,public.blacklist_notice_reads,
  public.blacklist_notice_push_state from public,anon,authenticated;

create function public.tg_notify_blacklisted_order() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_id bigint; v_last timestamptz; v_customer text; v_vendor text;
begin
  if new.status <> 'blocked' then return new; end if;
  if TG_OP='UPDATE' and old.status='blocked' then return new; end if;
  -- Commit ordering and the global push cooldown share one lock. Reprocessing
  -- a message cannot create another notice, even after queued -> blocked.
  perform pg_advisory_xact_lock(hashtextextended('blacklist-order-notices',0));
  insert into public.blacklist_order_notices(inbound_id) values(new.id)
    on conflict(inbound_id) do nothing returning id into v_id;
  if v_id is null then return new; end if;
  select last_sent_at into v_last from public.blacklist_notice_push_state where singleton;
  if v_last is null or v_last <= clock_timestamp()-interval '10 minutes' then
    v_customer := coalesce(nullif(btrim(new.parse_result->'extracted'->>'customer_name'),''),'Customer');
    v_vendor := nullif(btrim(new.parse_result->'product'->>'client_name'),'');
    -- Notification transport failure must never roll back the refusal/notice.
    begin
      perform public.send_edge_notification(jsonb_build_object(
        'audience','admins+dispatchers',
        'title','Order blocked by blacklist',
        'body',left(v_customer,60)||case when v_vendor is null then '' else ' · '||left(v_vendor,40) end||
          '. No delivery created. Open Blocked orders for details.',
        'data',jsonb_build_object('route','review','tab','blocked',
          'kind','blacklist_blocked','inbound_id',new.id)
      ));
      update public.blacklist_notice_push_state set last_sent_at=clock_timestamp() where singleton;
    exception when others then
      raise warning 'Blacklist notice saved; push could not be scheduled';
    end;
  end if;
  return new;
end $$;
create trigger notify_blacklisted_order after insert or update of status
on public.bot_inbound_messages for each row execute function public.tg_notify_blacklisted_order();
revoke all on function public.tg_notify_blacklisted_order() from public,anon,authenticated;

create function public.get_blacklist_notice_summary() returns jsonb
language plpgsql security definer set search_path=public,auth as $$
declare v_seen bigint; v_count bigint; v_latest bigint; v_inbound uuid;
begin
  if not coalesce(public.is_admin_or_dispatcher(),false) or not exists(
    select 1 from public.users where id=auth.uid() and is_active
  ) then raise exception 'permission denied' using errcode='42501'; end if;
  select through_id into v_seen from public.blacklist_notice_reads where user_id=auth.uid();
  select count(*),max(n.id) into v_count,v_latest
    from public.blacklist_order_notices n join public.bot_inbound_messages i on i.id=n.inbound_id
    where n.id>coalesce(v_seen,0) and i.status='blocked';
  select inbound_id into v_inbound from public.blacklist_order_notices where id=v_latest;
  return jsonb_build_object('count',v_count,'through_id',v_latest::text,'inbound_id',v_inbound);
end $$;

create function public.acknowledge_blacklist_notices(p_through_id bigint) returns void
language plpgsql security definer set search_path=public,auth as $$
declare v_limit bigint;
begin
  if not coalesce(public.is_admin_or_dispatcher(),false) or not exists(
    select 1 from public.users where id=auth.uid() and is_active
  ) then raise exception 'permission denied' using errcode='42501'; end if;
  -- Acknowledge only the snapshot the user saw, never subsequent arrivals.
  select coalesce(max(id),0) into v_limit from public.blacklist_order_notices where id<=p_through_id;
  insert into public.blacklist_notice_reads(user_id,through_id) values(auth.uid(),v_limit)
    on conflict(user_id) do update set through_id=greatest(blacklist_notice_reads.through_id,excluded.through_id);
end $$;
revoke all on function public.get_blacklist_notice_summary() from public,anon;
revoke all on function public.acknowledge_blacklist_notices(bigint) from public,anon;
grant execute on function public.get_blacklist_notice_summary() to authenticated;
grant execute on function public.acknowledge_blacklist_notices(bigint) to authenticated;
notify pgrst,'reload schema';
commit;
