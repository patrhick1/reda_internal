-- Replacement workflow -------------------------------------------------------
--
-- A replacement is operational work, not a completed Pickup/Waybill charge.
-- It travels through the normal deliveries envelope (assignment, customer,
-- address, date and status), while returned goods use a separate custody ledger.
-- Returned goods NEVER affect current_stock until warehouse inspection accepts
-- them as usable. All write RPCs are idempotent through p_client_uuid.

begin;

-- The delivery envelope can now distinguish normal orders, money-only waybills,
-- and replacement trips. Existing delivery field checks continue to apply to
-- `delivery`; create_replacement validates its own stricter contract.
alter table public.deliveries drop constraint if exists deliveries_order_type_check;
alter table public.deliveries add constraint deliveries_order_type_check
  check (order_type in ('delivery', 'waybill', 'replacement'));

-- A replacement completion is terminal but deliberately distinct from
-- `delivered`, so delivery-rate / delivered-order KPIs do not absorb it.
insert into public.delivery_status_defs(status, label, category, needs_followup, sort_order)
values ('replacement_completed', 'Replacement completed', 'terminal', false, 91)
on conflict (status) do update
set label = excluded.label,
    category = excluded.category,
    needs_followup = excluded.needs_followup,
    sort_order = excluded.sort_order;

-- Replacement-specific stock reasons preserve useful movement history. The
-- outbound line is negative at the rider. The accepted return is positive at
-- the warehouse only after inspection.
alter table public.stock_adjustments drop constraint if exists stock_adjustments_reason_check;
alter table public.stock_adjustments add constraint stock_adjustments_reason_check
  check (reason = any (array[
    'loss','theft','damaged','found','correction','transfer',
    'warehouse_return','warehouse_issue','bulk_intake',
    'delivered','delivery_returned',
    'replacement_outbound','replacement_return_accepted'
  ]));

