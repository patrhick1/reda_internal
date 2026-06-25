-- ============================================================================
-- list_stock_movements_global — company-wide stock-movement feed (admin/dispatcher).
--
-- Reads the stock_adjustments ledger (deliveries ride it as reason='delivered'
-- rows). Paired legs (warehouse_issue / warehouse_return / transfer) are
-- collapsed to the SOURCE (negative) leg so a movement shows once as
-- "<holder> → <counterparty>". Keyset pagination on (created_at, id).
--
-- This file is the CORRECTED, regenerated definition (the previous committed
-- copy was stale — pre-delivery-ledger two-branch structure). 2026-06-25 changes:
--   1. Holder filter is now BIDIRECTIONAL — matches the holder whether it is the
--      source (sa.agent_id) OR the recipient (cp.agent_id, the paired leg). The
--      old `sa.agent_id = p_holder_id` silently hid stock issued/transferred TO a
--      holder (the recipient leg is collapsed away).
--   2. p_direction ('in' | 'out' | null) refines a holder filter: 'out' = stock
--      that left the holder; 'in' = stock that reached the holder (its own +
--      legs plus inbound paired legs). null = both.
--   3. p_from / p_to (Lagos-day date bounds) for date-range filtering.
-- New params are appended with NULL defaults, so unset behaviour is unchanged.
-- Signature changed → DROP + CREATE, then re-grant.
-- ============================================================================

drop function if exists public.list_stock_movements_global(uuid, uuid, uuid, text[], timestamptz, uuid, integer);

create function public.list_stock_movements_global(
  p_client_id           uuid        default null,
  p_product_catalog_id  uuid        default null,
  p_holder_id           uuid        default null,
  p_kinds               text[]      default null,
  p_before_at           timestamptz default null,
  p_before_event_id     uuid        default null,
  p_limit               integer     default 50,
  p_from                date        default null,
  p_to                  date        default null,
  p_direction           text        default null
)
returns table(
  source text, event_id uuid, event_at timestamptz, event_kind text,
  product_catalog_id uuid, product_name text, quantity_delta integer,
  quantity_ordered integer, notes text, actor_id uuid, actor_name text,
  counterparty_holder_id uuid, counterparty_holder_name text,
  related_adjustment_id uuid, delivery_id uuid, customer_name text,
  holder_id uuid, holder_name text, client_id uuid, client_name text
)
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
begin
  if not coalesce(public.is_admin_or_dispatcher(), false) then
    raise exception 'not authorised to view company-wide stock history' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;
  if p_direction is not null and p_direction not in ('in', 'out') then
    raise exception 'direction must be in, out, or null' using errcode = '22023';
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
    -- Bidirectional holder filter (+ optional direction). The holder may be the
    -- source (sa.agent_id) or the recipient of a collapsed paired leg (cp.agent_id).
    and (
      p_holder_id is null
      or (p_direction is null and (sa.agent_id = p_holder_id or cp.agent_id = p_holder_id))
      or (p_direction = 'out' and sa.agent_id = p_holder_id and sa.quantity_delta < 0)
      or (p_direction = 'in'  and ((sa.agent_id = p_holder_id and sa.quantity_delta > 0) or cp.agent_id = p_holder_id))
    )
    and (p_kinds is null or sa.reason = any(p_kinds))
    -- Lagos-day date bounds (range on the indexed created_at).
    and (p_from is null or sa.created_at >= (p_from::text || ' 00:00')::timestamp at time zone 'Africa/Lagos')
    and (p_to   is null or sa.created_at <  ((p_to + 1)::text || ' 00:00')::timestamp at time zone 'Africa/Lagos')
    and (p_before_at is null or (sa.created_at, sa.id) < (p_before_at, p_before_event_id))
  order by sa.created_at desc, sa.id desc
  limit p_limit;
end;
$function$;

revoke all on function public.list_stock_movements_global(uuid, uuid, uuid, text[], timestamptz, uuid, integer, date, date, text) from public;
grant execute on function public.list_stock_movements_global(uuid, uuid, uuid, text[], timestamptz, uuid, integer, date, date, text) to authenticated;
