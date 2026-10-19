begin;
set local statement_timeout='20s';
create function pg_temp.ok(v boolean,message text) returns void language plpgsql as $$begin
  if v is distinct from true then raise exception 'FAIL: %',message; end if;
end $$;
-- Outbound notification transport is the only substituted business function.
create or replace function public.send_edge_notification(p_body jsonb) returns void language plpgsql as $$begin return; end $$;
insert into auth.users(id,email) values(md5('perfume-admin')::uuid,'admin@perfume.example.invalid');
insert into public.users(id,email,display_name,role) values(md5('perfume-admin')::uuid,'admin@perfume.example.invalid','Test admin','admin');
select set_config('request.jwt.claim.sub',md5('perfume-admin')::uuid::text,true);
insert into public.feature_flags(key,enabled) values('enable_auto_assign',false) on conflict(key) do update set enabled=false;
insert into public.clients(id,name) values('2740824b-4f65-4901-abd5-6635aec0f044','Zael NG'),(md5('perfume-other-vendor')::uuid,'Other test vendor');
insert into public.product_catalog(id,client_id,product_name,is_active,aliases) values
 ('67f486ef-d7c5-4934-8f54-4916abda42df','2740824b-4f65-4901-abd5-6635aec0f044','Arabiyat Oud Al Layl EDP',true,array['Oud Al Layl Brown Single With Oil','Oud Al Layl Brown Double With Oil','Oud Al Layl Brown Triple With Oil']),
 ('d36c6537-3d12-40ac-b14d-aaf46c805932','2740824b-4f65-4901-abd5-6635aec0f044','Maison Alhambra Pacific Blue EDP',true,array['Existing Pacific alias']),
 ('5bd093a5-fbf8-4c8c-b6ac-7b5fff32fcb5','2740824b-4f65-4901-abd5-6635aec0f044','Oud Al Layl Aswad',true,null),
 ('55584a39-bcdd-43b9-8610-27a44bd090ea','2740824b-4f65-4901-abd5-6635aec0f044','Perfume Oil',false,null);
create temporary table catalog_before as select * from public.product_catalog;