create table if not exists public.replacement_jobs (
  delivery_id uuid primary key references public.deliveries(id) on delete cascade,
  original_delivery_id uuid references public.deliveries(id) on delete set null,
  reason text not null,
  notes text,
  success_client_charge numeric not null default 0 check (success_client_charge >= 0),
  success_agent_payment numeric not null default 0 check (success_agent_payment >= 0),
  created_by_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.replacement_return_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.replacement_jobs(delivery_id) on delete cascade,
  product_catalog_id uuid not null references public.product_catalog(id),
  quantity_expected integer not null check (quantity_expected > 0),
  vendor_instruction text not null default 'ask_if_damaged'
    check (vendor_instruction in (
      'ask_if_damaged', 'collect_and_hold', 'do_not_collect_damaged'
    )),
  actual_quantity integer check (actual_quantity is null or actual_quantity >= 0),
  reported_condition text
    check (reported_condition is null or reported_condition in ('usable', 'damaged', 'unknown')),
  outcome text
    check (outcome is null or outcome in (
      'usable_collected', 'damaged_collected', 'left_with_customer', 'discarded'
    )),
  custody_state text not null default 'expected'
    check (custody_state in (
      'expected',
      'with_rider_usable_pending_inspection',
      'with_rider_damaged_hold',
      'left_with_customer',
      'discarded',
      'warehouse_accepted_stock',
      'warehouse_hold_for_vendor',
      'warehouse_rejected_damaged',
      'returned_to_vendor'
    )),
  current_holder_id uuid references public.users(id),
  rider_notes text,
  collected_at timestamptz,
  warehouse_received_at timestamptz,
  inspected_by_user_id uuid references public.users(id),
  stock_adjustment_id uuid references public.stock_adjustments(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists replacement_returns_delivery
  on public.replacement_return_items(delivery_id);
create index if not exists replacement_returns_custody_queue
  on public.replacement_return_items(custody_state, collected_at)
  where custody_state in (
    'with_rider_usable_pending_inspection', 'with_rider_damaged_hold',
    'warehouse_hold_for_vendor'
  );

create table if not exists public.replacement_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.replacement_jobs(delivery_id) on delete cascade,
  client_uuid text not null unique,
  outcome text not null check (outcome in (
    'completed', 'customer_unreachable', 'customer_postponed',
    'details_incorrect', 'customer_rejected', 'cancelled', 'other'
  )),
  status_after text not null references public.delivery_status_defs(status),
  notes text,
  next_attempt_date date,
  client_charge numeric not null default 0 check (client_charge >= 0),
  agent_payment numeric not null default 0 check (agent_payment >= 0),
  assigned_agent_id uuid not null references public.users(id),
  attempted_by_user_id uuid not null references public.users(id),
  attempted_at timestamptz not null default now()
);

create index if not exists replacement_attempts_delivery
  on public.replacement_attempts(delivery_id, attempted_at desc);

-- Makes a re-run safe if an earlier draft of this migration created the table
-- before the immutable assigned-agent snapshot was added.
alter table public.replacement_attempts
  add column if not exists assigned_agent_id uuid references public.users(id);
update public.replacement_attempts a
   set assigned_agent_id = d.assigned_agent_id
  from public.deliveries d
 where d.id = a.delivery_id and a.assigned_agent_id is null;
alter table public.replacement_attempts
  alter column assigned_agent_id set not null;

create table if not exists public.replacement_return_events (
  id uuid primary key default gen_random_uuid(),
  client_uuid text not null unique,
  return_item_id uuid not null references public.replacement_return_items(id) on delete cascade,
  event_type text not null check (event_type in (
    'collected', 'not_collected', 'received_and_accepted',
    'received_for_vendor', 'rejected_as_damaged', 'discarded', 'returned_to_vendor'
  )),
  from_holder_id uuid references public.users(id),
  to_holder_id uuid references public.users(id),
  quantity integer not null check (quantity >= 0),
  condition text check (condition is null or condition in ('usable', 'damaged', 'unknown')),
  notes text,
  actor_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create index if not exists replacement_return_events_item
  on public.replacement_return_events(return_item_id, created_at);

alter table public.replacement_jobs enable row level security;
alter table public.replacement_return_items enable row level security;
alter table public.replacement_attempts enable row level security;
alter table public.replacement_return_events enable row level security;

-- Tables stay RPC-only. This keeps custody/stock invariants inside transactions
-- and prevents a direct client update from crediting uninspected stock.
revoke all on public.replacement_jobs from anon, authenticated;
revoke all on public.replacement_return_items from anon, authenticated;
revoke all on public.replacement_attempts from anon, authenticated;
revoke all on public.replacement_return_events from anon, authenticated;

create or replace function public.create_replacement(
  p_client_uuid text,
  p_client_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_phone_alt text,
  p_raw_address text,
  p_location_id uuid,
  p_scheduled_date date,
  p_assigned_agent_id uuid,
  p_outbound_items jsonb,
  p_return_items jsonb,
  p_reason text,
  p_notes text default null,
  p_success_client_charge numeric default 0,
  p_success_agent_payment numeric default 0
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_existing uuid;
  v_delivery_id uuid;
  v_first_product uuid;
  v_total integer;
  v_item jsonb;
  v_product uuid;
  v_qty integer;
  v_instruction text;
begin
  if not public.is_manager() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  select delivery_id into v_existing
    from public.delivery_status_history where client_uuid = p_client_uuid limit 1;
  if v_existing is not null then return v_existing; end if;

  if nullif(trim(p_customer_name), '') is null
     or nullif(trim(p_customer_phone), '') is null
     or nullif(trim(p_raw_address), '') is null then
    raise exception 'customer name, phone and address are required' using errcode = '23514';
  end if;
  if p_location_id is null then
    raise exception 'location required' using errcode = '23514';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'replacement reason required' using errcode = '23514';
  end if;
  if coalesce(p_success_client_charge, -1) < 0 or coalesce(p_success_agent_payment, -1) < 0 then
    raise exception 'charges must be >= 0' using errcode = '23514';
  end if;
  if jsonb_typeof(p_outbound_items) <> 'array' or jsonb_array_length(p_outbound_items) = 0 then
    raise exception 'at least one outbound item is required' using errcode = '23514';
  end if;
  if jsonb_typeof(p_return_items) <> 'array' or jsonb_array_length(p_return_items) = 0 then
    raise exception 'at least one expected return item is required' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_outbound_items) item
     group by item->>'product_catalog_id' having count(*) > 1
  ) then
    raise exception 'combine duplicate outbound products into one quantity'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_return_items) item
     group by item->>'product_catalog_id' having count(*) > 1
  ) then
    raise exception 'combine duplicate returned products into one quantity'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id and is_active) then
    raise exception 'client is inactive or not found' using errcode = '23514';
  end if;
  if not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'location not found' using errcode = '23514';
  end if;
  if p_assigned_agent_id is not null and not exists (
    select 1 from public.users where id = p_assigned_agent_id and role = 'agent' and is_active
  ) then
    raise exception 'assigned agent is inactive or invalid' using errcode = '23514';
  end if;

  v_total := 0;
  for v_item in select value from jsonb_array_elements(p_outbound_items)
  loop
    v_product := nullif(v_item->>'product_catalog_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::integer;
    if v_product is null or coalesce(v_qty, 0) <= 0 then
      raise exception 'every outbound item needs a product and positive quantity' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.product_catalog
       where id = v_product and client_id = p_client_id and is_active
    ) then
      raise exception 'outbound product does not belong to this client' using errcode = '23514';
    end if;
    v_first_product := coalesce(v_first_product, v_product);
    v_total := v_total + v_qty;
  end loop;

  insert into public.deliveries(
    client_id, product_catalog_id, location_id,
    customer_name, customer_phone, customer_phone_alt, raw_address,
    quantity_ordered, customer_price, charged_snapshot, agent_payment_snapshot,
    scheduled_date, assigned_agent_id, created_by_user_id,
    current_status, created_via, order_type, delivery_instructions
  ) values (
    p_client_id, v_first_product, p_location_id,
    trim(p_customer_name), trim(p_customer_phone), nullif(trim(p_customer_phone_alt), ''),
    trim(p_raw_address), v_total, 0, 0, 0,
    coalesce(p_scheduled_date, (now() at time zone 'Africa/Lagos')::date),
    p_assigned_agent_id, v_actor, 'pending', 'manual', 'replacement', nullif(trim(p_notes), '')
  ) returning id into v_delivery_id;

  for v_item in select value from jsonb_array_elements(p_outbound_items)
  loop
    insert into public.delivery_items(delivery_id, product_catalog_id, quantity_ordered, customer_price)
    values (
      v_delivery_id,
      (v_item->>'product_catalog_id')::uuid,
      (v_item->>'quantity')::integer,
      0
    );
  end loop;

  insert into public.replacement_jobs(
    delivery_id, original_delivery_id, reason, notes,
    success_client_charge, success_agent_payment, created_by_user_id
  ) values (
    v_delivery_id, null, trim(p_reason), nullif(trim(p_notes), ''),
    p_success_client_charge, p_success_agent_payment, v_actor
  );

  for v_item in select value from jsonb_array_elements(p_return_items)
  loop
    v_product := nullif(v_item->>'product_catalog_id', '')::uuid;
    v_qty := nullif(v_item->>'quantity', '')::integer;
    v_instruction := coalesce(nullif(v_item->>'vendor_instruction', ''), 'ask_if_damaged');
    if v_product is null or coalesce(v_qty, 0) <= 0 then
      raise exception 'every return item needs a product and positive quantity' using errcode = '23514';
    end if;
    if v_instruction not in ('ask_if_damaged', 'collect_and_hold', 'do_not_collect_damaged') then
      raise exception 'invalid vendor instruction' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.product_catalog
       where id = v_product and client_id = p_client_id and is_active
    ) then
      raise exception 'return product does not belong to this client' using errcode = '23514';
    end if;
    insert into public.replacement_return_items(
      delivery_id, product_catalog_id, quantity_expected, vendor_instruction
    ) values (v_delivery_id, v_product, v_qty, v_instruction);
  end loop;

  insert into public.delivery_status_history(
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at, reason
  ) values (v_delivery_id, null, 'pending', v_actor, p_client_uuid, now(), 'replacement_created');

  perform public.write_audit(
    'delivery', v_delivery_id, null,
    jsonb_build_object(
      'order_type', 'replacement',
      'client_id', p_client_id,
      'outbound_items', p_outbound_items,
      'return_items', p_return_items,
      'reason', trim(p_reason),
      'success_client_charge', p_success_client_charge,
      'success_agent_payment', p_success_agent_payment,
      'assigned_agent_id', p_assigned_agent_id
    ), null
  );
  return v_delivery_id;
