\ir same-customer-pay-test-fixtures.sql
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.method','GET',true);
select set_config('request.path','/deliveries_safe',true);
select set_config('request.headers','{}',true);
-- No activation: discovery clients keep working during deployment.
select public.check_payment_client_contract();
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date+1;
select public.check_payment_client_contract();
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date;
set local role authenticated;
do $$ begin
  perform public.check_payment_client_contract();
  raise exception 'FAIL old client reached financial reads';
exception when sqlstate 'PT426' then null; end $$;
select set_config('request.headers','{"x-reda-payment-contract":"0"}',true);
do $$ begin
  perform public.check_payment_client_contract();
  raise exception 'FAIL obsolete client accepted';
exception when sqlstate 'PT426' then null; end $$;
select set_config('request.headers','{"x-reda-payment-contract":"1"}',true);
select public.check_payment_client_contract();
select set_config('request.headers','{}',true);
select set_config('request.path','/users',true);
select public.check_payment_client_contract();
select set_config('request.method','PATCH',true);
do $$ begin
  perform public.check_payment_client_contract();
  raise exception 'FAIL profile write bypassed contract';
exception when sqlstate 'PT426' then null; end $$;
reset role;
-- Suspending future enrollment must not reopen old reads of existing earnings.
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date-2,
 inactive_from=(now() at time zone 'Africa/Lagos')::date-1;
select set_config('request.path','/deliveries_admin',true);
select set_config('request.method','GET',true);
do $$ begin
  perform public.check_payment_client_contract();
  raise exception 'FAIL suspension reopened legacy reads';
exception when sqlstate 'PT426' then null; end $$;
select set_config('request.jwt.claim.role','service_role',true);
select public.check_payment_client_contract();
select set_config('request.jwt.claim.role','anon',true);
set local role anon;
select public.check_payment_client_contract();
reset role;
update public.same_customer_pay_policy set active_from=null,inactive_from=null;
select public.configure_same_customer_pay('schedule',(now() at time zone 'Africa/Lagos')::date+1,'TEST release','TEST scheduled activation');
select pg_temp.check_ok((select count(*)=1 and bool_and(action='schedule') from public.same_customer_policy_audit),'activation audit');
do $$ begin
  perform public.configure_same_customer_pay('schedule',(now() at time zone 'Africa/Lagos')::date+2,'TEST release','TEST duplicate schedule');
  raise exception 'FAIL rescheduled existing policy';
exception when invalid_parameter_value then null; end $$;
select public.configure_same_customer_pay('suspend',(now() at time zone 'Africa/Lagos')::date+2,'TEST release','TEST future suspension');
select pg_temp.check_ok((select count(*)=2 from public.same_customer_policy_audit),'suspension audit');
set local role authenticated;
do $$ begin
  perform public.configure_same_customer_pay('suspend',(now() at time zone 'Africa/Lagos')::date+3,'TEST release','TEST unauthorized');
  raise exception 'FAIL app activated pay';
exception when insufficient_privilege then null; end $$;
reset role;
rollback;
select 'PASS: disabled/future policy, old/current clients, profile-only exception, suspension, trusted services and anonymous requests';
