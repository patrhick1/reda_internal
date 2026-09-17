\ir same-customer-test-fixtures.sql
update public.feature_flags set enabled=true where key='same_customer_discovery';
set local role authenticated;
do $$ declare r text; g text; begin
 foreach r in array array['admin','dispatcher'] loop
  perform set_config('request.jwt.claim.sub',md5('same-customer-user-'||r)::uuid::text,true);
  perform pg_temp.check_ok((public.get_same_customer_config()->>'discovery_enabled')::boolean,r||' discovery enabled');
  g:=public.list_same_customer_orders(date '2030-01-02')->'groups'->0->>'group_id';
  perform pg_temp.check_ok(g is not null,r||' can list groups');
  perform public.get_same_customer_orders(date '2030-01-02',g);
  perform public.same_customer_badges(array[md5('same-customer-order-1')::uuid]);
 end loop;
 foreach r in array array['rep','agent','warehouse'] loop
  perform set_config('request.jwt.claim.sub',md5('same-customer-user-'||r)::uuid::text,true);
  perform pg_temp.check_ok(not (public.get_same_customer_config()->>'discovery_enabled')::boolean,r||' discovery hidden');
  begin
   perform public.list_same_customer_orders(date '2030-01-02');
   raise exception 'FAIL % read group list',r;
  exception when insufficient_privilege then null; end;
  begin
   perform public.get_same_customer_orders(date '2030-01-02',g);
   raise exception 'FAIL % read group detail',r;
  exception when insufficient_privilege then null; end;
  begin
   perform public.same_customer_badges(array[md5('same-customer-order-1')::uuid]);
   raise exception 'FAIL % read group badges',r;
  exception when insufficient_privilege then null; end;
 end loop;
end $$;
reset role;
rollback;
select 'PASS: Admin/Dispatcher access retained; rep/agent/warehouse config hidden and all discovery reads rejected';