end;
$function$;

create or replace function public.record_replacement_attempt(
  p_client_uuid text,
  p_delivery_id uuid,
  p_outcome text,
  p_notes text default null,
  p_next_attempt_date date default null,
  p_client_charge numeric default 0,
  p_agent_payment numeric default 0
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_delivery record;
  v_status text;
  v_date date;
begin
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if exists (select 1 from public.replacement_attempts where client_uuid = p_client_uuid) then
    return;
  end if;
  select d.* into v_delivery
    from public.deliveries d join public.replacement_jobs r on r.delivery_id = d.id
   where d.id = p_delivery_id for update of d;
  if not found then raise exception 'replacement not found' using errcode = 'P0002'; end if;
  if not (public.is_manager() or (
    public.current_user_role() = 'agent' and v_delivery.assigned_agent_id = v_actor
  )) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_delivery.current_status = 'replacement_completed' then
    raise exception 'replacement is already completed' using errcode = '22023';
  end if;
  if v_delivery.assigned_agent_id is null then
    raise exception 'assign an agent before recording a replacement attempt'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.delivery_status_defs
     where status = v_delivery.current_status and category = 'terminal'
  ) then
    raise exception 'replacement is closed; reopen it before recording another attempt'
      using errcode = '22023';
  end if;
  if p_outcome not in (
    'customer_unreachable', 'customer_postponed', 'details_incorrect',
    'customer_rejected', 'cancelled', 'other'
  ) then
    raise exception 'invalid unsuccessful attempt outcome' using errcode = '23514';
  end if;
  if coalesce(p_client_charge, -1) < 0 or coalesce(p_agent_payment, -1) < 0 then
    raise exception 'attempt charges must be >= 0' using errcode = '23514';
  end if;
  if p_outcome in ('customer_postponed', 'details_incorrect') then
    if p_next_attempt_date is null or p_next_attempt_date <= (now() at time zone 'Africa/Lagos')::date then
      raise exception 'a future retry date is required' using errcode = '23514';
    end if;
    v_status := 'postponed';
    v_date := public._ensure_workday(p_next_attempt_date);
  elsif p_outcome = 'customer_unreachable' then
    v_status := 'not_answering';
    v_date := v_delivery.scheduled_date;
  elsif p_outcome = 'customer_rejected' then
    v_status := 'failed_delivery';
    v_date := v_delivery.scheduled_date;
  elsif p_outcome = 'cancelled' then
    v_status := 'cancelled';
    v_date := v_delivery.scheduled_date;
  else
    v_status := 'follow_up';
    v_date := coalesce(p_next_attempt_date, v_delivery.scheduled_date);
  end if;

  insert into public.replacement_attempts(
    delivery_id, client_uuid, outcome, status_after, notes, next_attempt_date,
    client_charge, agent_payment, assigned_agent_id, attempted_by_user_id
  ) values (
    p_delivery_id, p_client_uuid, p_outcome, v_status, nullif(trim(p_notes), ''), v_date,
    p_client_charge, p_agent_payment, v_delivery.assigned_agent_id, v_actor
  );
  insert into public.delivery_status_history(
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid,
    effective_at, reason, notes
  ) values (
    p_delivery_id, v_delivery.current_status, v_status, v_actor, p_client_uuid,
    now(), 'replacement_' || p_outcome, nullif(trim(p_notes), '')
  );
  update public.deliveries
     set current_status = v_status,
         scheduled_date = v_date,
         charged_snapshot = coalesce(charged_snapshot, 0) + p_client_charge,
         agent_payment_snapshot = coalesce(agent_payment_snapshot, 0) + p_agent_payment
   where id = p_delivery_id;
end;
$function$;

