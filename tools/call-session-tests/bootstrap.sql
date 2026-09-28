-- Isolated, synthetic dependencies for the call RPCs. No notification/network triggers.
create schema auth;
create role anon;
create role authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table public.users(id uuid primary key,role text not null,is_active boolean not null);
create table public.deliveries(id uuid primary key,deleted_at timestamptz);
create table public.calls(
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.users, callee_id uuid references public.users,
  caller_device_uuid uuid not null,accepted_device_uuid uuid,
  agora_channel text not null default 'isolated-test-channel',
  status text not null check(status in ('ringing','accepted','declined','cancelled','missed','completed','failed')),
  related_delivery_id uuid references public.deliveries, client_uuid uuid,
  ringing_until timestamptz not null,started_at timestamptz,ended_at timestamptz,
  duration_seconds integer,last_token_issued_at timestamptz,created_at timestamptz not null default now(),
  callee_audience text not null default 'user' check(callee_audience in ('user','ops_team')),
  check(caller_id<>callee_id),check((callee_audience='user' and callee_id is not null) or (callee_audience='ops_team' and callee_id is null))
);
create unique index calls_one_ringing_per_caller on public.calls(caller_id) where status='ringing';
create unique index calls_one_ringing_per_callee on public.calls(callee_id) where status='ringing' and callee_audience='user';
create unique index calls_client_uuid_uniq on public.calls(client_uuid) where client_uuid is not null;
create table public.call_test_audit(id uuid,after_data jsonb);
create function public.write_audit(text,uuid,jsonb,jsonb,text,uuid) returns void language sql as $$
  insert into public.call_test_audit values($2,$4)
$$;
create function public.is_admin_or_dispatcher() returns boolean language sql stable as $$
  select exists(select 1 from public.users where id=auth.uid() and role in ('admin','dispatcher') and is_active)
$$;
grant usage on schema public,auth to authenticated;
insert into public.users values
  (md5('caller')::uuid,'admin',true),(md5('callee')::uuid,'agent',true),
  (md5('other')::uuid,'admin',true),(md5('inactive')::uuid,'agent',false);
