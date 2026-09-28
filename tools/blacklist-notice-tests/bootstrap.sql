-- Synthetic local dependencies. send_edge_notification records payloads only.
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create table public.users(id uuid primary key,role text,is_active boolean);
insert into public.users values (md5('admin')::uuid,'admin',true),
  (md5('dispatcher')::uuid,'dispatcher',true),(md5('rep')::uuid,'rep',true),
  (md5('agent')::uuid,'agent',true),(md5('inactive')::uuid,'admin',false);
create function public.is_admin_or_dispatcher() returns boolean language sql stable as $$
  select exists(select 1 from public.users where id=auth.uid() and role in ('admin','dispatcher','rep'))
$$;
create table public.bot_inbound_messages(id uuid primary key,status text,parse_result jsonb);
create table public.test_pushes(payload jsonb);
create function public.send_edge_notification(p jsonb) returns void language plpgsql as $$
begin
  if current_setting('test.fail_push',true)='yes' then raise exception 'Synthetic transport failure'; end if;
  insert into public.test_pushes values(p);
end $$;
grant usage on schema public,auth to authenticated;

-- Existing refusals must not turn into surprise notifications at deployment.
insert into public.bot_inbound_messages values(md5('historical')::uuid,'blocked','{}');