create or replace function public.complete_replacement(
  p_client_uuid text,
  p_delivery_id uuid,
  p_return_outcomes jsonb,
  p_notes text default null
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_delivery record;
  v_job record;
  v_line record;
  v_return record;
  v_payload jsonb;
  v_outcome text;
  v_qty integer;
  v_state text;
  v_condition text;
  v_on_hand integer;
  v_total integer := 0;
begin
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if exists (select 1 from public.replacement_attempts where client_uuid = p_client_uuid) then
    return;
  end if;
  select d.* into v_delivery from public.deliveries d
   where d.id = p_delivery_id for update;
  select * into v_job from public.replacement_jobs where delivery_id = p_delivery_id;
  if v_delivery.id is null or v_job.delivery_id is null then
    raise exception 'replacement not found' using errcode = 'P0002';
  end if;
  if not (public.is_manager() or (
    public.current_user_role() = 'agent' and v_delivery.assigned_agent_id = v_actor
  )) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_delivery.assigned_agent_id is null then
    raise exception 'assign an agent before completing this replacement' using errcode = '23514';
  end if;
  if v_delivery.current_status = 'replacement_completed' then return; end if;
  if exists (
    select 1 from public.delivery_status_defs
     where status = v_delivery.current_status and category = 'terminal'
  ) then
    raise exception 'replacement is closed; reopen it before completing'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_return_outcomes) <> 'array' then
    raise exception 'return outcomes must be an array' using errcode = '23514';
  end if;
  if (select count(*) from public.replacement_return_items where delivery_id = p_delivery_id)
     <> jsonb_array_length(p_return_outcomes) then
    raise exception 'record an outcome for every expected returned item' using errcode = '23514';
  end if;

  -- Validate every outbound line before moving any stock.
  for v_line in select * from public.delivery_items where delivery_id = p_delivery_id
  loop
    select coalesce(quantity_on_hand, 0) into v_on_hand
      from public.current_stock
     where agent_id = v_delivery.assigned_agent_id
       and product_catalog_id = v_line.product_catalog_id;
    if coalesce(v_on_hand, 0) < v_line.quantity_ordered then
      raise exception 'insufficient_stock: rider has % units, replacement needs %',
        coalesce(v_on_hand, 0), v_line.quantity_ordered
        using errcode = 'P0001',
              hint = jsonb_build_object(
                'code','insufficient_stock', 'product_catalog_id', v_line.product_catalog_id,
                'on_hand',coalesce(v_on_hand,0), 'needed',v_line.quantity_ordered
              )::text;
    end if;
  end loop;

  for v_return in
    select * from public.replacement_return_items where delivery_id = p_delivery_id for update
  loop
    select value into v_payload from jsonb_array_elements(p_return_outcomes)
     where value->>'return_item_id' = v_return.id::text limit 1;
    if v_payload is null then
      raise exception 'missing return outcome for %', v_return.id using errcode = '23514';
    end if;
    v_outcome := v_payload->>'outcome';
    v_qty := coalesce(nullif(v_payload->>'quantity', '')::integer, 0);
    if v_outcome not in ('usable_collected','damaged_collected','left_with_customer','discarded') then
      raise exception 'invalid return outcome' using errcode = '23514';
    end if;
    if v_qty < 0 or v_qty > v_return.quantity_expected then
      raise exception 'return quantity must be between 0 and %', v_return.quantity_expected using errcode = '23514';
    end if;
    if v_outcome in ('usable_collected','damaged_collected') and v_qty = 0 then
      raise exception 'collected return quantity must be positive' using errcode = '23514';
    end if;
    if v_outcome = 'usable_collected' then
      v_state := 'with_rider_usable_pending_inspection'; v_condition := 'usable';
    elsif v_outcome = 'damaged_collected' then
      v_state := 'with_rider_damaged_hold'; v_condition := 'damaged';
    elsif v_outcome = 'left_with_customer' then
      v_state := 'left_with_customer'; v_condition := 'unknown';
    else
      v_state := 'discarded'; v_condition := 'damaged';
    end if;
    update public.replacement_return_items
       set actual_quantity = v_qty,
           reported_condition = v_condition,
           outcome = v_outcome,
           custody_state = v_state,
           current_holder_id = case
             when v_outcome in ('usable_collected','damaged_collected')
               then v_delivery.assigned_agent_id else null end,
           rider_notes = nullif(trim(v_payload->>'notes'), ''),
           collected_at = now(), updated_at = now()
     where id = v_return.id;
    insert into public.replacement_return_events(
      client_uuid, return_item_id, event_type, from_holder_id, to_holder_id, quantity,
      condition, notes, actor_user_id
    ) values (
      p_client_uuid || ':return:' || v_return.id::text, v_return.id,
      case when v_outcome in ('usable_collected','damaged_collected') then 'collected'
           when v_outcome = 'discarded' then 'discarded' else 'not_collected' end,
      null,
      case when v_outcome in ('usable_collected','damaged_collected')
           then v_delivery.assigned_agent_id else null end,
      v_qty, v_condition, nullif(trim(v_payload->>'notes'), ''), v_actor
    );
  end loop;

  for v_line in select * from public.delivery_items where delivery_id = p_delivery_id
  loop
    insert into public.stock_adjustments(
      agent_id, product_catalog_id, quantity_delta, reason, notes,
      client_uuid, created_by_user_id, delivery_id
    ) values (
      v_delivery.assigned_agent_id, v_line.product_catalog_id,
      -v_line.quantity_ordered, 'replacement_outbound',
      'Replacement sent to ' || v_delivery.customer_name,
      p_client_uuid || ':out:' || v_line.product_catalog_id::text,
      v_actor, p_delivery_id
    );
    update public.delivery_items set quantity_delivered = quantity_ordered
     where id = v_line.id;
    v_total := v_total + v_line.quantity_ordered;
  end loop;

  insert into public.replacement_attempts(
    delivery_id, client_uuid, outcome, status_after, notes,
    client_charge, agent_payment, assigned_agent_id, attempted_by_user_id
  ) values (
    p_delivery_id, p_client_uuid, 'completed', 'replacement_completed',
    nullif(trim(p_notes), ''), v_job.success_client_charge,
    v_job.success_agent_payment, v_delivery.assigned_agent_id, v_actor
  );
  insert into public.delivery_status_history(
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid,
    effective_at, reason, notes
  ) values (
    p_delivery_id, v_delivery.current_status, 'replacement_completed', v_actor,
    p_client_uuid, now(), 'replacement_completed', nullif(trim(p_notes), '')
  );
  update public.deliveries
     set current_status = 'replacement_completed',
         quantity_delivered = v_total,
         paid = 0,
         payment_method = null,
         charged_snapshot = coalesce(charged_snapshot, 0) + v_job.success_client_charge,
         agent_payment_snapshot = coalesce(agent_payment_snapshot, 0) + v_job.success_agent_payment
   where id = p_delivery_id;
