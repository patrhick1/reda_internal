-- Keep replacements on their original row and include outgoing demand in stock planning.
begin;
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

  v_final_date     date;

  v_eff_items      jsonb;

  v_guard          record;

  v_sum_delivered  int;

  v_item_count     int;

  v_fulfilled_sib  record;

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



  -- Replacements reschedule this same exchange; they never create a rollover child.
  if v_delivery.order_type = 'replacement' and p_to_status = 'tomorrow' then
    v_new_date := public._ensure_workday((now() at time zone 'Africa/Lagos')::date + 1);
  end if;
  v_final_date := case

    when v_new_date is not null then v_new_date

    when (v_delivery.current_status = 'postponed' or (v_delivery.order_type = 'replacement' and v_delivery.current_status = 'tomorrow'))

         and p_to_status <> 'postponed'

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

    if p_payment_method not in ('cash','transfer','vendor_direct') then

      raise exception 'payment_method must be ''cash'', ''transfer'' or ''vendor_direct''' using errcode = '23514';

    end if;

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



    if p_item_quantities is not null then

      if jsonb_typeof(p_item_quantities) <> 'array' or jsonb_array_length(p_item_quantities) = 0 then

        raise exception 'p_item_quantities must be a non-empty array' using errcode = '23514';

      end if;

      v_eff_items := p_item_quantities;

    else

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

        raise exception 'insufficient_stock: agent has % units of "%", delivery needs %',

          coalesce(v_on_hand, 0), coalesce((select product_name from public.product_catalog where id = v_guard.pid), v_guard.pid::text), v_guard.qd

          using errcode = 'P0001',

                hint = jsonb_build_object('code','insufficient_stock',

                  'product_catalog_id', v_guard.pid, 'product_name', (select product_name from public.product_catalog where id = v_guard.pid), 'on_hand', coalesce(v_on_hand, 0), 'needed', v_guard.qd)::text;

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



  if p_to_status = 'delivered' then

    v_sum_delivered := public._apply_item_deliveries(p_delivery_id, v_eff_items);

    update public.deliveries set quantity_delivered = v_sum_delivered where id = p_delivery_id;

  end if;



  -- [Phase 2] Immutable delivery stock ledger. Replaces the current_stock

  -- view's derived delivered_decrements. Per delivered LINE ITEM; idempotency

  -- is inherited from the early-return on a duplicate p_client_uuid above.

  if p_to_status = 'delivered' then

    insert into public.stock_adjustments

      (agent_id, product_catalog_id, quantity_delta, reason, notes,

       client_uuid, created_by_user_id, delivery_id)

    select v_delivery.assigned_agent_id, di.product_catalog_id, -di.quantity_delivered, 'delivered',

           null, p_client_uuid || ':delivered:' || di.product_catalog_id::text, v_actor, p_delivery_id

      from public.delivery_items di

     where di.delivery_id = p_delivery_id

       and coalesce(di.quantity_delivered, 0) > 0;

  elsif v_delivery.current_status = 'delivered' then

    -- Leaving delivered (admin corrective transition) -> release stock back.

    insert into public.stock_adjustments

      (agent_id, product_catalog_id, quantity_delta, reason, notes,

       client_uuid, created_by_user_id, delivery_id)

    select v_delivery.assigned_agent_id, di.product_catalog_id, di.quantity_delivered, 'delivery_returned',

           'reverted: delivered -> ' || p_to_status,

           p_client_uuid || ':returned:' || di.product_catalog_id::text, v_actor, p_delivery_id

      from public.delivery_items di

     where di.delivery_id = p_delivery_id

       and coalesce(di.quantity_delivered, 0) > 0;

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

      'item_quantities', case when p_to_status = 'delivered' then v_eff_items else null end,

      'cash_pos_fee_snapshot', case

                                 when p_to_status = 'delivered' and p_payment_method = 'cash' and coalesce(p_paid, 0) > 0 then 500

                                 when p_to_status = 'delivered' then 0

                                 else v_delivery.cash_pos_fee_snapshot end

    ),

    p_reason

  );

end;

