-- #279: stock-only waybill adjustments. No financial waybill changes.
begin;

-- Serialize a product's ledger operations, including deliveries and paired
-- transfers. A product-level key avoids opposite transfers taking holder locks
-- in reverse order. Correction and actual delivered-stock deficits retain their
-- existing policy; only stock-checking RPCs reject unavailable quantities.
create or replace function public._lock_stock_product(p_product uuid)
returns void language sql volatile security definer set search_path=public,pg_temp
as $$select pg_advisory_xact_lock(hashtextextended('stock-product:' || p_product::text,0))$$;
revoke all on function public._lock_stock_product(uuid) from public,anon,authenticated;

create or replace function public._serialize_stock_ledger()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if TG_OP='DELETE' then
    perform public._lock_stock_product(OLD.product_catalog_id);
    return OLD;
  elsif TG_OP='UPDATE' then
    if OLD.product_catalog_id is distinct from NEW.product_catalog_id then
      perform public._lock_stock_product(least(OLD.product_catalog_id,NEW.product_catalog_id));
      perform public._lock_stock_product(greatest(OLD.product_catalog_id,NEW.product_catalog_id));
    else
      perform public._lock_stock_product(NEW.product_catalog_id);
    end if;
  else
    perform public._lock_stock_product(NEW.product_catalog_id);
  end if;
  return NEW;
end$$;
revoke all on function public._serialize_stock_ledger() from public,anon,authenticated;
drop trigger if exists serialize_stock_ledger on public.stock_adjustments;
create trigger serialize_stock_ledger before insert or update or delete
on public.stock_adjustments for each row execute function public._serialize_stock_ledger();

alter table public.stock_adjustments drop constraint stock_adjustments_reason_check;
alter table public.stock_adjustments add constraint stock_adjustments_reason_check
check(reason in ('loss','theft','damaged','found','correction','waybill','transfer',
 'warehouse_return','warehouse_issue','bulk_intake','delivered','delivery_returned',
 'replacement_outbound','replacement_return_accepted'));

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
  if p_reason is null or p_reason not in ('loss','theft','damaged','found','correction','bulk_intake','waybill') then
    raise exception 'invalid reason for single-row adjustment: %', p_reason using errcode = '23514';
  end if;
  if p_reason in ('loss','theft','damaged','waybill') and p_quantity_delta >= 0 then
    raise exception '% requires a negative quantity_delta', p_reason using errcode = '23514';
  end if;
  if p_reason in ('found','bulk_intake') and p_quantity_delta <= 0 then
    raise exception '% requires a positive quantity_delta', p_reason using errcode = '23514';
  end if;
  -- correction: either sign OK; explicit "books were wrong" escape hatch.

  -- Request lock precedes the lookup, including retries on two devices.
  perform pg_advisory_xact_lock(hashtextextended('stock-request:' || p_client_uuid, 0));
  -- One product lock also covers both sides of a transfer; different products
  -- remain independent. The ledger trigger coordinates non-RPC stock writes.
  perform public._lock_stock_product(p_product_catalog_id);

  -- Idempotency.
  select id into v_existing
    from public.stock_adjustments
   where client_uuid = p_client_uuid
   limit 1;
  if v_existing is not null then
    if not exists (select 1 from public.stock_adjustments where id=v_existing
      and agent_id=p_agent_id and product_catalog_id=p_product_catalog_id
      and quantity_delta=p_quantity_delta and reason=p_reason
      and notes is not distinct from p_notes and created_by_user_id=v_actor) then
      raise exception 'request id already used for another stock adjustment' using errcode='22023';
    end if;
    return v_existing;
  end if;

  if not exists (select 1 from public.users where id = p_agent_id and is_active = true) then
    raise exception 'user not found or inactive' using errcode = '23514';
  end if;
  -- The product must EXIST. Whether it must be ACTIVE depends on the reason.
  if not exists (select 1 from public.product_catalog where id = p_product_catalog_id) then
    raise exception 'product not found' using errcode = '23514';
  end if;
  -- Writing DOWN a deactivated product has to stay possible: units already out
  -- there get lost, stolen or damaged after the product is retired, and
  -- deactivate_user's 'loss' disposition lands here. Only the two reasons that
  -- bring NEW units in stay closed -- nobody should be receiving more of a
  -- product the catalog has retired.
  if p_reason in ('bulk_intake','found')
     and not exists (select 1 from public.product_catalog
                      where id = p_product_catalog_id and is_active = true) then
    raise exception 'product is inactive - cannot receive more units of a deactivated product'
      using errcode = '23514',
            hint = jsonb_build_object(
              'code',               'inactive_product',
              'product_catalog_id', p_product_catalog_id,
              'attempted_reason',   p_reason
            )::text;
  end if;

  if p_reason in ('loss','theft','damaged','waybill') then
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
;

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

  -- Request lock precedes the lookup, including retries on two devices.
  perform pg_advisory_xact_lock(hashtextextended('stock-request:' || p_client_uuid, 0));
  -- One product lock also covers both sides of a transfer; different products
  -- remain independent. The ledger trigger coordinates non-RPC stock writes.
  perform public._lock_stock_product(p_product_catalog_id);

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
  -- The product must EXIST. Whether it must be ACTIVE depends on direction.
  if not exists (select 1 from public.product_catalog where id = p_product_catalog_id) then
    raise exception 'product not found' using errcode = '23514';
  end if;
  -- A deactivated product legitimately sits in the warehouse when a vendor has
  -- not collected their goods yet, and an agent can be left holding units when
  -- a product is retired mid-round. Draining that stock has to stay possible --
  -- agent -> warehouse to return it, agent -> agent to consolidate before a
  -- return -- otherwise deactivation strands the units with no legal move, and
  -- deactivate_user cannot offboard the rider at all (its 'warehouse' and
  -- 'transfer:<uuid>' dispositions both land here).
  -- Only warehouse_issue stays closed: putting a retired product back into a
  -- rider's bag to sell is the exact thing deactivation exists to prevent.
  if p_reason = 'warehouse_issue'
     and not exists (select 1 from public.product_catalog
                      where id = p_product_catalog_id and is_active = true) then
    raise exception 'product is inactive - cannot issue a deactivated product to an agent'
      using errcode = '23514',
            hint = jsonb_build_object(
              'code',               'inactive_product',
              'product_catalog_id', p_product_catalog_id,
              'attempted_reason',   p_reason
            )::text;
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
;

commit;

