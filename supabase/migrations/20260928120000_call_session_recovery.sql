-- Call sessions survive navigation. Expire stale rings on retry/recovery instead
-- of making the user wait for the minute-based cron. No outbound calls here.
begin;

create or replace function public.get_my_active_call(p_device_uuid uuid)
returns public.calls language plpgsql security definer set search_path=public,auth
as $$
declare v_user uuid := auth.uid(); v_call public.calls%rowtype;
begin
  if v_user is null then raise exception 'not signed in' using errcode='28000'; end if;
  if p_device_uuid is null then raise exception 'device required' using errcode='22023'; end if;
  if not exists(select 1 from public.users where id=v_user and is_active) then
    raise exception 'caller is not an active user' using errcode='42501';
  end if;
  update public.calls set status='missed',ended_at=now()
    where status='ringing' and ringing_until<=now()
      and (caller_id=v_user or callee_id=v_user);
  select * into v_call from public.calls
    where (caller_id=v_user and caller_device_uuid=p_device_uuid and status in ('ringing','accepted'))
       or (callee_id=v_user and accepted_device_uuid=p_device_uuid and status='accepted')
    order by (status='accepted') desc,created_at desc limit 1;
  return v_call;
end $$;
revoke all on function public.get_my_active_call(uuid) from public,anon;
grant execute on function public.get_my_active_call(uuid) to authenticated;

create or replace function public.initiate_call(
  p_callee_id uuid, p_caller_device_uuid uuid, p_related_delivery_id uuid,
  p_client_uuid uuid, p_callee_audience text default 'user'
) returns public.calls language plpgsql security definer set search_path=public,auth
as $$
declare
  v_caller uuid := auth.uid(); v_role text; v_active boolean;
  v_existing public.calls%rowtype; v_new public.calls%rowtype; v_user uuid;
begin
  if v_caller is null then raise exception 'not signed in' using errcode='28000'; end if;
  if p_caller_device_uuid is null then
    raise exception 'p_caller_device_uuid is required' using errcode='22023'; end if;
  if p_callee_audience is null or p_callee_audience not in ('user','ops_team') then
    raise exception 'invalid call audience' using errcode='22023'; end if;
  if p_callee_audience='user' then
    if p_callee_id is null then raise exception 'callee required' using errcode='22023'; end if;
    if p_callee_id=v_caller then raise exception 'cannot call yourself' using errcode='22023'; end if;
  elsif p_callee_id is not null then
    raise exception 'callee must be null for team calls' using errcode='22023';
  end if;
  select role,is_active into v_role,v_active from public.users where id=v_caller;
  if not coalesce(v_active,false) then
    raise exception 'caller is not an active user' using errcode='42501'; end if;
  if v_role='agent' and p_callee_audience<>'ops_team' then
    raise exception 'agents may only place team calls' using errcode='42501'; end if;

  -- Serialize simultaneous taps and cross-calls in a deterministic lock order.
  for v_user in select distinct id from unnest(array[v_caller,p_callee_id]) id
    where id is not null order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended('reda-call:'||v_user::text,0));
  end loop;

  if p_callee_audience='user' then
    select is_active into v_active from public.users where id=p_callee_id;
    if not coalesce(v_active,false) then
      raise exception 'callee is not an active user' using errcode='42501'; end if;
  end if;
  if p_related_delivery_id is not null and not exists(
    select 1 from public.deliveries where id=p_related_delivery_id and deleted_at is null
  ) then raise exception 'related delivery not found' using errcode='P0002'; end if;

  update public.calls set status='missed',ended_at=now()
    where status='ringing' and ringing_until<=now()
      and (caller_id in (v_caller,p_callee_id) or callee_id in (v_caller,p_callee_id));

  -- A repeat Call tap resumes the existing session, including an accepted call.
  select * into v_existing from public.calls
    where status in ('ringing','accepted') and (caller_id=v_caller or callee_id=v_caller)
    order by (status='accepted') desc,created_at desc limit 1;
  if found then
    if (v_existing.caller_id=v_caller and v_existing.caller_device_uuid=p_caller_device_uuid)
      or (v_existing.callee_id=v_caller and v_existing.status='accepted'
          and v_existing.accepted_device_uuid=p_caller_device_uuid) then
      return v_existing;
    end if;
    if v_existing.callee_id=v_caller and v_existing.status='ringing' then
      raise exception 'You are receiving a call. Answer or decline it first.' using errcode='55000';
    end if;
    raise exception 'You already have a call on another device. End that call first.' using errcode='55000';
  end if;

  -- Retry identity is scoped to the caller and device, never another user's row.
  if p_client_uuid is not null then
    select * into v_existing from public.calls where client_uuid=p_client_uuid;
    if found then
      if v_existing.caller_id<>v_caller or v_existing.caller_device_uuid<>p_caller_device_uuid then
        raise exception 'call request belongs to another session' using errcode='42501'; end if;
      return v_existing;
    end if;
  end if;
  if p_callee_id is not null and exists(select 1 from public.calls
    where status in ('ringing','accepted') and (caller_id=p_callee_id or callee_id=p_callee_id)) then
    raise exception 'This person is already on a call or receiving another call. Try again shortly.' using errcode='55000';
  end if;
  begin
    insert into public.calls(caller_id,callee_id,callee_audience,caller_device_uuid,
      status,related_delivery_id,client_uuid,ringing_until)
    values(v_caller,p_callee_id,p_callee_audience,p_caller_device_uuid,
      'ringing',p_related_delivery_id,p_client_uuid,now()+interval '45 seconds') returning * into v_new;
  exception when unique_violation then
    raise exception 'A call is already ringing. Return to it or try again shortly.' using errcode='55000';
  end;
  perform public.write_audit('call',v_new.id,null,
    jsonb_build_object('status','ringing','caller_id',v_caller,'callee_id',p_callee_id,
      'callee_audience',p_callee_audience,'related_delivery_id',p_related_delivery_id),
    case when p_callee_audience='ops_team' then 'team-call initiated' else 'initiated by caller' end,v_caller);
  return v_new;