end;
$function$;

create or replace function public.update_replacement_attempt_fees(
  p_attempt_id uuid,
  p_client_charge numeric,
  p_agent_payment numeric,
  p_reason text
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_attempt record;
  v_day date;
  v_client_delta numeric;
  v_agent_delta numeric;
begin
  if not public.is_admin() then
    raise exception 'only admin can correct replacement fees' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason required for fee correction' using errcode = '23514';
  end if;
  if coalesce(p_client_charge, -1) < 0 or coalesce(p_agent_payment, -1) < 0 then
    raise exception 'replacement fees must be >= 0' using errcode = '23514';
  end if;

  select a.*, d.client_id into v_attempt
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
   where a.id = p_attempt_id for update of a;
  if not found then
    raise exception 'replacement attempt not found' using errcode = 'P0002';
  end if;
  v_day := (v_attempt.attempted_at at time zone 'Africa/Lagos')::date;

  if exists (
    select 1 from public.settlements s
     where s.subject_type = 'client' and s.subject_id = v_attempt.client_id
       and s.period_date = v_day and s.voided_at is null
  ) then
    raise exception 'client reconciliation for this attempt date is already settled'
      using errcode = '22023',
            hint = 'void the client settlement, correct the fee, then settle again';
  end if;
  if exists (
    select 1 from public.settlements s
     where s.subject_type = 'agent' and s.subject_id = v_attempt.assigned_agent_id
       and s.period_date = v_day and s.voided_at is null
  ) then
    raise exception 'rider reconciliation for this attempt date is already settled'
      using errcode = '22023',
            hint = 'void the rider settlement, correct the fee, then settle again';
  end if;

  v_client_delta := p_client_charge - v_attempt.client_charge;
  v_agent_delta := p_agent_payment - v_attempt.agent_payment;
  update public.replacement_attempts
     set client_charge = p_client_charge, agent_payment = p_agent_payment
   where id = p_attempt_id;
  update public.deliveries
     set charged_snapshot = coalesce(charged_snapshot, 0) + v_client_delta,
         agent_payment_snapshot = coalesce(agent_payment_snapshot, 0) + v_agent_delta,
         updated_at = now()
   where id = v_attempt.delivery_id;

  perform public.write_audit(
    'replacement_attempt', p_attempt_id,
    jsonb_build_object(
      'client_charge',v_attempt.client_charge, 'agent_payment',v_attempt.agent_payment
    ),
    jsonb_build_object(
      'client_charge',p_client_charge, 'agent_payment',p_agent_payment
    ), trim(p_reason)
  );
end;
$function$;

create or replace function public.receive_replacement_return(
  p_client_uuid text,
  p_return_item_id uuid,
  p_disposition text,
  p_warehouse_id uuid default null,
  p_notes text default null
) returns void
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text := public.current_user_role();
  v_actor_warehouse uuid;
  v_target uuid;
  v_return record;
  v_adjustment_id uuid;
  v_new_state text;
  v_event text;
begin
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if exists (select 1 from public.stock_adjustments where client_uuid = p_client_uuid || ':accepted')
     or exists (
       select 1 from public.replacement_return_events
        where client_uuid = p_client_uuid
     ) then return; end if;
  if not (public.is_manager() or v_role = 'warehouse') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select warehouse_id into v_actor_warehouse from public.users where id = v_actor;
  v_target := case when v_role = 'warehouse' then coalesce(v_actor_warehouse, v_actor)
                   else p_warehouse_id end;
  if v_target is null or not exists (
    select 1 from public.users
     where id = v_target and role = 'warehouse' and warehouse_id is null and is_active
  ) then
    raise exception 'select an active warehouse' using errcode = '23514';
  end if;
  select * into v_return from public.replacement_return_items
   where id = p_return_item_id for update;
  if not found then raise exception 'return item not found' using errcode = 'P0002'; end if;
  if v_return.custody_state not in (
    'with_rider_usable_pending_inspection','with_rider_damaged_hold','warehouse_hold_for_vendor'
  ) then
    raise exception 'return item is not awaiting warehouse action' using errcode = '22023';
  end if;
  if p_disposition not in ('accept_to_stock','hold_for_vendor','reject_damaged','returned_to_vendor') then
    raise exception 'invalid disposition' using errcode = '23514';
  end if;
  if p_disposition = 'accept_to_stock' and v_return.reported_condition <> 'usable' then
    raise exception 'damaged goods cannot be added to usable stock' using errcode = '23514';
  end if;

  if p_disposition = 'accept_to_stock' then
    insert into public.stock_adjustments(
      agent_id, product_catalog_id, quantity_delta, reason, notes,
      client_uuid, created_by_user_id, delivery_id
    ) values (
      v_target, v_return.product_catalog_id, v_return.actual_quantity,
      'replacement_return_accepted', coalesce(nullif(trim(p_notes), ''), 'Replacement return inspected and accepted'),
      p_client_uuid || ':accepted', v_actor, v_return.delivery_id
    ) returning id into v_adjustment_id;
    v_new_state := 'warehouse_accepted_stock'; v_event := 'received_and_accepted';
  elsif p_disposition = 'hold_for_vendor' then
    v_new_state := 'warehouse_hold_for_vendor'; v_event := 'received_for_vendor';
  elsif p_disposition = 'returned_to_vendor' then
    v_new_state := 'returned_to_vendor'; v_event := 'returned_to_vendor';
  else
    v_new_state := 'warehouse_rejected_damaged'; v_event := 'rejected_as_damaged';
  end if;

  update public.replacement_return_items
     set custody_state = v_new_state,
         current_holder_id = case when v_new_state = 'warehouse_hold_for_vendor' then v_target else null end,
         warehouse_received_at = coalesce(warehouse_received_at, now()),
         inspected_by_user_id = v_actor,
         stock_adjustment_id = v_adjustment_id,
         updated_at = now()
   where id = p_return_item_id;
  insert into public.replacement_return_events(
    client_uuid, return_item_id, event_type, from_holder_id, to_holder_id, quantity,
    condition, notes, actor_user_id
  ) values (
    p_client_uuid, p_return_item_id, v_event, v_return.current_holder_id,
    case when v_new_state in ('warehouse_accepted_stock','warehouse_hold_for_vendor') then v_target else null end,
    coalesce(v_return.actual_quantity, 0), v_return.reported_condition,
    coalesce(nullif(trim(p_notes), ''), p_disposition), v_actor
  );
end;
$function$;

create or replace function public.get_replacement_details(p_delivery_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
declare
  v_delivery record;
  v_result jsonb;
begin
  select * into v_delivery from public.deliveries where id = p_delivery_id and deleted_at is null;
  if not found or v_delivery.order_type <> 'replacement' then return null; end if;
  if not (
    public.is_admin_or_dispatcher()
    or public.current_user_role() = 'warehouse'
    or (public.current_user_role() = 'agent' and v_delivery.assigned_agent_id = auth.uid())
  ) then raise exception 'permission denied' using errcode = '42501'; end if;

  select jsonb_build_object(
    'job', jsonb_build_object(
      'delivery_id', r.delivery_id,
      'original_delivery_id', r.original_delivery_id,
      'reason', r.reason,
      'notes', r.notes,
      'success_client_charge', case when public.is_admin() then r.success_client_charge else null end,
      'success_agent_payment', case
        when public.is_manager() or v_delivery.assigned_agent_id = auth.uid()
          then r.success_agent_payment else null end
    ),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ri.id,
        'product_catalog_id', ri.product_catalog_id,
        'product_name', pc.product_name,
        'quantity_expected', ri.quantity_expected,
        'vendor_instruction', ri.vendor_instruction,
        'actual_quantity', ri.actual_quantity,
        'reported_condition', ri.reported_condition,
        'outcome', ri.outcome,
        'custody_state', ri.custody_state,
        'current_holder_id', ri.current_holder_id,
        'current_holder_name', h.display_name,
        'rider_notes', ri.rider_notes,
        'collected_at', ri.collected_at,
        'warehouse_received_at', ri.warehouse_received_at
      ) order by ri.created_at)
      from public.replacement_return_items ri
      join public.product_catalog pc on pc.id = ri.product_catalog_id
      left join public.users h on h.id = ri.current_holder_id
      where ri.delivery_id = p_delivery_id
    ), '[]'::jsonb),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'outcome', a.outcome,
        'status_after', a.status_after,
        'notes', a.notes,
        'next_attempt_date', a.next_attempt_date,
        'client_charge', case when public.is_admin() then a.client_charge else null end,
        'agent_payment', case
          when public.is_manager() or a.assigned_agent_id = auth.uid()
            then a.agent_payment else null end,
        'attempted_at', a.attempted_at,
        'attempted_by_name', u.display_name
      ) order by a.attempted_at desc)
      from public.replacement_attempts a
      join public.users u on u.id = a.attempted_by_user_id
      where a.delivery_id = p_delivery_id
    ), '[]'::jsonb)
  ) into v_result
  from public.replacement_jobs r where r.delivery_id = p_delivery_id;
  return v_result;
