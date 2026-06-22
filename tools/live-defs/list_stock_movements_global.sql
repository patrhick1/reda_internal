-- Cross-holder stock-movement feed (Phase 1) powering two oversight views:
--   * client view   = call with p_client_id set
--   * company view  = call with any subset of {product, client, holder, kind}
-- Additive: leaves the per-holder list_stock_movements untouched.
--
-- Mirrors list_stock_movements' two-branch shape, with three differences:
--   1. NOT holder-scoped — adds holder_id/holder_name (+ client_id/client_name)
--      to every row, since there is no single "viewer" holder.
--   2. Paired transfer legs are de-duplicated to the source (negative) leg, so a
--      transfer shows once as "From <holder> -> <counterparty>". Verified safe:
--      warehouse_issue/return have exactly matched +/- counts, no 0-delta legs.
--   3. Vendor is derived from product_catalog.client_id (adj) / deliveries.client_id
--      (del). stock_adjustments.client_uuid is the per-row idempotency key, NOT a
--      vendor FK.
--
-- Efficiency: keyset + filters + ORDER BY + LIMIT are pushed INTO each branch so a
-- company-wide page materialises only ~2*p_limit rows. The `del` branch (history ->
-- deliveries -> items + LATERAL top-1) is the heavier half; PHASE 2's immutable
-- delivery ledger replaces this branch and removes that cost.
--
-- Auth: ops only (admin/dispatcher/rep via is_admin_or_dispatcher()). Agents and
-- warehouse keep the per-holder screen and are denied here.
--
-- Keyset note: event_id is a stock_adjustments.id in the adj branch and a
-- delivery_items.id in the del branch. The cross-branch tiebreak therefore only
-- matters when an adjustment and a delivery share the EXACT same event_at (to the
-- microsecond) — effectively never. Same trade-off as the per-holder
-- list_stock_movements; documented rather than engineered around.

-- Indexes (run CONCURRENTLY, outside a transaction):
create index concurrently if not exists idx_stock_adj_created_at_id
  on public.stock_adjustments (created_at desc, id desc);
create index concurrently if not exists idx_stock_adj_product_created
  on public.stock_adjustments (product_catalog_id, created_at desc, id desc);

create or replace function public.list_stock_movements_global(
  p_client_id          uuid        default null,
  p_product_catalog_id uuid        default null,
  p_holder_id          uuid        default null,
  p_kinds              text[]      default null,
  p_before_at          timestamptz default null,
  p_before_event_id    uuid        default null,
  p_limit              integer     default 50
)
returns table(
  source                   text,
  event_id                 uuid,
  event_at                 timestamptz,
  event_kind               text,
  product_catalog_id       uuid,
  product_name             text,
  quantity_delta           integer,
  quantity_ordered         integer,
  notes                    text,
  actor_id                 uuid,
  actor_name               text,
  counterparty_holder_id   uuid,
  counterparty_holder_name text,
  related_adjustment_id    uuid,
  delivery_id              uuid,
  customer_name            text,
  holder_id                uuid,
  holder_name              text,
  client_id                uuid,
  client_name              text
)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $function$
declare
  -- Skip a whole branch when the kind filter excludes it.
  v_want_adj boolean := (p_kinds is null
                         or exists (select 1 from unnest(p_kinds) k where k <> 'delivered'));
  v_want_del boolean := (p_kinds is null or 'delivered' = any(p_kinds));
