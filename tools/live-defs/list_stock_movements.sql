CREATE OR REPLACE FUNCTION public.list_stock_movements(p_holder_id uuid, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_event_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_actor_id uuid DEFAULT NULL::uuid, p_kinds text[] DEFAULT NULL::text[], p_counterparty_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(source text, event_id uuid, event_at timestamp with time zone, event_kind text, product_catalog_id uuid, product_name text, quantity_delta integer, quantity_ordered integer, notes text, actor_id uuid, actor_name text, counterparty_holder_id uuid, counterparty_holder_name text, related_adjustment_id uuid, delivery_id uuid, customer_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  -- coalesce each branch to a non-null boolean. `p_holder_id = <nullable
  -- subquery>` yields NULL for callers with no warehouse_id (i.e. agents),
  -- and NULL inside `if not (...)` skips the raise entirely. coalesce
  -- guards against that.
  if not (
       coalesce(public.is_admin_or_dispatcher(), false)
    or coalesce(p_holder_id = auth.uid(), false)
    or coalesce(p_holder_id = (select u.warehouse_id from public.users u where u.id = auth.uid()), false)
  ) then
    raise exception 'not authorised to view this holder''s stock history'
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
      sa.product_catalog_id,
      p.product_name,
      sa.quantity_delta,
      null::int                                as quantity_ordered,
      sa.notes,
      sa.created_by_user_id                    as actor_id,
      au.display_name                          as actor_name,
      cp.agent_id                              as counterparty_holder_id,
      cu.display_name                          as counterparty_holder_name,
      sa.related_adjustment_id,
      null::uuid                               as delivery_id,
      null::text                               as customer_name
    from public.stock_adjustments sa
    join public.product_catalog   p  on p.id = sa.product_catalog_id
    left join public.users        au on au.id = sa.created_by_user_id
    left join public.stock_adjustments cp on cp.id = sa.related_adjustment_id
    left join public.users        cu on cu.id = cp.agent_id
    where sa.agent_id = p_holder_id
  ),
  del as (
    select
      'delivery'::text                         as source,
      d.id                                     as event_id,
      dh.changed_at                            as event_at,
      'delivered'::text                        as event_kind,
      d.product_catalog_id,
      p.product_name,
      -coalesce(d.quantity_delivered, 0)::int  as quantity_delta,
      d.quantity_ordered,
      null::text                               as notes,
      coalesce(dh.changed_by_user_id, d.assigned_agent_id) as actor_id,
      au.display_name                          as actor_name,
      null::uuid                               as counterparty_holder_id,
      null::text                               as counterparty_holder_name,
      null::uuid                               as related_adjustment_id,
      d.id                                     as delivery_id,
      d.customer_name
    from public.deliveries d
    join public.product_catalog p on p.id = d.product_catalog_id
    join lateral (
      select dsh.changed_at, dsh.changed_by_user_id
        from public.delivery_status_history dsh
       where dsh.delivery_id = d.id
         and dsh.to_status   = 'delivered'
       order by dsh.changed_at desc
       limit 1
    ) dh on true
    left join public.users au on au.id = coalesce(dh.changed_by_user_id, d.assigned_agent_id)
    where d.assigned_agent_id = p_holder_id
      and d.current_status    = 'delivered'
      and d.deleted_at        is null
  )
  select
    m.source,
    m.event_id,
    m.event_at,
    m.event_kind,
    m.product_catalog_id,
    m.product_name,
    m.quantity_delta,
    m.quantity_ordered,
    m.notes,
    m.actor_id,
    m.actor_name,
    m.counterparty_holder_id,
    m.counterparty_holder_name,
    m.related_adjustment_id,
    m.delivery_id,
    m.customer_name
  from (
    select * from adj
    union all
    select * from del
  ) m
  where (p_before_at is null
         or (m.event_at, m.event_id) < (p_before_at, p_before_event_id))
    and (p_actor_id        is null or m.actor_id = p_actor_id)
    and (p_kinds           is null or m.event_kind = any(p_kinds))
    and (p_counterparty_id is null or m.counterparty_holder_id = p_counterparty_id)
  order by m.event_at desc nulls last, m.event_id desc
  limit p_limit;
end;
$function$