$function$;
CREATE OR REPLACE FUNCTION public.release_postponed_due(p_due_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_system_id uuid;
  v_row record;
  v_duplicate record;
  v_count integer := 0;
  v_cancelled integer := 0;
  v_deduped integer := 0;
  v_previous_eod_setting text := coalesce(current_setting('reda.in_eod_rollover', true), '');
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'releasing postponed orders requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  select id into v_system_id
    from public.users
   where lower(email) = 'system@reda.local'
   limit 1;
  if v_system_id is null then
    raise exception 'Reda System user not found; postponed release cannot be audited';
  end if;
  v_actor := coalesce(v_actor, v_system_id);

  -- Suppress the terminal sibling cascade while this function deliberately
  -- selects one canonical row and closes only the ranked surplus copies.
  perform set_config('reda.in_eod_rollover', 'true', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('release_postponed_due:' || p_due_date::text, 0)
  );

  -- Defensive backstop. Immediate consolidation handles new postponements,
  -- while this pass repairs pre-existing rows and any legacy/race edge case
  -- before users see them in the unassigned pool.
  for v_duplicate in
    with eligible as (
      select d.id, d.client_id, d.customer_phone_normalized,
             coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,
             d.scheduled_date, d.text_fingerprint,
             public._norm_address(d.raw_address) as norm_addr,
             d.assigned_agent_id, d.created_at, d.updated_at
        from public.deliveries d
       where d.order_type = 'delivery' and d.current_status = 'postponed'
         and d.scheduled_date <= p_due_date
         and d.deleted_at is null
         and d.order_type = 'delivery'
         and d.customer_phone_normalized is not null
    ),
    clustered as (
      select e.*,
             (
               select min(e2.id::text)
                 from eligible e2
                where e2.client_id = e.client_id
                  and e2.customer_phone_normalized = e.customer_phone_normalized
                  and e2.item_key = e.item_key
                  and e2.scheduled_date = e.scheduled_date
                  and (
                    e2.id = e.id
                    or (e2.text_fingerprint is not null
                        and e2.text_fingerprint = e.text_fingerprint)
                    or (e2.norm_addr is not null and e2.norm_addr = e.norm_addr)
                  )
             ) as sibling_cluster
        from eligible e
    ),
    ranked as (
      select c.*,
             row_number() over (
               partition by c.client_id, c.customer_phone_normalized,
                            c.item_key, c.scheduled_date, c.sibling_cluster
               order by c.updated_at desc, c.created_at asc, c.id asc
             ) as duplicate_rank,
             first_value(c.id) over (
               partition by c.client_id, c.customer_phone_normalized,
                            c.item_key, c.scheduled_date, c.sibling_cluster
               order by c.updated_at desc, c.created_at asc, c.id asc
             ) as canonical_delivery_id
        from clustered c
    )
    select *
      from ranked
     where duplicate_rank > 1
     order by scheduled_date, sibling_cluster, duplicate_rank
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      concat_ws('|',
        v_duplicate.client_id::text,
        v_duplicate.customer_phone_normalized,
        v_duplicate.item_key,
        v_duplicate.scheduled_date::text
      ), 0
    ));

    -- Recheck under a row lock: an immediate-consolidation trigger may have
    -- closed this copy while the release job was waiting.
    perform 1
      from public.deliveries
     where id = v_duplicate.id
       and current_status = 'postponed'
     for update;
    if not found then
      continue;
    end if;

    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id,
       client_uuid, reason, effective_at)
    values
      (v_duplicate.id, 'postponed', 'cancelled', v_system_id,
       'postpone-release-dedup:' || v_duplicate.canonical_delivery_id::text
         || ':' || v_duplicate.id::text,
       'Duplicate postponed copy consolidated into order '
         || v_duplicate.canonical_delivery_id::text || ' before release.',
       now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status     = 'cancelled',
           assigned_agent_id = null,
           updated_at         = now()
     where id = v_duplicate.id
       and current_status = 'postponed';

    if found then
      perform public.write_audit(
        p_entity_type := 'delivery',
        p_entity_id   := v_duplicate.id,
        p_old         := jsonb_build_object(
          'current_status', 'postponed',
          'assigned_agent_id', v_duplicate.assigned_agent_id,
          'scheduled_date', v_duplicate.scheduled_date
        ),
        p_new         := jsonb_build_object(
          'current_status', 'cancelled',
          'assigned_agent_id', null,
          'scheduled_date', v_duplicate.scheduled_date,
          'canonical_delivery_id', v_duplicate.canonical_delivery_id
        ),
        p_reason      := 'postponed_release_duplicate_consolidated',
        p_actor_id    := v_system_id
      );
      v_deduped := v_deduped + 1;
    end if;
  end loop;

  -- Existing release/auto-cancel behavior, now operating only on canonical
  -- rows after the defensive deduplication pass.
  for v_row in
    select d.id, d.current_status, d.scheduled_date, d.assigned_agent_id,
           cl.auto_cancel_soft_fails
      from public.deliveries d
      join public.clients cl on cl.id = d.client_id
     where d.order_type = 'delivery' and d.current_status = 'postponed'
       and d.scheduled_date <= p_due_date
       and d.deleted_at is null
     for update of d
  loop
    if v_row.auto_cancel_soft_fails then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-autocancel-postponed:' || v_row.scheduled_date::text
          || ':' || v_row.id::text,
        p_delivery_id => v_row.id,
        p_to_status   => 'failed_delivery',
        p_reason      => 'eod_auto_cancel:client_policy'
      );

      update public.deliveries
         set assigned_agent_id = null,
             updated_at = now()
       where id = v_row.id;

      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id,
       client_uuid, reason, effective_at)
    values
      (v_row.id, v_row.current_status, 'pending', v_actor,
       'eod-release-postponed:' || v_row.scheduled_date::text || ':' || v_row.id::text,
       'postponed order came due — released to the unassigned pool for fresh assignment',
       now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status      = 'pending',
           assigned_agent_id  = null,
           rolled_from_status = 'postponed',
           rolled_from_date   = v_row.scheduled_date,
           updated_at         = now()
     where id = v_row.id;

    perform public.write_audit(
      p_entity_type := 'delivery',
      p_entity_id   := v_row.id,
      p_old         := jsonb_build_object(
        'current_status', 'postponed',
        'assigned_agent_id', v_row.assigned_agent_id,
        'scheduled_date', v_row.scheduled_date
      ),
      p_new         := jsonb_build_object(
        'current_status', 'pending',
        'assigned_agent_id', null,
        'scheduled_date', v_row.scheduled_date,
        'rolled_from_status', 'postponed'
      ),
      p_reason      := 'eod_release_postponed',
      p_actor_id    := v_actor
    );

    v_count := v_count + 1;
  end loop;

  if v_deduped > 0 then
    raise notice 'eod: consolidated % duplicate postponed copy/copies before release',
      v_deduped;
  end if;
  if v_count > 0 then
    raise notice 'eod: released % postponed order(s) due on/before % into the unassigned pool',
      v_count, p_due_date;
  end if;
  if v_cancelled > 0 then
    raise notice 'eod: auto-cancelled % postponed order(s) due on/before % per client policy',
      v_cancelled, p_due_date;
  end if;

  -- A direct RPC call may share a wider transaction. Restore the caller's
  -- setting so unrelated status changes later in that transaction are not
  -- accidentally exempted from sibling coordination.
  perform set_config('reda.in_eod_rollover', v_previous_eod_setting, true);

  return v_count;
end
$function$;
CREATE OR REPLACE FUNCTION public.stock_coverage_today()
 RETURNS TABLE(product_catalog_id uuid, product_name text, orders_open integer, qty_open integer, qty_committed integer, on_hand_total integer, on_hand_warehouse integer, my_on_hand integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_date date := (now() at time zone 'Africa/Lagos')::date;
  v_uid  uuid := auth.uid();
begin
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active) then
    raise exception 'stock coverage requires an active staff account' using errcode = '42501';
  end if;

  return query
  with demand as (
    -- One row per line item (Feature A), legacy single-product fallback
    -- otherwise. Null pids (shouldn't happen, but defensive) drop out in agg.
    select coalesce(di.product_catalog_id, d.product_catalog_id)     as pid,
           coalesce(di.quantity_ordered, d.quantity_ordered, 1)::int as qty,
           d.id                                                      as delivery_id,
           d.current_status in ('available', 'available_evening')    as committed
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
      left join public.delivery_items di on di.delivery_id = d.id
     where d.scheduled_date = v_date
       and d.deleted_at is null
       and d.order_type in ('delivery', 'replacement')
       and sd.category <> 'terminal'
  ),
  agg as (
    select dm.pid,
           count(distinct dm.delivery_id)::int                        as orders_open,
           sum(dm.qty)::int                                           as qty_open,
           coalesce(sum(dm.qty) filter (where dm.committed), 0)::int  as qty_committed
      from demand dm
     where dm.pid is not null
     group by dm.pid
  ),
  stock as (
    select cs.product_catalog_id as pid,
           coalesce(sum(cs.quantity_on_hand), 0)::int as on_hand_total,
           coalesce(sum(cs.quantity_on_hand) filter (where exists (
             select 1 from public.users u
              where u.id = cs.agent_id
                and u.role = 'warehouse'
                and u.warehouse_id is null
           )), 0)::int as on_hand_warehouse,
           coalesce(sum(cs.quantity_on_hand) filter (where cs.agent_id = v_uid), 0)::int as my_on_hand
      from public.current_stock cs
     group by cs.product_catalog_id
  )
  select a.pid,
         pc.product_name,
         a.orders_open,
         a.qty_open,
         a.qty_committed,
         coalesce(s.on_hand_total, 0),
         coalesce(s.on_hand_warehouse, 0),
         coalesce(s.my_on_hand, 0)
    from agg a
    join public.product_catalog pc on pc.id = a.pid
    left join stock s on s.pid = a.pid
   order by pc.product_name;
end;
$function$;
notify pgrst, 'reload schema';
commit;
