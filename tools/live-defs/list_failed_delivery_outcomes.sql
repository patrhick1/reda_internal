-- Operational failed-delivery queue for the shared ops Deliveries screen.
--
-- A raw `current_status = 'failed_delivery'` filter is not a trustworthy
-- business metric: the EOD client-policy job also writes that status for orders
-- that were never attempted. This RPC deliberately returns two explicit kinds:
--
--   attempted   the logical/sibling order reached Available, did not have a
--               successful sibling, and ended in a genuine unsuccessful state;
--   auto_closed an EOD client-policy closure, retained for audit but kept out of
--               the attempted count.
--
-- One row is returned per sibling group. The date range applies to the terminal
-- status event in Lagos time, not scheduled_date, so "Today" means "failed
-- today" even when an older order was worked today.

begin;

create index if not exists delivery_status_history_failed_outcome_idx
  on public.delivery_status_history (to_status, changed_at desc, delivery_id)
  where to_status in ('failed_delivery', 'cancelled', 'not_around', 'unserious', 'abandoned');

drop function if exists public.list_failed_delivery_outcomes(date, date, uuid, uuid, text, integer);
drop function if exists public.list_failed_delivery_outcomes(date, date, text, uuid, uuid, text, integer);

create function public.list_failed_delivery_outcomes(
  p_from date,
  p_to date,
  p_kind text default 'attempted',
  p_agent_id uuid default null,
  p_client_id uuid default null,
  p_search text default null,
  p_limit integer default 500
)
returns table(
  id uuid,
  client_id uuid,
  product_catalog_id uuid,
  location_id uuid,
  assigned_agent_id uuid,
  parent_delivery_id uuid,
  customer_name text,
  customer_phone text,
  raw_address text,
  quantity_ordered integer,
  customer_price numeric,
  agent_payment_snapshot numeric,
  current_status text,
  created_via text,
  created_by_user_id uuid,
  created_date date,
  scheduled_date date,
  created_at timestamptz,
  updated_at timestamptz,
  latest_history_id uuid,
  latest_changed_at timestamptz,
  latest_notified boolean,
  rolled_from_status text,
  rolled_from_date date,
  rollover_count integer,
  order_type text,
  product_label text,
  sibling_group_key text,
  activity_at timestamptz,
  client_name text,
  client_auto_cancel_soft_fails boolean,
  product_name text,
  location_name text,
  assigned_agent_name text,
  margin numeric,
  delivery_instructions text,
  assigned_at timestamptz,
  latest_message_at timestamptz,
  failure_kind text,
  failure_status text,
  failure_reason text,
  failed_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'failed-delivery outcomes require an operations role' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid failed-delivery date range' using errcode = '22007';
  end if;
  if p_to - p_from > 92 then
    raise exception 'failed-delivery date range cannot exceed 93 days' using errcode = '22003';
  end if;
  if p_kind not in ('attempted', 'auto_closed') then
    raise exception 'invalid failed-delivery outcome kind' using errcode = '22023';
  end if;

  return query
  with latest_terminal as (
    select distinct on (h.delivery_id)
      h.id as history_id,
      h.delivery_id,
      h.to_status,
      h.reason,
      h.notes,
      h.changed_at
    from public.delivery_status_history h
    join public.deliveries d on d.id = h.delivery_id
    where h.to_status in ('failed_delivery', 'cancelled', 'not_around', 'unserious', 'abandoned')
      and h.to_status = d.current_status
      and h.changed_at >= (p_from::timestamp at time zone 'Africa/Lagos')
      and h.changed_at < ((p_to + 1)::timestamp at time zone 'Africa/Lagos')
    order by h.delivery_id, h.changed_at desc, h.id desc
  ),
  candidates as (
    select
      d.*,
      case
        when public._norm_phone(d.customer_phone) is null
          or d.scheduled_date is null
          or d.items_fingerprint is null
          then 'solo:' || d.id::text
        else md5(
          public._norm_phone(d.customer_phone) || '|' ||
          d.items_fingerprint || '|' ||
          d.scheduled_date::text || '|' ||
          trim(both from regexp_replace(
            regexp_replace(lower(coalesce(d.raw_address, '')), '[^a-z0-9 ]+', ' ', 'g'),
            '\s+', ' ', 'g'
          ))
        )
      end as sibling_group_key,
      lt.history_id,
      lt.to_status as failure_status,
      lt.reason as stored_reason,
      lt.notes as stored_notes,
      lt.changed_at as failed_at,
      (
        (
          lt.to_status = 'failed_delivery'
          and (
            coalesce(lt.reason, '') like 'eod_auto_cancel:%'
            or lower(coalesce(lt.reason, '')) like 'postponed order came due%auto-cancelled%client policy%'
          )
        )
        or (
          lt.to_status = 'unserious'
          and (
            coalesce(lt.reason, '') like 'eod_disinterest_close:%'
            or lower(coalesce(lt.reason, '')) like 'carry-cap reached%'
          )
        )
      ) as is_auto_closed,
      (
        coalesce(lt.reason, '') = 'race lost, deduped on rollover'
        or lower(coalesce(lt.reason, '')) like 'duplicate not completed,%deduped on rollover'
        or lower(coalesce(lt.reason, '')) like '%handled the same order (%). closed as duplicate.%'
        or lower(coalesce(lt.reason, '')) like 'another agent already handled this order (%). closed as duplicate.%'
      ) as is_duplicate_closed
    from latest_terminal lt
    join public.deliveries d on d.id = lt.delivery_id
    where d.deleted_at is null
      and d.order_type = 'delivery'
      and (p_agent_id is null or d.assigned_agent_id = p_agent_id)
      and (p_client_id is null or d.client_id = p_client_id)
      and (
        v_search is null
        or d.customer_name ilike '%' || v_search || '%'
        or (
          length(regexp_replace(v_search, '\D', '', 'g')) >= 3
          and d.customer_phone ilike '%' || regexp_replace(v_search, '\D', '', 'g') || '%'
        )
      )
  ),
  candidate_groups as (
    select distinct c.sibling_group_key from candidates c
  ),
  group_state as (
    select
      member.sibling_group_key,
      bool_or(
        member.current_status = 'delivered'
        or exists (
          select 1
          from public.delivery_status_history available_history
          where available_history.delivery_id = member.id
            and available_history.to_status in ('available', 'available_evening')
        )
      ) as reached_available,
      bool_or(member.current_status = 'delivered') as was_delivered
    from (
      select
        d.id,
        d.current_status,
        case
          when public._norm_phone(d.customer_phone) is null
            or d.scheduled_date is null
            or d.items_fingerprint is null
            then 'solo:' || d.id::text
          else md5(
            public._norm_phone(d.customer_phone) || '|' ||
            d.items_fingerprint || '|' ||
            d.scheduled_date::text || '|' ||
            trim(both from regexp_replace(
              regexp_replace(lower(coalesce(d.raw_address, '')), '[^a-z0-9 ]+', ' ', 'g'),
              '\s+', ' ', 'g'
            ))
          )
        end as sibling_group_key
      from public.deliveries d
      where d.deleted_at is null
        and d.order_type = 'delivery'
    ) member
    join candidate_groups cg on cg.sibling_group_key = member.sibling_group_key
    group by member.sibling_group_key
  ),
  classified as (
    select
      c.*,
      case when c.is_auto_closed then 'auto_closed' else 'attempted' end as failure_kind,
      row_number() over (
        partition by c.sibling_group_key, c.is_auto_closed
        order by c.failed_at desc, c.id
      ) as group_rank
    from candidates c
    join group_state gs on gs.sibling_group_key = c.sibling_group_key
    where not c.is_duplicate_closed
      and not gs.was_delivered
      and (c.is_auto_closed or gs.reached_available)
  )
  select
    c.id,
    c.client_id,
    c.product_catalog_id,
    c.location_id,
    c.assigned_agent_id,
    c.parent_delivery_id,
    c.customer_name,
    c.customer_phone,
    c.raw_address,
    c.quantity_ordered,
    c.customer_price,
    null::numeric as agent_payment_snapshot,
    c.current_status,
    c.created_via,
    c.created_by_user_id,
    c.created_date,
    c.scheduled_date,
    c.created_at,
    c.updated_at,
    c.history_id as latest_history_id,
    c.failed_at as latest_changed_at,
    exists (
      select 1
      from public.delivery_client_notifications n
      where n.status_history_id = c.history_id
    ) as latest_notified,
    c.rolled_from_status,
    c.rolled_from_date,
    c.rollover_count,
    c.order_type,
    case
      when coalesce(items.item_count, 0) > 1 then items.item_count::text || ' items'
      when items.item_count = 1 then coalesce(items.first_item_name, 'Product')
      else coalesce(legacy_product.product_name, '—')
    end as product_label,
    c.sibling_group_key,
    c.failed_at as activity_at,
    client.name as client_name,
    client.auto_cancel_soft_fails as client_auto_cancel_soft_fails,
    null::text as product_name,
    location.name as location_name,
    agent.display_name as assigned_agent_name,
    null::numeric as margin,
    c.delivery_instructions,
    c.assigned_at,
    null::timestamptz as latest_message_at,
    c.failure_kind,
    c.failure_status,
    case
      when c.failure_kind = 'auto_closed' and c.failure_status = 'failed_delivery'
        then 'Auto-closed by client policy'
      when c.failure_kind = 'auto_closed' and lower(coalesce(c.stored_reason, '')) like 'carry-cap reached%'
        then 'Auto-closed after the maximum carry-over attempts'
      when c.failure_kind = 'auto_closed' and coalesce(c.stored_reason, '') like 'eod_disinterest_close:%'
        then 'Auto-closed after repeated customer disinterest'
      when c.failure_kind = 'auto_closed' then 'Automatically closed by end-of-day policy'
      when nullif(trim(c.stored_notes), '') is not null then trim(c.stored_notes)
      when nullif(trim(c.stored_reason), '') is not null
        and c.stored_reason not in ('cant_reach_client', 'wrong_address', 'payment_dispute', 'product_issue', 'other')
        then trim(c.stored_reason)
      when c.failure_status = 'cancelled' then 'Customer cancelled the order'
      when c.failure_status = 'not_around' then 'Customer was not around'
      when c.failure_status = 'unserious' then 'Customer was not ready to complete the order'
      when c.failure_status = 'abandoned' then 'Delivery attempt was abandoned'
      else 'Delivery could not be completed'
    end as failure_reason,
    c.failed_at
  from classified c
  join public.clients client on client.id = c.client_id
  left join public.locations location on location.id = c.location_id
  left join public.users agent on agent.id = c.assigned_agent_id
  left join public.product_catalog legacy_product on legacy_product.id = c.product_catalog_id
  left join lateral (
    select
      count(*)::integer as item_count,
      (array_agg(pc.product_name order by di.created_at))[1] as first_item_name
    from public.delivery_items di
    left join public.product_catalog pc on pc.id = di.product_catalog_id
    where di.delivery_id = c.id
  ) items on true
  where c.group_rank = 1
    and c.failure_kind = p_kind
  order by c.failed_at desc, c.id
  limit v_limit;
end;
$function$;

comment on function public.list_failed_delivery_outcomes(date, date, text, uuid, uuid, text, integer) is
  'One ops-visible row per failed logical order. Attempted requires prior Available and no delivered sibling; auto_closed contains only known EOD client-policy closures. Range is failure-event date in Africa/Lagos.';

revoke all on function public.list_failed_delivery_outcomes(date, date, text, uuid, uuid, text, integer) from public, anon;
grant execute on function public.list_failed_delivery_outcomes(date, date, text, uuid, uuid, text, integer) to authenticated;

commit;
