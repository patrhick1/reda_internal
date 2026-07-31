-- Captured live definitions (self-hosted box, 2026-07-31) — READ ONLY REFERENCE.
--
-- Captured together because they are one interlocking problem. Both stock RPCs
-- carry the same blanket guard:
--
--   if not exists (select 1 from public.product_catalog
--                   where id = p_product_catalog_id and is_active = true) then
--     raise exception 'product not found or inactive' using errcode = '23514';
--
-- which means a deactivated product cannot be moved OR written off. That makes
-- "collect the stock from the agent first" the only workable order, and it also
-- breaks deactivate_user: all three of its dispositions route through these two
-- functions (warehouse / transfer:<uuid> -> create_stock_transfer, loss ->
-- create_stock_adjustment), so an agent holding a deactivated product cannot be
-- offboarded at all. Latent only because agent-held inactive stock is currently
-- zero. See scripts/fix-inactive-product-stock-moves.sql for the direction-aware
-- replacement.
--
-- Note create_stock_transfer already has p_allow_inactive_from — an escape hatch
-- for an inactive USER, added so deactivate_user could drain an already-flipped
-- rider. There is no equivalent for an inactive PRODUCT.

CREATE OR REPLACE FUNCTION public.create_stock_adjustment(p_client_uuid text, p_agent_id uuid, p_product_catalog_id uuid, p_quantity_delta integer, p_reason text, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_id           uuid;
  v_existing     uuid;
  v_actor        uuid := auth.uid();
  v_role         text;
  v_warehouse_id uuid;
  v_on_hand      int;
begin
  if v_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select role, warehouse_id into v_role, v_warehouse_id from public.users where id = v_actor;

  -- Permission gate (admin first, then warehouse-scoped, else deny).
  if v_role = 'admin' then
    null;  -- allow all paths (unchanged)
  elsif v_role = 'warehouse'
        and p_reason in ('bulk_intake','loss','theft','damaged','found')
        and p_agent_id = coalesce(v_warehouse_id, v_actor) then
    null;  -- warehouse acts on its place's holdings (staff → linked place; place → self), except correction
  else
    raise exception 'permission denied'
      using errcode = '42501',
            hint    = 'admin can adjust any holder; warehouse can adjust only their place''s holdings (no correction).';
  end if;

  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'quantity_delta must be non-zero' using errcode = '23514';
  end if;
  if p_reason not in ('loss','theft','damaged','found','correction','bulk_intake') then
    raise exception 'invalid reason for single-row adjustment: %', p_reason using errcode = '23514';
  end if;
  if p_reason in ('loss','theft','damaged') and p_quantity_delta >= 0 then
    raise exception '% requires a negative quantity_delta', p_reason using errcode = '23514';
  end if;
  if p_reason in ('found','bulk_intake') and p_quantity_delta <= 0 then
    raise exception '% requires a positive quantity_delta', p_reason using errcode = '23514';
  end if;
  -- correction: either sign OK; explicit "books were wrong" escape hatch.

  -- Idempotency.
  select id into v_existing
    from public.stock_adjustments
   where client_uuid = p_client_uuid
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  if not exists (select 1 from public.users where id = p_agent_id and is_active = true) then
    raise exception 'user not found or inactive' using errcode = '23514';
  end if;
  if not exists (select 1 from public.product_catalog where id = p_product_catalog_id and is_active = true) then
    raise exception 'product not found or inactive' using errcode = '23514';
  end if;

  if p_reason in ('loss','theft','damaged') then
    select coalesce(quantity_on_hand, 0) into v_on_hand
      from public.current_stock
     where agent_id           = p_agent_id
       and product_catalog_id = p_product_catalog_id;

    if coalesce(v_on_hand, 0) < (-p_quantity_delta) then
      raise exception
        'insufficient_stock: user has % units, % needs %',
        coalesce(v_on_hand, 0), p_reason, (-p_quantity_delta)
      using errcode = 'P0001',
            hint = jsonb_build_object(
              'code',    'insufficient_stock',
              'on_hand', coalesce(v_on_hand, 0),
              'needed',  (-p_quantity_delta)
            )::text;
    end if;
  end if;

  insert into public.stock_adjustments (
    agent_id, product_catalog_id, quantity_delta, reason, notes,
    client_uuid, created_by_user_id
  ) values (
    p_agent_id, p_product_catalog_id, p_quantity_delta, p_reason, p_notes,
    p_client_uuid, v_actor
  ) returning id into v_id;

  perform public.write_audit(
    'stock_adjustment', v_id, null,
    jsonb_build_object(
      'agent_id',           p_agent_id,
      'product_catalog_id', p_product_catalog_id,
      'quantity_delta',     p_quantity_delta,
      'reason',             p_reason,
      'notes',              p_notes
    )
  );

  return v_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.create_stock_transfer(p_client_uuid text, p_from_user_id uuid, p_to_user_id uuid, p_product_catalog_id uuid, p_quantity integer, p_reason text, p_notes text DEFAULT NULL::text, p_allow_inactive_from boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_source_id    uuid;
  v_target_id    uuid;
  v_existing     uuid;
  v_actor        uuid := auth.uid();
  v_role         text;
  v_warehouse_id uuid;
  v_from_active  boolean;
  v_on_hand      int;
begin
  if v_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select role, warehouse_id into v_role, v_warehouse_id from public.users where id = v_actor;

  -- Permission gate (admin + dispatcher = any paired reason; warehouse only as
  -- a participant — and staff participate as their linked place).
  if v_role = 'admin' then
    null;  -- allow all paired reasons
  elsif v_role = 'dispatcher' then
    null;  -- dispatcher coordinates rider stock — same powers as admin here
  elsif v_role = 'warehouse'
        and p_reason = 'warehouse_issue'
        and p_from_user_id = coalesce(v_warehouse_id, v_actor) then
    null;  -- warehouse place is the source (issuing to an agent)
  elsif v_role = 'warehouse'
        and p_reason = 'warehouse_return'
        and p_to_user_id = coalesce(v_warehouse_id, v_actor) then
    null;  -- warehouse place is the destination (receiving from an agent)
  else
    raise exception 'permission denied'
      using errcode = '42501',
            hint    = 'admin or dispatcher runs any paired transfer; warehouse can only do warehouse_issue (from=their place) or warehouse_return (to=their place).';
  end if;

  if p_client_uuid is null or trim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be > 0' using errcode = '23514';
  end if;
  if p_reason not in ('transfer','warehouse_return','warehouse_issue') then
    raise exception 'invalid paired reason: %', p_reason using errcode = '23514';
  end if;
  if p_from_user_id = p_to_user_id then
    raise exception 'from and to users must differ' using errcode = '23514';
  end if;

  select id into v_existing
    from public.stock_adjustments
   where client_uuid = p_client_uuid
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  select is_active into v_from_active from public.users where id = p_from_user_id;
  if v_from_active is null then
    raise exception 'from user not found' using errcode = '23514';
  end if;
  if not v_from_active and not p_allow_inactive_from then
    raise exception 'from user is inactive' using errcode = '23514';
  end if;

  if not exists (select 1 from public.users where id = p_to_user_id and is_active = true) then
    raise exception 'to user not found or inactive' using errcode = '23514';
  end if;
  if not exists (select 1 from public.product_catalog where id = p_product_catalog_id and is_active = true) then
    raise exception 'product not found or inactive' using errcode = '23514';
  end if;

  if v_from_active then
    select coalesce(quantity_on_hand, 0) into v_on_hand
      from public.current_stock
     where agent_id           = p_from_user_id
       and product_catalog_id = p_product_catalog_id;

    if coalesce(v_on_hand, 0) < p_quantity then
      raise exception
        'insufficient_stock: source has % units, transfer needs %',
        coalesce(v_on_hand, 0), p_quantity
      using errcode = 'P0001',
            hint = jsonb_build_object(
              'code',    'insufficient_stock',
              'on_hand', coalesce(v_on_hand, 0),
              'needed',  p_quantity
            )::text;
    end if;
  end if;

  insert into public.stock_adjustments (
    agent_id, product_catalog_id, quantity_delta, reason, notes,
    client_uuid, created_by_user_id
  ) values (
    p_from_user_id, p_product_catalog_id, -p_quantity, p_reason, p_notes,
    p_client_uuid, v_actor
  ) returning id into v_source_id;

  insert into public.stock_adjustments (
    agent_id, product_catalog_id, quantity_delta, reason, notes,
    client_uuid, created_by_user_id, related_adjustment_id
  ) values (
    p_to_user_id, p_product_catalog_id, p_quantity, p_reason, p_notes,
    p_client_uuid || ':paired', v_actor, v_source_id
  ) returning id into v_target_id;

  update public.stock_adjustments
     set related_adjustment_id = v_target_id
   where id = v_source_id;

  perform public.write_audit(
    'stock_transfer', v_source_id, null,
    jsonb_build_object(
      'from_user_id',          p_from_user_id,
      'to_user_id',            p_to_user_id,
      'product_catalog_id',    p_product_catalog_id,
      'quantity',              p_quantity,
      'reason',                p_reason,
      'notes',                 p_notes,
      'related_adjustment_id', v_target_id
    )
  );

  return v_source_id;
end;
$function$

CREATE OR REPLACE FUNCTION public.deactivate_user(p_id uuid, p_reason text, p_stock_disposition text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_old        public.users;
  v_action     text;
  v_target     uuid;
  v_warehouse  uuid;
  v_stock      record;
  v_qty        int;
  v_uuid_seed  text;
  v_i          int := 0;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason required for deactivation' using errcode = '23514';
  end if;

  select * into v_old from public.users where id = p_id;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if not v_old.is_active then return; end if;
  if p_id = auth.uid() then
    raise exception 'cannot deactivate yourself' using errcode = '42501';
  end if;

  if v_old.role = 'agent' and nullif(trim(p_stock_disposition), '') is not null then
    v_uuid_seed := 'deactivate-' || v_old.id::text || '-' || extract(epoch from now())::bigint::text;

    if p_stock_disposition like 'transfer:%' then
      v_action := 'transfer';
      begin
        v_target := substring(p_stock_disposition from 10)::uuid;
      exception when others then
        raise exception 'invalid transfer target in disposition: %', p_stock_disposition using errcode = '23514';
      end;
      if not exists (select 1 from public.users where id = v_target and role = 'agent' and is_active = true) then
        raise exception 'transfer target is not an active agent' using errcode = '23514';
      end if;
    elsif p_stock_disposition = 'warehouse' then
      v_action := 'warehouse';
      select id into v_warehouse from public.users where role = 'warehouse' and is_active = true limit 1;
      if v_warehouse is null then
        raise exception 'no active warehouse user found to receive returned stock' using errcode = '23514';
      end if;
    elsif p_stock_disposition = 'loss' then
      v_action := 'loss';
    else
      raise exception 'invalid stock disposition: %', p_stock_disposition using errcode = '23514';
    end if;

    for v_stock in
      select product_catalog_id, quantity_on_hand
        from public.current_stock
       where agent_id = v_old.id
         and quantity_on_hand > 0
    loop
      v_i := v_i + 1;
      v_qty := v_stock.quantity_on_hand::int;     -- cast bigint -> int

      if v_action = 'transfer' then
        perform public.create_stock_transfer(
          v_uuid_seed || ':' || v_i::text,
          v_old.id, v_target, v_stock.product_catalog_id,
          v_qty, 'transfer',
          'Auto-moved on deactivation of ' || v_old.display_name
        );
      elsif v_action = 'warehouse' then
        perform public.create_stock_transfer(
          v_uuid_seed || ':' || v_i::text,
          v_old.id, v_warehouse, v_stock.product_catalog_id,
          v_qty, 'warehouse_return',
          'Auto-returned on deactivation of ' || v_old.display_name
        );
      elsif v_action = 'loss' then
        perform public.create_stock_adjustment(
          v_uuid_seed || ':' || v_i::text,
          v_old.id, v_stock.product_catalog_id,
          -v_qty, 'loss',
          'Written off on deactivation of ' || v_old.display_name
        );
      end if;
    end loop;
  end if;

  update public.users
     set is_active      = false,
         deactivated_at = now()
   where id = p_id;

  perform public.write_audit(
    'user', p_id,
    jsonb_build_object('is_active', true),
    case
      when p_stock_disposition is not null then
        jsonb_build_object('is_active', false, 'stock_disposition_applied', p_stock_disposition)
      else jsonb_build_object('is_active', false)
    end,
    p_reason
  );
end;
$function$

