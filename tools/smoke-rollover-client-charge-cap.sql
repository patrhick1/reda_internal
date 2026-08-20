-- Transactional regression smoke test: rollover must honor clients.max_charge_per_delivery.
-- Safe on production: all fixtures and mutations are wrapped in a transaction
-- and rolled back. Any mismatch raises and stops psql when ON_ERROR_STOP is on.
\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_admin_id       uuid;
  v_location_id    uuid;
  v_capped_client  uuid;
  v_open_client    uuid;
  v_capped_product uuid;
  v_open_product   uuid;
  v_parent         uuid;
  v_child          uuid;
  v_second_child   uuid;
  v_parent_charge  numeric;
  v_child_charge   numeric;
  v_child_pay      numeric;
  v_child_agent    uuid;
  v_parent_status  text;
begin
  select u.id
    into v_admin_id
    from public.users u
   where u.role = 'admin'
     and u.is_active = true
   order by u.created_at
   limit 1;

  if v_admin_id is null then
    raise exception 'smoke test requires one active admin user';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text,
    true
  );

  v_location_id := public.create_location(
    'Rollover cap smoke ' || gen_random_uuid()::text,
    '{}',
    null,
    null
  );
  perform public.upsert_rate_card(
    v_location_id,
    10000,
    8000,
    'rollover client-cap regression fixture'
  );

  v_capped_client := public.create_client(
    'Rollover capped smoke ' || gen_random_uuid()::text,
    null,
    null,
    null
  );
  update public.clients
     set max_charge_per_delivery = 9000
   where id = v_capped_client;
  v_capped_product := public.create_product(
    v_capped_client,
    'Capped smoke product',
    null
  );

  v_parent := public.create_delivery(
    'rollover-cap-parent-' || gen_random_uuid()::text,
    v_capped_client,
    v_capped_product,
    'Capped rollover smoke',
    '+2348000000001',
    'Smoke address',
    1,
    20000,
    v_location_id,
    current_date,
    null,
    'manual'
  );

  select d.charged_snapshot
    into v_parent_charge
    from public.deliveries d
   where d.id = v_parent;

  if v_parent_charge is distinct from 9000 then
    raise exception 'setup failed: capped parent charge expected 9000, got %', v_parent_charge;
  end if;

  v_child := public.rollover_delivery(
    'rollover-cap-child-' || gen_random_uuid()::text,
    v_parent,
    null,
    'rollover client-cap regression fixture',
    false
  );

  select d.charged_snapshot,
         d.agent_payment_snapshot,
         d.assigned_agent_id
    into v_child_charge, v_child_pay, v_child_agent
    from public.deliveries d
   where d.id = v_child;

  select d.current_status
    into v_parent_status
    from public.deliveries d
   where d.id = v_parent;

  if v_child_charge is distinct from 9000 then
    raise exception 'capped rollover expected charge 9000, got %', v_child_charge;
  end if;
  if v_child_pay is distinct from 8000 then
    raise exception 'client cap must not reduce rider pay: expected 8000, got %', v_child_pay;
  end if;
  if v_child_agent is not null then
    raise exception 'rollover child must remain unassigned, got agent %', v_child_agent;
  end if;
  if v_parent_status is distinct from 'rolled_over' then
    raise exception 'rollover parent expected rolled_over, got %', v_parent_status;
  end if;

  v_second_child := public.rollover_delivery(
    'rollover-cap-idempotent-' || gen_random_uuid()::text,
    v_parent,
    null,
    'rollover client-cap idempotency fixture',
    false
  );
  if v_second_child is distinct from v_child then
    raise exception 'rollover idempotency failed: expected %, got %', v_child, v_second_child;
  end if;

  v_open_client := public.create_client(
    'Rollover uncapped smoke ' || gen_random_uuid()::text,
    null,
    null,
    null
  );
  v_open_product := public.create_product(
    v_open_client,
    'Uncapped smoke product',
    null
  );
  v_parent := public.create_delivery(
    'rollover-uncapped-parent-' || gen_random_uuid()::text,
    v_open_client,
    v_open_product,
    'Uncapped rollover smoke',
    '+2348000000002',
    'Smoke address',
    1,
    20000,
    v_location_id,
    current_date,
    null,
    'manual'
  );
  v_child := public.rollover_delivery(
    'rollover-uncapped-child-' || gen_random_uuid()::text,
    v_parent,
    null,
    'rollover uncapped regression fixture',
    false
  );

  select d.charged_snapshot, d.agent_payment_snapshot
    into v_child_charge, v_child_pay
    from public.deliveries d
   where d.id = v_child;

  if v_child_charge is distinct from 10000 then
    raise exception 'uncapped rollover expected charge 10000, got %', v_child_charge;
  end if;
  if v_child_pay is distinct from 8000 then
    raise exception 'uncapped rollover expected rider pay 8000, got %', v_child_pay;
  end if;

  raise notice 'PASS: capped, uncapped, rider-pay, assignment, parent-state and idempotency checks';
end;
$test$;

rollback;
