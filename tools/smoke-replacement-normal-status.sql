-- Smoke test for the replacement-status change (migrations 20260909160000 + 20260909170000).
-- Creates one throwaway replacement off a real delivery, walks it through available →
-- tomorrow → postponed → available, asserts, and rolls everything back.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  d public.deliveries%rowtype;
  actor uuid;
  attempts integer;
  seed public.deliveries%rowtype;
  test_id uuid;
begin
  select id into actor from public.users where role = 'admin' and is_active limit 1;
  perform set_config('request.jwt.claim.sub', actor::text, true);
  select x.* into seed from public.deliveries x
    join public.users u on u.id=x.assigned_agent_id and u.is_active
    where x.order_type='delivery' and x.deleted_at is null and x.location_id is not null
      and exists(select 1 from public.product_catalog p where p.id=x.product_catalog_id and p.is_active)
    order by x.created_at desc limit 1;
  test_id := public.create_replacement(gen_random_uuid()::text, seed.client_id,
    'Rollback replacement test', seed.customer_phone, null, seed.raw_address,
    seed.location_id, (now() at time zone 'Africa/Lagos')::date, seed.assigned_agent_id,
    jsonb_build_array(jsonb_build_object('product_catalog_id',seed.product_catalog_id,'quantity',1)),
    jsonb_build_array(jsonb_build_object('product_catalog_id',seed.product_catalog_id,'quantity',1,'vendor_instruction','ask_if_damaged')),
    'other', 'Rollback test', 0, 0, p_original_delivery_id => seed.id);
  if not exists(select 1 from public.replacement_jobs where delivery_id=test_id and original_delivery_id=seed.id) then
    raise exception 'Original delivery link not saved'; end if;
  select * into d from public.deliveries where id=test_id;
  select count(*) into attempts from public.replacement_attempts where delivery_id=d.id;
  perform public.change_delivery_status(gen_random_uuid()::text, d.id, 'available');
  if not exists(select 1 from public.available_orders_safe where delivery_id=d.id) then
    raise exception 'Available replacement absent from packing view'; end if;
  perform public.change_delivery_status(gen_random_uuid()::text, d.id, 'tomorrow');
  if not exists(select 1 from public.deliveries where id=d.id
    and scheduled_date=public._ensure_workday((now() at time zone 'Africa/Lagos')::date+1)
    and assigned_agent_id=d.assigned_agent_id
    and charged_snapshot is not distinct from d.charged_snapshot
    and agent_payment_snapshot is not distinct from d.agent_payment_snapshot) then
    raise exception 'Tomorrow failed to preserve replacement assignment/fees or date'; end if;
  if (select count(*) from public.replacement_attempts where delivery_id=d.id) <> attempts then
    raise exception 'Routine status recorded a paid trip'; end if;
  if exists(select 1 from public._eod_classify((now() at time zone 'Africa/Lagos')::date) where delivery_id=d.id) then
    raise exception 'Replacement entered EOD'; end if;
  perform public.change_delivery_status(gen_random_uuid()::text, d.id, 'postponed',
    p_new_scheduled_date => (now() at time zone 'Africa/Lagos')::date + 3);
  if not exists(select 1 from public.deliveries where id=d.id
    and scheduled_date=public._ensure_workday((now() at time zone 'Africa/Lagos')::date+3)
    and assigned_agent_id=d.assigned_agent_id) then
    raise exception 'Postponed replacement lost its date or agent'; end if;
  perform public.change_delivery_status(gen_random_uuid()::text, d.id, 'available');
  if not exists(select 1 from public.available_orders_safe where delivery_id=d.id
    and scheduled_date=(now() at time zone 'Africa/Lagos')::date) then
    raise exception 'Reactivated replacement did not return to today planning'; end if;
  raise notice 'PASS: Available packing view, same-row tomorrow, assignment/fees preserved, no attempt, no rollover';
end;
$test$;

rollback;
