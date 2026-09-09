-- Replacement payments use the same vocabulary and cash rule as a delivery.
--
-- Uzo (2026-09-09): a replacement is paid the way a delivery is paid — cash or
-- transfer — and "cash" already means cash or the rider's POS. On a delivery,
-- cash with an amount records Reda's ₦500 POS fee, deducted from the client's
-- remit (change_delivery_status → cash_pos_fee_snapshot; settle_period →
-- paid − charged − cash_pos_fee). The replacement work shipped earlier today
-- used cash / transfer / "pos", had no "to vendor", and charged no POS fee, so
-- a cash replacement would have remitted the client ₦500 more than an
-- identical cash delivery.
--
-- Now: payment_method ∈ {cash, transfer, vendor_direct}, exactly as on
-- deliveries. Cash carries cash_pos_fee = 500 on the attempt and every
-- client-side figure subtracts it (settlement snapshot, client activity view,
-- the report functions, the reconciliation screens). "vendor_direct" means the
-- customer paid the vendor: amount 0, nobody received money, the client owes
-- the replacement fee. The rider side is unchanged — the POS fee is the
-- client's cost, as on a delivery. "received by" (rider / REDA directly) stays:
-- it decides whose settlement the money sits in.
--
-- No replacement payment had been recorded under the old vocabulary (0 of 3
-- attempts), so there is nothing to migrate. Pre-change definitions:
-- tools/live-defs/replacement_payment.sql.
begin;

alter table public.replacement_attempts
  add column if not exists cash_pos_fee numeric not null default 0 check (cash_pos_fee >= 0);
alter table public.replacement_attempts drop constraint if exists replacement_payment_valid;
alter table public.replacement_attempts add constraint replacement_payment_valid check (
     (customer_paid = 0 and payment_method is null and payment_received_by is null and cash_pos_fee = 0)
  or (customer_paid = 0 and payment_method = 'vendor_direct' and payment_received_by is null and cash_pos_fee = 0)
  or (customer_paid > 0 and payment_method = 'transfer' and payment_received_by in ('rider','reda') and cash_pos_fee = 0)
  or (customer_paid > 0 and payment_method = 'cash' and payment_received_by in ('rider','reda') and cash_pos_fee = 500)
);

-- One rule, used by both the completion and the admin correction. Returns the
-- POS fee the row must carry. Raises 23514 (check_violation) on anything else,
-- the code the app and the smoke tests already expect.
create or replace function public._validate_replacement_payment(
  p_customer_paid numeric, p_payment_method text, p_payment_received_by text
) returns numeric
language plpgsql immutable
as $fn$
begin
  if p_customer_paid is null or p_customer_paid < 0 or p_customer_paid >= 'Infinity'::numeric then
    raise exception 'Enter a valid customer payment' using errcode = '23514';
  end if;
  if p_customer_paid > 0 then
    if p_payment_method is null or p_payment_method not in ('cash', 'transfer') then
      raise exception 'Payment method must be cash or transfer when the customer paid' using errcode = '23514';
    end if;
    if p_payment_received_by is null or p_payment_received_by not in ('rider', 'reda') then
      raise exception 'Say who received the money: the rider or REDA directly' using errcode = '23514';
    end if;
    return case when p_payment_method = 'cash' then 500 else 0 end;
  end if;
  if p_payment_method is not null and p_payment_method <> 'vendor_direct' then
    raise exception 'With no payment to REDA the method can only be "to vendor"' using errcode = '23514';
  end if;
  if p_payment_received_by is not null then
    raise exception 'Nobody received money on a zero payment' using errcode = '23514';
  end if;
  return 0;
end;
$fn$;