end;
$function$;

create or replace function public.list_replacement_returns()
returns table(
  return_item_id uuid, delivery_id uuid, customer_name text, raw_address text,
  client_name text, product_name text, quantity integer, reported_condition text,
  custody_state text, vendor_instruction text, rider_name text, collected_at timestamptz
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not (public.is_manager() or public.current_user_role() = 'warehouse') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select ri.id, ri.delivery_id, d.customer_name, d.raw_address,
         c.name, pc.product_name, coalesce(ri.actual_quantity, ri.quantity_expected),
         ri.reported_condition, ri.custody_state, ri.vendor_instruction,
         u.display_name, ri.collected_at
    from public.replacement_return_items ri
    join public.deliveries d on d.id = ri.delivery_id
    join public.clients c on c.id = d.client_id
    join public.product_catalog pc on pc.id = ri.product_catalog_id
    left join public.users u on u.id = ri.current_holder_id
   where ri.custody_state in (
     'with_rider_usable_pending_inspection','with_rider_damaged_hold','warehouse_hold_for_vendor'
   )
   order by ri.collected_at nulls last, ri.created_at;
end;
$function$;

-- Finance/reporting surface. Replacement fees are attempt-based and separated
-- from delivery success metrics. Reconciliation can consume this without ever
-- pretending the replacement is a customer product sale.
create or replace function public.list_replacement_financials(
  p_from date, p_to date, p_client_id uuid default null
) returns table(
  attempt_id uuid, delivery_id uuid, attempted_at timestamptz, client_id uuid, client_name text,
  customer_name text, outcome text, client_charge numeric, agent_payment numeric,
  margin numeric, agent_id uuid, agent_name text, notes text
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not public.is_manager() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, d.client_id, c.name, d.customer_name,
         a.outcome, a.client_charge, a.agent_payment,
         a.client_charge - a.agent_payment, a.assigned_agent_id, u.display_name, a.notes
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$;

-- Rider-safe earnings surface. Managers receive all riders; an agent receives
-- only their own attempt pay and never sees the client charge or Reda margin.
create or replace function public.list_replacement_agent_financials(
  p_from date, p_to date
) returns table(
  attempt_id uuid, delivery_id uuid, attempted_at timestamptz,
  agent_id uuid, agent_name text, agent_payment numeric
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_role text := public.current_user_role();
begin
  if not (public.is_manager() or v_role = 'agent') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, a.assigned_agent_id,
         u.display_name, a.agent_payment
    from public.replacement_attempts a
    join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (public.is_manager() or a.assigned_agent_id = v_actor)
   order by a.attempted_at desc;
end;
$function$;

-- Rep-safe counterpart: exposes only the client-facing deduction, never Reda's
-- fee column or rider payout as separate internal figures.
create or replace function public.list_replacement_financials_rep(
  p_from date, p_to date, p_client_id uuid default null
) returns table(
  attempt_id uuid, delivery_id uuid, attempted_at timestamptz,
  client_id uuid, client_name text, customer_name text, outcome text,
  remit numeric, agent_name text, notes text
)
language plpgsql stable security definer set search_path = 'public', 'auth'
as $function$
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, d.client_id, c.name,
         d.customer_name, a.outcome, -a.client_charge,
         u.display_name, a.notes
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$;

-- Keep frozen settlement snapshots aligned with the live reconciliation views.
-- Each replacement attempt is its own money event on the Lagos day it happened:
-- no customer cash was collected, so the client remit is -client_charge and the
-- rider remit is -agent_payment. The attempt's assigned-agent snapshot prevents
-- a later reassignment of the job from moving historical earnings.
create or replace function public.settle_period(
  p_subject_type text,
  p_subject_id uuid,
  p_period_date date,
  p_note text default null::text
) returns uuid
language plpgsql security definer set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_expected numeric := 0;
  v_count integer := 0;
  v_by_entry jsonb;
  v_id uuid;
  v_existing uuid;
begin
  if not public.is_admin() then
    raise exception 'only admin can settle a period' using errcode = '42501';
  end if;
  if p_subject_type not in ('client','agent') then
    raise exception 'subject_type must be ''client'' or ''agent''' using errcode = '23514';
  end if;
  if p_period_date is null then
    raise exception 'period_date required' using errcode = '23514';
  end if;

  select id into v_existing from public.settlements
   where subject_type = p_subject_type and subject_id = p_subject_id
     and period_date = p_period_date and voided_at is null;
  if v_existing is not null then
    raise exception 'this % is already settled for %', p_subject_type, p_period_date
      using errcode = '23505',
            hint = 'void the existing settlement first if you need to re-settle';
  end if;

  if p_subject_type = 'client' then
    with entries as (
      select d.id::text as entry_id,
             d.paid - coalesce(d.charged_snapshot,0) - coalesce(d.cash_pos_fee_snapshot,0) as amount,
             jsonb_build_object(
               'entry_type','delivery', 'delivery_id',d.id, 'paid',d.paid,
               'charged',d.charged_snapshot, 'cash_pos_fee',d.cash_pos_fee_snapshot,
               'remit',d.paid - coalesce(d.charged_snapshot,0) - coalesce(d.cash_pos_fee_snapshot,0)
             ) as snapshot
        from public.deliveries d
       where d.client_id = p_subject_id and d.current_status = 'delivered'
         and d.scheduled_date = p_period_date and d.deleted_at is null
      union all
      select a.id::text, -a.client_charge,
             jsonb_build_object(
               'entry_type','replacement_attempt', 'attempt_id',a.id,
               'delivery_id',a.delivery_id, 'outcome',a.outcome,
               'client_charge',a.client_charge, 'remit',-a.client_charge
             )
        from public.replacement_attempts a
        join public.deliveries d on d.id = a.delivery_id
       where d.client_id = p_subject_id
         and (a.attempted_at at time zone 'Africa/Lagos')::date = p_period_date
    )
    select coalesce(sum(amount),0), count(*)::integer,
           coalesce(jsonb_agg(snapshot order by entry_id),'[]'::jsonb)
      into v_expected, v_count, v_by_entry from entries;
  else
    with entries as (
      select d.id::text as entry_id,
             d.paid - coalesce(d.agent_payment_snapshot,0) as amount,
             jsonb_build_object(
               'entry_type','delivery', 'delivery_id',d.id, 'paid',d.paid,
               'agent_payment',d.agent_payment_snapshot,
               'to_remit',d.paid - coalesce(d.agent_payment_snapshot,0)
             ) as snapshot
        from public.deliveries d
       where d.assigned_agent_id = p_subject_id and d.current_status = 'delivered'
         and d.scheduled_date = p_period_date and d.deleted_at is null
      union all
      select a.id::text, -a.agent_payment,
             jsonb_build_object(
               'entry_type','replacement_attempt', 'attempt_id',a.id,
               'delivery_id',a.delivery_id, 'outcome',a.outcome,
               'agent_payment',a.agent_payment, 'to_remit',-a.agent_payment
             )
        from public.replacement_attempts a
        join public.deliveries d on d.id = a.delivery_id
       where a.assigned_agent_id = p_subject_id
         and (a.attempted_at at time zone 'Africa/Lagos')::date = p_period_date
    )
    select coalesce(sum(amount),0), count(*)::integer,
           coalesce(jsonb_agg(snapshot order by entry_id),'[]'::jsonb)
      into v_expected, v_count, v_by_entry from entries;
  end if;

  if v_count = 0 then
    raise exception 'nothing to settle for this % on %', p_subject_type, p_period_date
      using errcode = '22023';
  end if;

  insert into public.settlements(
    subject_type, subject_id, period_date, settled_by, expected_amount,
    deliveries_count, snapshot, note
  ) values (
    p_subject_type, p_subject_id, p_period_date, v_actor, v_expected, v_count,
    jsonb_build_object(
      'expected_amount',v_expected, 'entries_count',v_count, 'by_delivery',v_by_entry
    ), nullif(btrim(p_note),'')
  ) returning id into v_id;

  perform public.write_audit(
    'settlement', v_id, null,
    jsonb_build_object(
      'subject_type',p_subject_type, 'subject_id',p_subject_id,
      'period_date',p_period_date, 'expected_amount',v_expected,
      'entries_count',v_count, 'note',nullif(btrim(p_note),'')
    ), 'settle'
  );
  return v_id;
end;
$function$;

-- Defense-in-depth around the shared deliveries envelope. Replacement writes
-- must go through the replacement RPCs, which atomically maintain attempts,
-- stock and return custody. The generic status/delete RPCs know none of that.
create or replace function public.guard_replacement_delivery_mutation()
returns trigger
language plpgsql set search_path = 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    if old.order_type = 'replacement' and old.current_status = 'replacement_completed' then
      raise exception 'completed replacements cannot be deleted; reverse stock and custody explicitly'
        using errcode = '22023';
    end if;
    return old;
  end if;

  if old.order_type = 'replacement'
     and old.current_status = 'replacement_completed'
     and new.deleted_at is distinct from old.deleted_at then
    raise exception 'completed replacements cannot be deleted; reverse stock and custody explicitly'
      using errcode = '22023';
  end if;

  if new.order_type = 'replacement'
     and new.current_status in ('delivered','picked_up','waybilled','rolled_over') then
    raise exception 'use the replacement attempt/completion workflow for replacement jobs'
      using errcode = '22023';
  end if;
  if new.order_type <> 'replacement' and new.current_status = 'replacement_completed' then
    raise exception 'replacement_completed is only valid for replacement jobs'
      using errcode = '22023';
  end if;
  if old.order_type = 'replacement'
     and old.current_status = 'replacement_completed'
     and new.current_status is distinct from old.current_status then
    raise exception 'a completed replacement requires an explicit reversal workflow'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_replacement_delivery_update on public.deliveries;
create trigger trg_guard_replacement_delivery_update
before update of current_status, deleted_at on public.deliveries
for each row execute function public.guard_replacement_delivery_mutation();

drop trigger if exists trg_guard_replacement_delivery_delete on public.deliveries;
create trigger trg_guard_replacement_delivery_delete
before delete on public.deliveries
for each row execute function public.guard_replacement_delivery_mutation();

grant execute on function public.create_replacement(
  text, uuid, text, text, text, text, uuid, date, uuid, jsonb, jsonb, text, text, numeric, numeric
) to authenticated;
grant execute on function public.record_replacement_attempt(
  text, uuid, text, text, date, numeric, numeric
) to authenticated;
grant execute on function public.complete_replacement(text, uuid, jsonb, text) to authenticated;
grant execute on function public.update_replacement_attempt_fees(uuid, numeric, numeric, text)
  to authenticated;
grant execute on function public.receive_replacement_return(text, uuid, text, uuid, text) to authenticated;
grant execute on function public.get_replacement_details(uuid) to authenticated;
grant execute on function public.list_replacement_returns() to authenticated;
grant execute on function public.list_replacement_financials(date, date, uuid) to authenticated;
grant execute on function public.list_replacement_agent_financials(date, date) to authenticated;
grant execute on function public.list_replacement_financials_rep(date, date, uuid) to authenticated;

commit;
