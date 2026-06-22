-- ============================================================================
-- PHASE 2 — Delivered movements become an immutable stock ledger
-- ============================================================================
-- Paste-and-run as ONE script in the Supabase SQL editor. Everything is wrapped
-- in a single transaction with an on-hand ASSERTION at the end: if any
-- (agent, product) quantity_on_hand would change, it RAISES and the whole thing
-- rolls back. Nothing is committed unless current_stock is byte-identical.
--
-- What changes:
--   * delivered stock now leaves the agent's shelf as a real append-only
--     stock_adjustments row (reason 'delivered', negative), and comes back as a
--     'delivery_returned' row (positive) when an order leaves 'delivered'.
--   * current_stock stops deriving delivered_decrements — it is purely the
--     ledger sum now.
--   * the movement RPCs drop their derived `del` branch (delivered now flows
--     through the adjustment branch, enriched via the new delivery_id link).
--
-- Untouched: reconciliation/earnings (money-side, read quantity_delivered which
-- stays on the rows), return_delivery_leftover (already writes real rows),
-- rollover (delivered is terminal).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Schema: new reasons + delivery linkage
-- ----------------------------------------------------------------------------
alter table public.stock_adjustments drop constraint stock_adjustments_reason_check;
alter table public.stock_adjustments add constraint stock_adjustments_reason_check
  check (reason = any (array[
    'loss','theft','damaged','found','correction','transfer',
    'warehouse_return','warehouse_issue','bulk_intake',
    'delivered','delivery_returned'
  ]));

alter table public.stock_adjustments
  add column if not exists delivery_id uuid references public.deliveries(id) on delete set null;
create index if not exists idx_stock_adj_delivery
  on public.stock_adjustments (delivery_id) where delivery_id is not null;

-- ----------------------------------------------------------------------------
-- 2. change_delivery_status — append the delivery ledger rows
--    (verbatim live body + the [Phase 2] block after _apply_item_deliveries)
-- ----------------------------------------------------------------------------
create or replace function public.change_delivery_status(p_client_uuid text, p_delivery_id uuid, p_to_status text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_quantity_delivered integer DEFAULT NULL::integer, p_paid numeric DEFAULT NULL::numeric, p_payment_method text DEFAULT NULL::text, p_effective_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_new_scheduled_date date DEFAULT NULL::date, p_item_quantities jsonb DEFAULT NULL::jsonb)
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

