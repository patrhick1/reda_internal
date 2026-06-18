CREATE OR REPLACE FUNCTION public.change_delivery_status(p_client_uuid text, p_delivery_id uuid, p_to_status text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_quantity_delivered integer DEFAULT NULL::integer, p_paid numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT NULL::text, p_effective_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_new_scheduled_date date DEFAULT NULL::date, p_item_quantities jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_delivery       record;
  v_transition     record;
  v_actor          uuid := auth.uid();
  v_is_admin       boolean := public.is_admin();
  v_is_dispatcher  boolean := public.is_admin_or_dispatcher();
  v_role           text := public.current_user_role();
  v_effective      timestamptz := coalesce(p_effective_at, now());
  v_existing       uuid;
  v_on_hand        int;
  v_new_date       date;
  v_final_date     date;    -- resolved scheduled_date after this transition
  v_eff_items      jsonb;   -- [Feature A] effective per-item delivered map
  v_guard          record;  -- [Feature A]
  v_sum_delivered  int;     -- [Feature A]
  v_item_count     int;     -- [fan-out fix] line count for the null-items fallback
  v_fulfilled_sib  record;  -- single-fulfillment guard: an already-done sibling
begin
  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;

  select id into v_existing from public.delivery_status_history where client_uuid = p_client_uuid limit 1;
  if v_existing is not null then return; end if;

  select * into v_delivery from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'delivery not found' using errcode = 'P0002'; end if;
  if v_delivery.deleted_at is not null then raise exception 'delivery has been deleted' using errcode = '22023'; end if;
  if v_delivery.current_status = p_to_status then return; end if;

  select * into v_transition from public.delivery_status_transitions
   where from_status = v_delivery.current_status and to_status = p_to_status;
  if not found then
    raise exception 'invalid transition: % -> %', v_delivery.current_status, p_to_status using errcode = '22023';
  end if;

  if v_transition.requires_admin then
    if not v_is_admin then raise exception 'this transition requires admin' using errcode = '42501'; end if;
  else
    if not (v_is_dispatcher or (v_role = 'agent' and v_delivery.assigned_agent_id = v_actor)) then
      raise exception 'permission denied' using errcode = '42501';
    end if;
  end if;

  if v_transition.requires_reason and nullif(trim(p_reason), '') is null then
    raise exception 'reason required for this transition' using errcode = '23514';
  end if;

  -- Single-fulfillment guard. An order may be fulfilled by exactly ONE sibling.
  -- _find_sibling_deliveries matches the same customer + items + address across
  -- agents and the rollover chain. If any sibling is already in a fulfilled
  -- terminal state, refuse to fulfil this row too.
  --
  -- tg_handle_sibling_coordination already cancels OPEN siblings when one row
  -- goes terminal, but that cascade only looks FORWARD: a duplicate created
  -- AFTER the original already reached a terminal state is invisible to it
  -- (excluded by its category <> 'terminal' filter), so a second agent -- or a
  -- re-created bot order -- could otherwise mark the same order delivered and
  -- double-count the Reda fee, the agent payout and the remit. This
  -- backward-looking check closes that hole.
  if p_to_status in ('delivered','picked_up','waybilled') then
    select s.current_status, s.updated_at,
           coalesce(u.display_name, 'another agent') as agent_name,
           coalesce(sd.label, s.current_status) as status_label
      into v_fulfilled_sib
      from public._find_sibling_deliveries(p_delivery_id) s
      join public.delivery_status_defs sd on sd.status = s.current_status
      left join public.users u on u.id = s.assigned_agent_id
     where s.current_status in ('delivered','picked_up','waybilled')
     order by s.updated_at desc
     limit 1;
    if found then
      raise exception 'This order was already % by % (on %). It cannot be marked % again -- it is a duplicate of an order another agent has already handled.',
        v_fulfilled_sib.status_label, v_fulfilled_sib.agent_name,
        to_char(v_fulfilled_sib.updated_at at time zone 'Africa/Lagos', 'DD Mon HH24:MI'),
        p_to_status
        using errcode = 'P0001',
              hint = jsonb_build_object('code','already_fulfilled_sibling','delivery_id', p_delivery_id)::text;
    end if;
  end if;

  if p_to_status = 'postponed' and p_new_scheduled_date is not null then
    if p_new_scheduled_date <= current_date then
      raise exception 'postpone date must be in the future (got %, today is %)', p_new_scheduled_date, current_date
        using errcode = '23514';
    end if;
    v_new_date := public._ensure_workday(p_new_scheduled_date);
  end if;

  -- Resolve the row's scheduled_date after this transition:
  --   * explicit postpone        -> the (workday-adjusted) new date
  --   * LEAVING 'postponed' into a NON-TERMINAL status -> snap back to today
  --     (Lagos), so the re-worked order returns to Today / Unassigned instead of
  --     staying stranded on its future date (this is the Issue 2 fix)
  --   * otherwise (incl. terminal closes) -> unchanged
  -- The terminal exclusion matters: postponed -> rolled_over (via rollover_delivery
  -- during the stuck sweep), postponed -> cancelled (ops closing a future order),
  -- etc. are CLOSES, not re-work. They leave the working lists regardless of date,
  -- so snapping gives no benefit and would rewrite the row's true scheduled day —
  -- distorting EOD/earnings reporting. Only snap when the order is coming BACK as
  -- live work.
  v_final_date := case
    when v_new_date is not null then v_new_date
    when v_delivery.current_status = 'postponed'
         and p_to_status <> 'postponed'
         and not exists (
           select 1 from public.delivery_status_defs sd
            where sd.status = p_to_status and sd.category = 'terminal')
      then (now() at time zone 'Africa/Lagos')::date
    else v_delivery.scheduled_date
  end;

  if p_to_status = 'delivered' then
    if p_quantity_delivered is null or p_quantity_delivered <= 0 then
      raise exception 'quantity_delivered required (> 0) for delivered status' using errcode = '23514';
    end if;
    if p_paid is null or p_paid < 0 then
      raise exception 'paid required (>= 0) for delivered status' using errcode = '23514';
    end if;
    -- 'vendor_direct' = customer paid the vendor directly; app sends paid = 0.
    -- Agent + Reda fees are snapshotted at create time, so they still apply and
    -- the settlement formulas net to the right negatives. No remit change here.
    if p_payment_method not in ('cash','transfer','vendor_direct') then
      raise exception 'payment_method must be ''cash'', ''transfer'' or ''vendor_direct''' using errcode = '23514';
    end if;
    -- Money-integrity invariant: vendor_direct means Reda's side collected
    -- nothing. Enforce paid = 0 server-side so a direct/automated caller (or a
    -- future bug) can't send paid > 0 and silently produce a positive remit
    -- (which would read as "Reda owes the vendor" when the opposite is true).
    if p_payment_method = 'vendor_direct' and coalesce(p_paid, 0) <> 0 then
      raise exception 'vendor_direct requires paid = 0 (the customer paid the vendor directly)' using errcode = '23514';
    end if;
    if v_delivery.location_id is null then
      raise exception 'this delivery has no location set. Ask admin to edit the delivery and set the location before marking delivered.'
        using errcode = 'P0001',
              hint = jsonb_build_object('code','location_required','delivery_id', p_delivery_id)::text;
    end if;
    if v_delivery.assigned_agent_id is null then
      raise exception 'cannot mark delivered: no agent is assigned to this delivery. Assign an agent first.'
        using errcode = 'P0001',
              hint = jsonb_build_object('code','no_agent_assigned','delivery_id', p_delivery_id)::text;
    end if;

    -- [Feature A] Build the effective per-item delivered map. When the caller
    -- supplies p_item_quantities, use it; otherwise derive a sensible default.
    if p_item_quantities is not null then
      if jsonb_typeof(p_item_quantities) <> 'array' or jsonb_array_length(p_item_quantities) = 0 then
        raise exception 'p_item_quantities must be a non-empty array' using errcode = '23514';
      end if;
      v_eff_items := p_item_quantities;
    else
      -- [fan-out fix] No per-line breakdown supplied (stale client, bulk-deliver,
      -- or legacy row). Fanning a single p_quantity_delivered onto EVERY line is
      -- wrong for a multi-line order: it over-demands stock on small lines (e.g. a
      -- 1-unit free gift) and records wrong delivered counts. So:
      --   * 0 lines (pre-Feature-A row) -> legacy single product;
      --   * exactly 1 line  -> fan p_quantity_delivered onto it (preserves legacy
      --     partial-delivery support);
      --   * >1 lines        -> deliver each line at its quantity_ordered
      --     ("delivered as ordered"); the single p_quantity_delivered is ambiguous
      --     across distinct products, so it is ignored.
      select count(*) into v_item_count
        from public.delivery_items where delivery_id = p_delivery_id;
      if v_item_count = 0 then
        v_eff_items := jsonb_build_array(jsonb_build_object(
          'product_catalog_id', v_delivery.product_catalog_id,
          'quantity_delivered', p_quantity_delivered));
      elsif v_item_count = 1 then
        select jsonb_agg(jsonb_build_object(
                 'product_catalog_id', di.product_catalog_id,
                 'quantity_delivered', p_quantity_delivered))
          into v_eff_items
          from public.delivery_items di
         where di.delivery_id = p_delivery_id;
      else
        select jsonb_agg(jsonb_build_object(
                 'product_catalog_id', di.product_catalog_id,
                 'quantity_delivered', di.quantity_ordered))
          into v_eff_items
          from public.delivery_items di
         where di.delivery_id = p_delivery_id;
      end if;
    end if;

    -- [Feature A] Per-item stock guard (loops; single-item == legacy guard).
    for v_guard in
      select (e->>'product_catalog_id')::uuid as pid,
             sum((e->>'quantity_delivered')::int) as qd
        from jsonb_array_elements(v_eff_items) e
       group by (e->>'product_catalog_id')::uuid
    loop
      select coalesce(quantity_on_hand, 0) into v_on_hand
        from public.current_stock
       where agent_id = v_delivery.assigned_agent_id and product_catalog_id = v_guard.pid;
      if coalesce(v_on_hand, 0) < v_guard.qd then
        raise exception 'insufficient_stock: agent has % units of product %, delivery needs %',
          coalesce(v_on_hand, 0), v_guard.pid, v_guard.qd
          using errcode = 'P0001',
                hint = jsonb_build_object('code','insufficient_stock',
                  'product_catalog_id', v_guard.pid, 'on_hand', coalesce(v_on_hand, 0), 'needed', v_guard.qd)::text;
      end if;
    end loop;
  end if;

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status, changed_by_user_id, client_uuid, effective_at, reason, notes
  ) values (
    p_delivery_id, v_delivery.current_status, p_to_status, v_actor, p_client_uuid, v_effective, p_reason, p_notes
  );

  update public.deliveries
     set current_status      = p_to_status,
         scheduled_date      = v_final_date,
         quantity_delivered  = case when p_to_status = 'delivered' then p_quantity_delivered else quantity_delivered end,
         paid                = case when p_to_status = 'delivered' then p_paid else paid end,
         payment_method      = case when p_to_status = 'delivered' then p_payment_method else payment_method end,
         cash_pos_fee_snapshot = case
                                    when p_to_status = 'delivered' and p_payment_method = 'cash' and coalesce(p_paid, 0) > 0 then 500
                                    when p_to_status = 'delivered' then 0
                                    else cash_pos_fee_snapshot end
   where id = p_delivery_id;

  -- [Feature A] Persist per-item quantity_delivered; reconcile the legacy column
  -- to the item SUM so current_stock (legacy-based this phase) stays exact.
  if p_to_status = 'delivered' then
    v_sum_delivered := public._apply_item_deliveries(p_delivery_id, v_eff_items);
    update public.deliveries set quantity_delivered = v_sum_delivered where id = p_delivery_id;
  end if;

  perform public.write_audit(
    'delivery', p_delivery_id,
    jsonb_build_object(
      'current_status', v_delivery.current_status, 'scheduled_date', v_delivery.scheduled_date,
      'quantity_delivered', v_delivery.quantity_delivered, 'paid', v_delivery.paid,
      'payment_method', v_delivery.payment_method, 'cash_pos_fee_snapshot', v_delivery.cash_pos_fee_snapshot
    ),
    jsonb_build_object(
      'current_status', p_to_status,
      'scheduled_date', v_final_date,
      'quantity_delivered', case when p_to_status = 'delivered' then coalesce(v_sum_delivered, p_quantity_delivered) else v_delivery.quantity_delivered end,
      'paid', case when p_to_status = 'delivered' then p_paid else v_delivery.paid end,
      'payment_method', case when p_to_status = 'delivered' then p_payment_method else v_delivery.payment_method end,
      'item_quantities', case when p_to_status = 'delivered' then v_eff_items else null end,   -- [Feature A]
      'cash_pos_fee_snapshot', case
                                 when p_to_status = 'delivered' and p_payment_method = 'cash' and coalesce(p_paid, 0) > 0 then 500
                                 when p_to_status = 'delivered' then 0
                                 else v_delivery.cash_pos_fee_snapshot end
    ),
    p_reason
  );
end;
$function$

