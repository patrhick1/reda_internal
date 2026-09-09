-- Replacement customer-payment functions as live on the box, captured 2026-09-09 AFTER
-- supabase/migrations/20260910010000_replacement_customer_payment.sql was applied by its author
-- (no pre-change capture was taken). The migration file is the diff.

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
begin
  if nullif(trim(p_client_uuid), '') is null then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  perform 1 from public.deliveries where id=p_delivery_id for update;
  if exists (select 1 from public.replacement_attempts where client_uuid = p_client_uuid) then
    return;
  end if;
  if p_customer_paid is null or p_customer_paid < 0 or p_customer_paid >= 'Infinity'::numeric
     or (p_customer_paid>0 and (p_payment_method is null or p_payment_method not in ('cash','transfer','pos') or p_payment_received_by is null or p_payment_received_by not in ('rider','reda'))) then
    raise exception 'Enter a valid customer payment, method and recipient' using errcode='23514';
  end if;
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
    customer_paid, payment_method, payment_received_by, client_charge, agent_payment, assigned_agent_id, attempted_by_user_id
  ) values (
    p_delivery_id, p_client_uuid, 'completed', 'replacement_completed',
    nullif(trim(p_notes), ''), p_customer_paid, case when p_customer_paid>0 then p_payment_method end, case when p_customer_paid>0 then p_payment_received_by end, v_job.success_client_charge,
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
$function$
;

CREATE OR REPLACE FUNCTION public.correct_replacement_payment(p_attempt_id uuid, p_client_charge numeric, p_agent_payment numeric, p_reason text, p_customer_paid numeric, p_payment_method text, p_payment_received_by text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare old_payment jsonb;
begin
 if not public.is_admin() then raise exception 'Admin only' using errcode='42501'; end if;
 select jsonb_build_object('customer_paid',customer_paid,'payment_method',payment_method,'payment_received_by',payment_received_by)
 into old_payment from replacement_attempts where id=p_attempt_id for update;
 if p_customer_paid is null then raise exception 'Customer payment required' using errcode='23514'; end if;
 perform public.update_replacement_attempt_fees(p_attempt_id,p_client_charge,p_agent_payment,p_reason);
 update replacement_attempts set customer_paid=p_customer_paid,
 payment_method=case when p_customer_paid>0 then p_payment_method end,
 payment_received_by=case when p_customer_paid>0 then p_payment_received_by end where id=p_attempt_id;
 perform public.write_audit('replacement_attempt',p_attempt_id,old_payment,
 jsonb_build_object('customer_paid',p_customer_paid,'payment_method',p_payment_method,'payment_received_by',p_payment_received_by),p_reason);
end; $function$
;

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
      select a.id::text, (a.customer_paid-a.client_charge),
             jsonb_build_object(
               'entry_type','replacement_attempt', 'attempt_id',a.id,
               'delivery_id',a.delivery_id, 'outcome',a.outcome,
               'customer_paid',a.customer_paid,'payment_method',a.payment_method,'payment_received_by',a.payment_received_by,'client_charge',a.client_charge, 'remit',(a.customer_paid-a.client_charge)
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
$function$
;

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
        'customer_paid', a.customer_paid, 'payment_method', a.payment_method, 'payment_received_by', a.payment_received_by,
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
$function$
;

CREATE OR REPLACE FUNCTION public.list_replacement_financials_v2(p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(attempt_id uuid, delivery_id uuid, attempted_at timestamp with time zone, client_id uuid, client_name text, customer_name text, outcome text, client_charge numeric, agent_payment numeric, margin numeric, agent_id uuid, agent_name text, notes text, customer_paid numeric, payment_method text, payment_received_by text)
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
         a.client_charge - a.agent_payment, a.assigned_agent_id, u.display_name, a.notes, a.customer_paid, a.payment_method, a.payment_received_by
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_replacement_agent_financials_v2(p_from date, p_to date)
 RETURNS TABLE(attempt_id uuid, delivery_id uuid, attempted_at timestamp with time zone, agent_id uuid, agent_name text, agent_payment numeric, customer_paid numeric, payment_method text, payment_received_by text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_role text := public.current_user_role();
begin
  if not (public.is_manager() or v_role = 'agent') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  return query
  select a.id, a.delivery_id, a.attempted_at, a.assigned_agent_id,
         u.display_name, a.agent_payment, a.customer_paid, a.payment_method, a.payment_received_by
    from public.replacement_attempts a
    join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (public.is_manager() or a.assigned_agent_id = v_actor)
   order by a.attempted_at desc;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_replacement_financials_rep_v2(p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(attempt_id uuid, delivery_id uuid, attempted_at timestamp with time zone, client_id uuid, client_name text, customer_name text, outcome text, remit numeric, agent_name text, notes text, customer_paid numeric, payment_method text, payment_received_by text)
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
         d.customer_name, a.outcome, (a.customer_paid-a.client_charge),
         u.display_name, a.notes, a.customer_paid, a.payment_method, a.payment_received_by
    from public.replacement_attempts a
    join public.deliveries d on d.id = a.delivery_id
    join public.clients c on c.id = d.client_id
    left join public.users u on u.id = a.assigned_agent_id
   where (a.attempted_at at time zone 'Africa/Lagos')::date between p_from and p_to
     and (p_client_id is null or d.client_id = p_client_id)
   order by a.attempted_at desc;
end;
$function$
;

-- view client_financial_activity
create or replace view public.client_financial_activity as  SELECT d.client_id,
    d.scheduled_date AS activity_date,
    'delivery'::text AS entry_type,
    d.id AS entry_id,
    COALESCE(d.paid, 0::numeric) - COALESCE(d.charged_snapshot, 0::numeric) - COALESCE(d.cash_pos_fee_snapshot, 0::numeric) AS amount
   FROM deliveries d
  WHERE d.current_status = 'delivered'::text AND d.deleted_at IS NULL AND COALESCE(d.order_type, 'delivery'::text) <> 'replacement'::text
UNION ALL
 SELECT d.client_id,
    (a.attempted_at AT TIME ZONE 'Africa/Lagos'::text)::date AS activity_date,
    'replacement_attempt'::text AS entry_type,
    a.id AS entry_id,
    a.customer_paid - a.client_charge AS amount
   FROM replacement_attempts a
     JOIN deliveries d ON d.id = a.delivery_id
  WHERE d.deleted_at IS NULL;