-- complete_replacement: identical to tools/live-defs/replacement_payment.sql
-- except the payment validation (now the shared rule) and cash_pos_fee on the
-- attempt row.
CREATE OR REPLACE FUNCTION public.complete_replacement(p_client_uuid text, p_delivery_id uuid, p_return_outcomes jsonb, p_notes text DEFAULT NULL::text, p_customer_paid numeric DEFAULT 0, p_payment_method text DEFAULT NULL::text, p_payment_received_by text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
  v_fee numeric;
begin
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  perform 1 from public.deliveries where id=p_delivery_id for update;
  if exists (select 1 from public.replacement_attempts where client_uuid = p_client_uuid) then
    return;
  end if;
  v_fee := public._validate_replacement_payment(p_customer_paid, p_payment_method, p_payment_received_by);
  if public.current_user_role()='agent' and p_customer_paid>0 and p_payment_received_by<>'rider' then
    raise exception 'Riders may only record money they received' using errcode='42501';
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
  if exists (select 1 from public.settlements where voided_at is null
    and period_date=(now() at time zone 'Africa/Lagos')::date
    and ((subject_type='client' and subject_id=v_delivery.client_id) or
         (subject_type='agent' and subject_id=v_delivery.assigned_agent_id))) then
    raise exception 'This date is already settled; void the settlement before completing the replacement' using errcode='22023';
  end if;

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
    customer_paid, payment_method, payment_received_by, cash_pos_fee,
    client_charge, agent_payment, assigned_agent_id, attempted_by_user_id
  ) values (
    p_delivery_id, p_client_uuid, 'completed', 'replacement_completed',
    nullif(trim(p_notes), ''), p_customer_paid,
    case when p_customer_paid > 0 then p_payment_method
         when p_payment_method = 'vendor_direct' then 'vendor_direct' end,
    case when p_customer_paid > 0 then p_payment_received_by end,
    v_fee,
    v_job.success_client_charge,
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
         paid = 0, -- Replacement payments live on the attempt, not the product-sale ledger.
         payment_method = null,
         charged_snapshot = coalesce(charged_snapshot, 0) + v_job.success_client_charge,
         agent_payment_snapshot = coalesce(agent_payment_snapshot, 0) + v_job.success_agent_payment
   where id = p_delivery_id;
end;
$function$;

-- Admin correction: same rule, same fee, audited with the fee.
create or replace function public.correct_replacement_payment(p_attempt_id uuid,p_client_charge numeric,p_agent_payment numeric,p_reason text,p_customer_paid numeric,p_payment_method text,p_payment_received_by text) returns void
language plpgsql security definer set search_path=public,auth as $$
declare
  old_payment jsonb;
  v_fee numeric;
begin
  if not public.is_admin() then raise exception 'Admin only' using errcode='42501'; end if;
  select jsonb_build_object('customer_paid',customer_paid,'payment_method',payment_method,
                            'payment_received_by',payment_received_by,'cash_pos_fee',cash_pos_fee)
    into old_payment from replacement_attempts where id=p_attempt_id for update;
  if old_payment is null then raise exception 'attempt not found' using errcode='P0002'; end if;
  v_fee := public._validate_replacement_payment(p_customer_paid, p_payment_method, p_payment_received_by);
  perform public.update_replacement_attempt_fees(p_attempt_id,p_client_charge,p_agent_payment,p_reason);
  update replacement_attempts
     set customer_paid=p_customer_paid,
         payment_method=case when p_customer_paid>0 then p_payment_method
                             when p_payment_method='vendor_direct' then 'vendor_direct' end,
         payment_received_by=case when p_customer_paid>0 then p_payment_received_by end,
         cash_pos_fee=v_fee
   where id=p_attempt_id;
  perform public.write_audit('replacement_attempt',p_attempt_id,old_payment,
    jsonb_build_object('customer_paid',p_customer_paid,'payment_method',
      case when p_customer_paid>0 then p_payment_method when p_payment_method='vendor_direct' then 'vendor_direct' end,
      'payment_received_by',case when p_customer_paid>0 then p_payment_received_by end,
      'cash_pos_fee',v_fee),
    p_reason);
end; $$;

-- Reports: the client-side figures subtract the fee; the row carries it.
drop function if exists public.list_replacement_financials_v2(date, date, uuid);
CREATE FUNCTION public.list_replacement_financials_v2(p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(attempt_id uuid, delivery_id uuid, attempted_at timestamp with time zone, client_id uuid, client_name text, customer_name text, outcome text, client_charge numeric, agent_payment numeric, margin numeric, agent_id uuid, agent_name text, notes text, customer_paid numeric, payment_method text, payment_received_by text, cash_pos_fee numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not public.is_manager() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, d.client_id, c.name, d.customer_name,
         a.outcome, a.client_charge, a.agent_payment,
         a.client_charge - a.agent_payment, a.assigned_agent_id, u.display_name, a.notes,
         a.customer_paid, a.payment_method, a.payment_received_by, a.cash_pos_fee
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$;

drop function if exists public.list_replacement_financials_rep_v2(date, date, uuid);
CREATE FUNCTION public.list_replacement_financials_rep_v2(p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(attempt_id uuid, delivery_id uuid, attempted_at timestamp with time zone, client_id uuid, client_name text, customer_name text, outcome text, remit numeric, agent_name text, notes text, customer_paid numeric, payment_method text, payment_received_by text, cash_pos_fee numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, d.client_id, c.name,
         d.customer_name, a.outcome, (a.customer_paid - a.client_charge - a.cash_pos_fee),
         u.display_name, a.notes, a.customer_paid, a.payment_method, a.payment_received_by, a.cash_pos_fee
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$;

-- Detail payload: the fee rides along with the payment.
CREATE OR REPLACE FUNCTION public.get_replacement_details(p_delivery_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
        'customer_paid', a.customer_paid, 'payment_method', a.payment_method,
        'payment_received_by', a.payment_received_by, 'cash_pos_fee', a.cash_pos_fee,
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

-- Settlement: the client entry subtracts the fee, as a cash delivery's does.
-- The agent entry is unchanged — the POS fee is the client's cost.
CREATE OR REPLACE FUNCTION public.settle_period(p_subject_type text, p_subject_id uuid, p_period_date date, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
      select a.id::text, (a.customer_paid - a.client_charge - a.cash_pos_fee),
             jsonb_build_object(
               'entry_type','replacement_attempt', 'attempt_id',a.id,
               'delivery_id',a.delivery_id, 'outcome',a.outcome,
               'customer_paid',a.customer_paid,'payment_method',a.payment_method,'payment_received_by',a.payment_received_by,
               'client_charge',a.client_charge, 'cash_pos_fee',a.cash_pos_fee,
               'remit',(a.customer_paid - a.client_charge - a.cash_pos_fee)
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
      select a.id::text, ((case when a.payment_received_by='rider' then a.customer_paid else 0 end)-a.agent_payment),
             jsonb_build_object(
               'entry_type','replacement_attempt', 'attempt_id',a.id,
               'delivery_id',a.delivery_id, 'outcome',a.outcome,
               'customer_paid',a.customer_paid,'payment_method',a.payment_method,'payment_received_by',a.payment_received_by,'agent_payment',a.agent_payment, 'to_remit',((case when a.payment_received_by='rider' then a.customer_paid else 0 end)-a.agent_payment)
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

create or replace view public.client_financial_activity as
select d.client_id,d.scheduled_date as activity_date,'delivery'::text as entry_type,d.id as entry_id,
coalesce(d.paid,0)-coalesce(d.charged_snapshot,0)-coalesce(d.cash_pos_fee_snapshot,0) as amount
from public.deliveries d where d.current_status='delivered' and d.deleted_at is null and coalesce(d.order_type,'delivery')<>'replacement'
union all
select d.client_id,(a.attempted_at at time zone 'Africa/Lagos')::date,'replacement_attempt',a.id,a.customer_paid-a.client_charge-a.cash_pos_fee
from public.replacement_attempts a join public.deliveries d on d.id=a.delivery_id where d.deleted_at is null;

revoke all on function public._validate_replacement_payment(numeric, text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_replacement_financials_v2(date, date, uuid) from public, anon;
grant execute on function public.list_replacement_financials_v2(date, date, uuid) to authenticated, service_role;
revoke all on function public.list_replacement_financials_rep_v2(date, date, uuid) from public, anon;
grant execute on function public.list_replacement_financials_rep_v2(date, date, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