begin
  if not coalesce(public.is_admin_or_dispatcher(), false) then
    raise exception 'not authorised to view company-wide stock history'
      using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  with adj as (
    select
      'adjustment'::text                       as source,
      sa.id                                    as event_id,
      sa.created_at                            as event_at,
      sa.reason                                as event_kind,
      sa.product_catalog_id                    as product_catalog_id,
      p.product_name                           as product_name,
      sa.quantity_delta                        as quantity_delta,
      null::int                                as quantity_ordered,
      sa.notes                                 as notes,
      sa.created_by_user_id                    as actor_id,
      au.display_name                          as actor_name,
      cp.agent_id                              as counterparty_holder_id,
      cu.display_name                          as counterparty_holder_name,
      sa.related_adjustment_id                 as related_adjustment_id,
      null::uuid                               as delivery_id,
      null::text                               as customer_name,
      sa.agent_id                              as holder_id,
      hu.display_name                          as holder_name,
      p.client_id                              as client_id,
      c.name                                   as client_name
    from public.stock_adjustments sa
    join public.product_catalog   p  on p.id = sa.product_catalog_id
    join public.clients           c  on c.id = p.client_id
    left join public.users        hu on hu.id = sa.agent_id
    left join public.users        au on au.id = sa.created_by_user_id
    left join public.stock_adjustments cp on cp.id = sa.related_adjustment_id
    left join public.users        cu on cu.id = cp.agent_id
    where v_want_adj
      -- collapse paired transfers to the source (negative) leg
      and not (sa.reason in ('warehouse_issue','warehouse_return','transfer')
               and sa.quantity_delta > 0)
      and (p_client_id          is null or p.client_id          = p_client_id)
      and (p_product_catalog_id is null or sa.product_catalog_id = p_product_catalog_id)
      and (p_holder_id          is null or sa.agent_id           = p_holder_id)
      and (p_kinds              is null or sa.reason = any(p_kinds))
      and (p_before_at          is null
           or (sa.created_at, sa.id) < (p_before_at, p_before_event_id))
    order by sa.created_at desc, sa.id desc
    limit p_limit
  ),
  del as (
    -- one movement per delivered LINE ITEM (mirrors list_stock_movements).
    select
      'delivery'::text                          as source,
      di.id                                     as event_id,
      dh.changed_at                             as event_at,
      'delivered'::text                         as event_kind,
      di.product_catalog_id                     as product_catalog_id,
      p.product_name                            as product_name,
      -coalesce(di.quantity_delivered, 0)::int  as quantity_delta,
      di.quantity_ordered                       as quantity_ordered,
      null::text                                as notes,
      coalesce(dh.changed_by_user_id, d.assigned_agent_id) as actor_id,
      au.display_name                           as actor_name,
      null::uuid                                as counterparty_holder_id,
      null::text                                as counterparty_holder_name,
      null::uuid                                as related_adjustment_id,
      d.id                                      as delivery_id,
      d.customer_name                           as customer_name,
      d.assigned_agent_id                       as holder_id,
      hu.display_name                           as holder_name,
      d.client_id                               as client_id,
      c.name                                    as client_name
    from public.deliveries d
    join public.delivery_items di on di.delivery_id = d.id
    join public.product_catalog p on p.id = di.product_catalog_id
    join public.clients         c on c.id = d.client_id
    left join public.users      hu on hu.id = d.assigned_agent_id
    join lateral (
      select dsh.changed_at, dsh.changed_by_user_id
        from public.delivery_status_history dsh
       where dsh.delivery_id = d.id
         and dsh.to_status   = 'delivered'
       order by dsh.changed_at desc
       limit 1
    ) dh on true
    left join public.users au on au.id = coalesce(dh.changed_by_user_id, d.assigned_agent_id)
    where v_want_del
      and d.current_status = 'delivered'
      and d.deleted_at     is null
      and (p_client_id          is null or d.client_id           = p_client_id)
      and (p_product_catalog_id is null or di.product_catalog_id = p_product_catalog_id)
      and (p_holder_id          is null or d.assigned_agent_id   = p_holder_id)
      and (p_before_at          is null
           or (dh.changed_at, di.id) < (p_before_at, p_before_event_id))
    order by dh.changed_at desc, di.id desc
    limit p_limit
  )
  select
    m.source, m.event_id, m.event_at, m.event_kind, m.product_catalog_id, m.product_name,
    m.quantity_delta, m.quantity_ordered, m.notes, m.actor_id, m.actor_name,
    m.counterparty_holder_id, m.counterparty_holder_name, m.related_adjustment_id,
    m.delivery_id, m.customer_name, m.holder_id, m.holder_name, m.client_id, m.client_name
  from (
    select * from adj
    union all
    select * from del
  ) m
  order by m.event_at desc nulls last, m.event_id desc
  limit p_limit;
end;
$function$;

revoke all on function public.list_stock_movements_global(uuid,uuid,uuid,text[],timestamptz,uuid,integer) from public;
grant execute on function public.list_stock_movements_global(uuid,uuid,uuid,text[],timestamptz,uuid,integer) to authenticated;
