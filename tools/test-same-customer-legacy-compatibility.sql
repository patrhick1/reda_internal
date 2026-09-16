\ir same-customer-pay-test-fixtures.sql
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date;
select public.change_delivery_status(p_client_uuid:='compat-complete-'||n,p_delivery_id:=md5('same-customer-order-'||n)::uuid,
 p_to_status:='delivered',p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=now())
from generate_series(1,2) n;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST compatibility diagnostic');
set local role authenticated;
select set_config('request.jwt.claim.sub',md5('same-customer-user-agent')::uuid::text,true);
-- Inspect the raw view projection as the local owner; retain the synthetic rider JWT.
-- The schema-only clone does not grant authenticated SELECT on this legacy view.
reset role;
select 'pending-pay compatibility' as diagnostic,
 (select pending_pay_count from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')) as pending_count,
 (select total_earnings from public.agent_earnings_summary_v2('2000-01-01','2100-01-01')) as canonical_total,
 (select sum(agent_payment_snapshot) from public.deliveries_safe where current_status='delivered') as legacy_view_total;
reset role;
rollback;
