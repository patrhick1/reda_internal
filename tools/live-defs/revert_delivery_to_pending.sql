-- ============================================================================
-- revert_delivery_to_pending — admin/dispatcher "undo a wrongly-delivered row".
--
-- Reverts a delivered delivery back to pending, releases the delivered stock to
-- the agent as an append-only ledger row, and nulls the delivered-time fields.
--
-- GUARD (added 2026-06-26): only order_type='delivery' rows may be reverted.
-- A waybill/pickup is a money-only record with no product/phone/address and is
-- terminal by construction. Reverting one to 'pending' stranded it in a
-- non-terminal status, where the EOD rollover then tried to roll it forward —
-- the forward INSERT defaults order_type to 'delivery' and tripped
-- deliveries_delivery_requires_fields, aborting the whole rollover batch
-- (root cause of the 2026-06-25 EOD failure). Waybills never enter the delivery
-- lifecycle, so block the revert at the source. To undo a mistaken waybill,
-- soft-delete it (deleted_at) and recreate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.revert_delivery_to_pending(p_delivery_id uuid, p_reason text)
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

  -- Waybills/pickups never enter the delivery lifecycle — reverting one strands
  -- it in a non-terminal status and breaks the EOD rollover. Block at the source.
  if v_row.order_type is distinct from 'delivery' then
    raise exception 'only deliveries can be reverted to pending (order_type=%)', v_row.order_type
      using errcode = '22023',
            hint   = 'waybills/pickups are money-only records; soft-delete and recreate instead';
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