end $$;
-- Accept participates in the same locks as initiation. An expired invitation
-- cannot revive after the caller has already moved to a new call.
create or replace function public.accept_call(p_call_id uuid,p_device_uuid uuid)
returns public.calls language plpgsql security definer set search_path=public,auth
as $$
declare v_user uuid:=auth.uid(); v_lock uuid; v_row public.calls%rowtype; v_audience text;
begin
  if v_user is null then raise exception 'not signed in' using errcode='28000'; end if;
  if p_device_uuid is null then raise exception 'device required' using errcode='22023'; end if;
  if not exists(select 1 from public.users where id=v_user and is_active) then
    raise exception 'user is not active' using errcode='42501'; end if;
  select * into v_row from public.calls where id=p_call_id;
  if not found then raise exception 'call not found' using errcode='P0002'; end if;
  if not coalesce((v_row.callee_id=v_user or
    (v_row.callee_audience='ops_team' and public.is_admin_or_dispatcher() and v_row.caller_id<>v_user)),false)
    or (v_row.callee_id is null and v_row.callee_audience<>'ops_team') then
    raise exception 'This call is not available to answer.' using errcode='55000'; end if;
  for v_lock in select distinct id from unnest(array[v_user,v_row.caller_id]) id order by id loop
    perform pg_advisory_xact_lock(hashtextextended('reda-call:'||v_lock::text,0));
  end loop;
  select * into v_row from public.calls where id=p_call_id;
  if v_row.status='accepted' and v_row.callee_id=v_user and v_row.accepted_device_uuid=p_device_uuid then
    return v_row;
  end if;
  if v_row.status<>'ringing' or v_row.ringing_until<=now() then
    raise exception 'This call has ended or expired.' using errcode='55000'; end if;
  if exists(select 1 from public.calls where id<>p_call_id
    and (caller_id=v_user or callee_id=v_user)
    and (status='accepted' or (status='ringing' and ringing_until>now()))) then
    raise exception 'End your current call before answering another.' using errcode='55000'; end if;
  v_audience:=v_row.callee_audience;
  update public.calls set status='accepted',accepted_device_uuid=p_device_uuid,started_at=now(),
    callee_id=v_user,callee_audience='user'
    where id=p_call_id and status='ringing' and ringing_until>now()
      and (callee_id=v_user or (callee_audience='ops_team' and public.is_admin_or_dispatcher()))
    returning * into v_row;
  if not found then raise exception 'This call is no longer available.' using errcode='55000'; end if;
  perform public.write_audit('call',v_row.id,jsonb_build_object('status','ringing'),
    jsonb_build_object('status','accepted','accepted_device_uuid',p_device_uuid,
      'callee_id',v_user,'started_at',v_row.started_at),
    case when v_audience='ops_team' then 'team call accepted by ops user' else 'accepted by callee' end,v_user);
  return v_row;
end $$;
revoke all on function public.accept_call(uuid,uuid) from public,anon;
grant execute on function public.accept_call(uuid,uuid) to authenticated;
revoke all on function public.initiate_call(uuid,uuid,uuid,uuid,text) from public,anon;
grant execute on function public.initiate_call(uuid,uuid,uuid,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
