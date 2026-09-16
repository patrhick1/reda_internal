\set ON_ERROR_STOP on
begin;
do $$ begin
  if current_database()<>'reda_same_customer_test' or inet_server_port()<>55439 or inet_server_addr()<>'127.0.0.1'::inet then
    raise exception 'These tests require the isolated localhost test database on port 55439';
  end if;
end $$;
set local statement_timeout='20s';
create or replace function public.send_edge_notification(p_body jsonb)
returns void language plpgsql as $$ begin return; end $$;
create function pg_temp.check_ok(p_condition boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_condition is distinct from true then raise exception 'FAIL: %',p_message; end if;
end $$;

select pg_temp.check_ok(public._same_customer_phone_v1('0801 234 5678')='+2348012345678','local normalization');
select pg_temp.check_ok(public._same_customer_phone_v1('+234 (801) 234-5678')='+2348012345678','international normalization');
select pg_temp.check_ok(public._same_customer_phone_v1('002348012345678')='+2348012345678','international dialing prefix');
select pg_temp.check_ok(public._same_customer_phone_v1('') is null and public._same_customer_phone_v1('call 08012345678') is null
  and public._same_customer_phone_v1('0801') is null,'invalid contacts never form keys');

insert into auth.users(id,email) select md5('same-customer-user-'||role)::uuid,role||'@same-customer.example.invalid'
from unnest(array['admin','dispatcher','rep','agent','warehouse']) role;
insert into public.users(id,email,display_name,role)
select id,email,split_part(email,'@',1),split_part(email,'@',1) from auth.users;
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
insert into public.feature_flags(key,enabled) values('enable_auto_assign',false) on conflict(key) do update set enabled=false;
insert into public.delivery_status_defs(status,category,label) values
 ('pending','initial','Pending'),('delivered','terminal','Delivered'),('cancelled','terminal','Cancelled'),('rolled_over','terminal','Rolled over');
insert into public.clients(id,name) values(md5('same-customer-vendor-a')::uuid,'Vendor A'),(md5('same-customer-vendor-b')::uuid,'Vendor B');
insert into public.locations(id,name) values(md5('same-customer-location')::uuid,'Test zone');
insert into public.product_catalog(id,client_id,product_name)
select md5('same-customer-product-'||n)::uuid,
  md5('same-customer-vendor-'||case when n=1 then 'a' else 'b' end)::uuid,'Test product '||n from generate_series(1,4) n;
insert into public.deliveries(id,client_id,product_catalog_id,customer_name,customer_phone,customer_phone_alt,raw_address,
 quantity_ordered,customer_price,agent_payment_snapshot,charged_snapshot,assigned_agent_id,scheduled_date,items_fingerprint)
select md5('same-customer-order-'||n)::uuid,
 md5('same-customer-vendor-'||case when n=1 then 'a' else 'b' end)::uuid,
 md5('same-customer-product-'||case when n=3 then 2 else n end)::uuid,
 'Recipient '||n,case when n=1 then '08012345678' when n in(2,3) then '+2348012345678' else '09012345678' end,
 case when n=4 then '08012345678' end,
 case when n=1 then '12 Test Road' else 'No. 12 Test Rd' end,
 1,10000,3000,4000,md5('same-customer-user-agent')::uuid,date '2030-01-02',
 (md5('same-customer-product-'||case when n=3 then 2 else n end)::uuid)::text||':1'
from generate_series(1,4) n;