-- ----------------------------------------------------------------------------
-- 3. revert_delivery_to_pending — release stock via a ledger row
--    (verbatim live body + the [Phase 2] insert before nulling the item qty)
-- ----------------------------------------------------------------------------
create or replace function public.revert_delivery_to_pending(p_delivery_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor        uuid := auth.uid();
  v_row          public.deliveries%rowtype;
  v_history_key  text := gen_random_uuid()::text;
begin
  if (select role from public.users where id = v_actor)
       not in ('admin','dispatcher') then
    raise exception 'revert delivered requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required for revert' using errcode = '22023';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'cannot revert a deleted delivery' using errcode = '22023';
  end if;
  if v_row.current_status <> 'delivered' then
    raise exception 'can only revert from delivered (current: %)', v_row.current_status
      using errcode = '22023',
            hint   = 'use change_delivery_status for non-delivered transitions';
  end if;

  insert into public.delivery_status_history (
    delivery_id, from_status, to_status,
    changed_by_user_id, client_uuid, effective_at, reason
  ) values (
    p_delivery_id, 'delivered', 'pending',
    v_actor, v_history_key, now(),
    'revert_delivered: ' || btrim(p_reason)
  );

  -- [Phase 2] Release the delivered stock back to the agent as an append-only
  -- ledger row (current_stock no longer derives this). Read the per-line
  -- delivered quantities BEFORE they are nulled below.
  insert into public.stock_adjustments
    (agent_id, product_catalog_id, quantity_delta, reason, notes,
     client_uuid, created_by_user_id, delivery_id)
  select v_row.assigned_agent_id, di.product_catalog_id, di.quantity_delivered, 'delivery_returned',
         'revert_delivered: ' || btrim(p_reason),
         v_history_key || ':returned:' || di.product_catalog_id::text, v_actor, p_delivery_id
    from public.delivery_items di
   where di.delivery_id = p_delivery_id
     and coalesce(di.quantity_delivered, 0) > 0;

  update public.deliveries
     set current_status        = 'pending',
         quantity_delivered    = null,
         paid                  = null,
         payment_method        = null,
         cash_pos_fee_snapshot = null,
         updated_at            = now()
   where id = p_delivery_id;

  update public.delivery_items
     set quantity_delivered = null
   where delivery_id = p_delivery_id;

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := p_delivery_id,
    p_old         := jsonb_build_object(
      'current_status',        v_row.current_status,
      'quantity_delivered',    v_row.quantity_delivered,
      'paid',                  v_row.paid,
      'payment_method',        v_row.payment_method,
      'cash_pos_fee_snapshot', v_row.cash_pos_fee_snapshot
    ),
    p_new         := jsonb_build_object(
      'current_status',        'pending',
      'quantity_delivered',    null,
      'paid',                  null,
      'payment_method',        null,
      'cash_pos_fee_snapshot', null
    ),
    p_reason      := 'revert_delivered: ' || btrim(p_reason)
  );
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Movement RPCs — drop the derived `del` branch; delivered now flows through
--    the adjustment branch, enriched via delivery_id. UI contract preserved:
--    delivery-linked rows report source='delivery' (deep-link) + customer_name,
--    and 'delivered' rows carry quantity_ordered for the partial badge.
-- ----------------------------------------------------------------------------
create or replace function public.list_stock_movements(p_holder_id uuid, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_event_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_actor_id uuid DEFAULT NULL::uuid, p_kinds text[] DEFAULT NULL::text[], p_counterparty_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(source text, event_id uuid, event_at timestamp with time zone, event_kind text, product_catalog_id uuid, product_name text, quantity_delta integer, quantity_ordered integer, notes text, actor_id uuid, actor_name text, counterparty_holder_id uuid, counterparty_holder_name text, related_adjustment_id uuid, delivery_id uuid, customer_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not (
       coalesce(public.is_admin_or_dispatcher(), false)
    or coalesce(p_holder_id = auth.uid(), false)
    or coalesce(p_holder_id = (select u.warehouse_id from public.users u where u.id = auth.uid()), false)
  ) then
    raise exception 'not authorised to view this holder''s stock history' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  select
    case when sa.delivery_id is not null then 'delivery' else 'adjustment' end::text,
    sa.id, sa.created_at, sa.reason, sa.product_catalog_id, p.product_name, sa.quantity_delta,
    case when sa.reason = 'delivered' then di.quantity_ordered else null end::int,
    sa.notes, sa.created_by_user_id, au.display_name,
    cp.agent_id, cu.display_name, sa.related_adjustment_id,
    sa.delivery_id, dlv.customer_name
  from public.stock_adjustments sa
  join public.product_catalog p on p.id = sa.product_catalog_id
  left join public.users au on au.id = sa.created_by_user_id
  left join public.stock_adjustments cp on cp.id = sa.related_adjustment_id
  left join public.users cu on cu.id = cp.agent_id
  left join public.deliveries dlv on dlv.id = sa.delivery_id
  left join public.delivery_items di
         on di.delivery_id = sa.delivery_id and di.product_catalog_id = sa.product_catalog_id
  where sa.agent_id = p_holder_id
    and (p_before_at is null or (sa.created_at, sa.id) < (p_before_at, p_before_event_id))
    and (p_actor_id is null or sa.created_by_user_id = p_actor_id)
    and (p_kinds is null or sa.reason = any(p_kinds))
    and (p_counterparty_id is null or cp.agent_id = p_counterparty_id)
  order by sa.created_at desc, sa.id desc
  limit p_limit;
end;
$function$;

create or replace function public.list_stock_movements_global(p_client_id uuid DEFAULT NULL::uuid, p_product_catalog_id uuid DEFAULT NULL::uuid, p_holder_id uuid DEFAULT NULL::uuid, p_kinds text[] DEFAULT NULL::text[], p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_event_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS TABLE(source text, event_id uuid, event_at timestamp with time zone, event_kind text, product_catalog_id uuid, product_name text, quantity_delta integer, quantity_ordered integer, notes text, actor_id uuid, actor_name text, counterparty_holder_id uuid, counterparty_holder_name text, related_adjustment_id uuid, delivery_id uuid, customer_name text, holder_id uuid, holder_name text, client_id uuid, client_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not coalesce(public.is_admin_or_dispatcher(), false) then
    raise exception 'not authorised to view company-wide stock history' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  select
    case when sa.delivery_id is not null then 'delivery' else 'adjustment' end::text,
    sa.id, sa.created_at, sa.reason, sa.product_catalog_id, p.product_name, sa.quantity_delta,
    case when sa.reason = 'delivered' then di.quantity_ordered else null end::int,
    sa.notes, sa.created_by_user_id, au.display_name,
    cp.agent_id, cu.display_name, sa.related_adjustment_id,
    sa.delivery_id, dlv.customer_name,
    sa.agent_id, hu.display_name, p.client_id, c.name
  from public.stock_adjustments sa
  join public.product_catalog p on p.id = sa.product_catalog_id
  join public.clients c on c.id = p.client_id
  left join public.users hu on hu.id = sa.agent_id
  left join public.users au on au.id = sa.created_by_user_id
  left join public.stock_adjustments cp on cp.id = sa.related_adjustment_id
  left join public.users cu on cu.id = cp.agent_id
  left join public.deliveries dlv on dlv.id = sa.delivery_id
  left join public.delivery_items di
         on di.delivery_id = sa.delivery_id and di.product_catalog_id = sa.product_catalog_id
  where not (sa.reason in ('warehouse_issue','warehouse_return','transfer') and sa.quantity_delta > 0)
    and (p_client_id is null or p.client_id = p_client_id)
    and (p_product_catalog_id is null or sa.product_catalog_id = p_product_catalog_id)
    and (p_holder_id is null or sa.agent_id = p_holder_id)
    and (p_kinds is null or sa.reason = any(p_kinds))
    and (p_before_at is null or (sa.created_at, sa.id) < (p_before_at, p_before_event_id))
  order by sa.created_at desc, sa.id desc
  limit p_limit;
end;
$function$;

create or replace function public.list_movement_actors(p_holder_id uuid)
 RETURNS TABLE(actor_id uuid, actor_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  if not (
       coalesce(public.is_admin_or_dispatcher(), false)
    or coalesce(p_holder_id = auth.uid(), false)
    or coalesce(p_holder_id = (select u.warehouse_id from public.users u where u.id = auth.uid()), false)
  ) then
    raise exception 'not authorised to view this holder''s stock history' using errcode = '42501';
  end if;

  return query
  select distinct sa.created_by_user_id as actor_id, u.display_name as actor_name
    from public.stock_adjustments sa
    join public.users u on u.id = sa.created_by_user_id
   where sa.agent_id = p_holder_id and sa.created_by_user_id is not null
   order by u.display_name asc nulls last;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 5. Snapshot current on-hand (OLD view, still CTE-based) for the assertion.
-- ----------------------------------------------------------------------------
create temp table _before_stock on commit drop as
  select agent_id, product_catalog_id, quantity_on_hand from public.current_stock;

-- ----------------------------------------------------------------------------
-- 6. Backfill: one 'delivered' ledger row per delivered LINE ITEM, stamped at
--    the real delivered time. Sum per (agent,product) == the old CTE decrement.
-- ----------------------------------------------------------------------------
insert into public.stock_adjustments
  (agent_id, product_catalog_id, quantity_delta, reason, notes,
   client_uuid, created_by_user_id, delivery_id, created_at)
select d.assigned_agent_id, di.product_catalog_id, -di.quantity_delivered, 'delivered',
       'phase2 backfill', 'phase2-backfill:' || di.id::text,
       coalesce(dh.changed_by_user_id, d.assigned_agent_id,
                '2d8d5895-d2a8-4900-b15e-7662b176a805'::uuid),  -- Reda System
       d.id,
       coalesce(dh.changed_at, d.updated_at, now())
from public.deliveries d
join public.delivery_items di on di.delivery_id = d.id
left join lateral (
  select changed_at, changed_by_user_id
    from public.delivery_status_history
   where delivery_id = d.id and to_status = 'delivered'
   order by changed_at desc limit 1
) dh on true
where d.current_status = 'delivered'
  and d.deleted_at is null
  and coalesce(di.quantity_delivered, 0) > 0;

-- ----------------------------------------------------------------------------
-- 7. Swap current_stock to a pure ledger sum (drop the delivered_decrements CTE).
-- ----------------------------------------------------------------------------
create or replace view public.current_stock as
  select agent_id, product_catalog_id, sum(quantity_delta)::bigint as quantity_on_hand
    from public.stock_adjustments
   group by agent_id, product_catalog_id
  having sum(quantity_delta) <> 0;

-- ----------------------------------------------------------------------------
-- 8. ASSERT: on-hand byte-identical before vs after. Any drift rolls back all.
-- ----------------------------------------------------------------------------
do $$
declare v_bad int;
begin
  select count(*) into v_bad
  from (
    select coalesce(b.quantity_on_hand, 0) as bq, coalesce(a.quantity_on_hand, 0) as aq
    from _before_stock b
    full outer join public.current_stock a
      on b.agent_id = a.agent_id and b.product_catalog_id = a.product_catalog_id
  ) t
  where t.bq <> t.aq;

  if v_bad > 0 then
    raise exception 'PHASE 2 ABORTED: % (agent,product) on-hand rows changed — rolling back', v_bad;
  end if;
  raise notice 'Phase 2 OK: current_stock unchanged across all holders.';
end $$;

commit;
