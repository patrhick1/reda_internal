CREATE OR REPLACE FUNCTION public.run_eod_rollover(p_for_date date DEFAULT CURRENT_DATE, p_reason text DEFAULT 'eod_rollover'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_system_id constant uuid := '2d8d5895-d2a8-4900-b15e-7662b176a805';
  v_capped_ids_limit constant int := 100;
  v_row record;
  v_count integer := 0;
  v_same_agent_cancels       integer := 0;
  v_cross_agent_cancels      integer := 0;
  v_cap_hits                 integer := 0;
  v_capped_overflow          integer := 0;
  v_policy_cancels           integer := 0;
  v_sibling_resolved_cancels integer := 0;
  v_capped_ids               uuid[]  := array[]::uuid[];
  v_new_child_id             uuid;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'eod rollover requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  -- Suppress the sibling-cascade trigger for the rest of this transaction.
  -- EOD already snapshot-dedups siblings; letting the cascade fire mid-loop
  -- would crash rollover_delivery with "already terminal" on the next row.
  perform set_config('reda.in_eod_rollover', 'true', true);

  for v_row in
    with eligible as (
      select d.id,
             d.client_id,
             d.assigned_agent_id,
             d.current_status,
             d.customer_phone_normalized,
             d.product_catalog_id,
             d.scheduled_date,
             -- sib_key uses address+qty unconditionally. Two typo-drifted
             -- bot forwards (different fingerprints, same physical address)
             -- now share a sib_key and are correctly grouped.
             md5(coalesce(public._norm_address(d.raw_address), '') || '|'
                 || coalesce(d.quantity_ordered::text, '0')) as sib_key,
             d.created_at,
             d.updated_at,
             d.rollover_count,
             sd.sort_order as status_sort,
             resolved.sibling_status as resolved_sibling_status,
             resolved.sibling_label  as resolved_sibling_label,
             (resolved.sibling_status is not null) as has_resolved_sibling
        from public.deliveries d
        join public.delivery_status_defs sd on sd.status = d.current_status
        left join lateral (
          select sib.current_status as sibling_status,
                 sib_def.label      as sibling_label
            from public._find_sibling_deliveries(d.id) sib
            join public.delivery_status_defs sib_def on sib_def.status = sib.current_status
           where sib_def.category = 'terminal'
             -- Match the live Stage-2 cascade exclusion list exactly. A
             -- `cancelled` sibling resolves the order (and SHOULD). But an
             -- `agent_cancelled` sibling (row closed, order still live) or a
             -- `rolled_over` sibling (EOD machinery) is NOT a resolution and
             -- must never cancel the live row. (2026-06-04 fix.)
             and sib.current_status not in ('agent_cancelled', 'rolled_over')
           order by sib.created_at desc, sib.id
           limit 1
        ) as resolved on true
       where d.scheduled_date = p_for_date
         and d.deleted_at is null
         and sd.category <> 'terminal'
         and not exists (
           select 1 from public.deliveries c
            where c.parent_delivery_id = d.id and c.created_via = 'rollover'
         )
    ),
    same_agent_ranked as (
      select e.*,
             row_number() over (
               partition by e.customer_phone_normalized, e.product_catalog_id,
                            e.scheduled_date, e.sib_key,
                            coalesce(e.assigned_agent_id::text, '!unassigned:' || e.id::text)
               order by e.status_sort desc, e.updated_at desc, e.created_at asc, e.id asc
             ) as same_agent_rn
        from eligible e
    ),
    cross_agent_ranked as (
      select s.*,
             count(*) filter (where s.same_agent_rn = 1)
               over (partition by s.customer_phone_normalized, s.product_catalog_id,
                                  s.scheduled_date, s.sib_key) as group_canonical_count,
             max(s.status_sort) filter (where s.same_agent_rn = 1)
               over (partition by s.customer_phone_normalized, s.product_catalog_id,
                                  s.scheduled_date, s.sib_key) as group_max_sort,
             row_number() over (
               partition by s.customer_phone_normalized, s.product_catalog_id,
                            s.scheduled_date, s.sib_key
               order by s.status_sort desc, s.updated_at desc, s.created_at asc, s.id asc
             ) as cross_agent_rn
        from same_agent_ranked s
    )
    select id, client_id, assigned_agent_id, current_status, rollover_count,
           same_agent_rn, cross_agent_rn,
           group_canonical_count, group_max_sort,
           has_resolved_sibling, resolved_sibling_status, resolved_sibling_label
      from cross_agent_ranked
     order by customer_phone_normalized, product_catalog_id, sib_key,
              same_agent_rn, cross_agent_rn
  loop
    if v_row.has_resolved_sibling then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id,
         client_uuid, reason, effective_at)
      values
        (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-sibling-resolved:' || p_for_date::text || ':' || v_row.id::text,
         'Another agent already handled this order ('
           || coalesce(v_row.resolved_sibling_label, v_row.resolved_sibling_status)
           || '). Closed as duplicate.',
         now());
      update public.deliveries
         set current_status = 'cancelled', updated_at = now()
       where id = v_row.id;
      v_sibling_resolved_cancels := v_sibling_resolved_cancels + 1;
      continue;
    end if;

    if v_row.same_agent_rn > 1 then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id,
         client_uuid, reason, effective_at)
      values
        (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-same-agent:' || p_for_date::text || ':' || v_row.id::text,
         'duplicate not completed, same-agent deduped on rollover', now());
      update public.deliveries
         set current_status = 'cancelled', updated_at = now()
       where id = v_row.id;
      v_same_agent_cancels := v_same_agent_cancels + 1;
      continue;
    end if;

    -- Cross-agent dedup: collapse to one canonical per sibling group,
    -- regardless of whether anyone has progressed past pending. Rolled
    -- children land unassigned, so preserving multiple parents through
    -- EOD just creates multiple unassigned phantoms tomorrow.
    if v_row.group_canonical_count > 1 and v_row.cross_agent_rn > 1 then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id,
         client_uuid, reason, effective_at)
      values
        (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-cross-agent:' || p_for_date::text || ':' || v_row.id::text,
         case when v_row.group_max_sort > 1
              then 'race lost, deduped on rollover'
              else 'duplicate not completed, cross-agent deduped on rollover'
         end,
         now());
      update public.deliveries
         set current_status = 'cancelled', updated_at = now()
       where id = v_row.id;
      v_cross_agent_cancels := v_cross_agent_cancels + 1;
      continue;
    end if;

    if v_row.current_status in (
         'not_answering','not_around','not_available',
         'not_connecting','number_busy','switched_off'
       )
       and exists (
         select 1 from public.clients c
          where c.id = v_row.client_id
            and c.auto_cancel_soft_fails
       )
    then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-auto-cancel:' || v_row.id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.id,
        p_to_status   => 'failed_delivery',
        p_reason      => 'eod_auto_cancel:client_policy'
      );
      v_policy_cancels := v_policy_cancels + 1;
      continue;
    end if;

    -- rollover_delivery returns the new child's id, or NULL on cap-trip
    -- (the carry-cap path flips the parent to 'unserious' instead of
    -- minting a child). Use the return value to detect cap-trips without
    -- re-reading the parent's status.
    v_new_child_id := public.rollover_delivery(
      p_client_uuid := 'eod:' || p_for_date::text || ':' || v_row.id::text,
      p_delivery_id := v_row.id,
      p_new_scheduled_date := (p_for_date + interval '1 day')::date,
      p_reason := p_reason,
      p_notify := false
    );

    if v_new_child_id is null then
      v_cap_hits := v_cap_hits + 1;
      if cardinality(v_capped_ids) < v_capped_ids_limit then
        v_capped_ids := array_append(v_capped_ids, v_row.id);
      else
        v_capped_overflow := v_capped_overflow + 1;
      end if;
    else
      v_count := v_count + 1;
    end if;
  end loop;

  perform public._notify_admins_eod_summary(
    p_for_date               := p_for_date,
    p_cap_hit_count          := v_cap_hits,
    p_same_agent_count       := v_same_agent_cancels,
    p_race_lost_count        := v_cross_agent_cancels,  -- includes both race-lost and all-pending collapse
    p_capped_ids             := v_capped_ids,
    p_policy_cancel_count    := v_policy_cancels,
    p_sibling_resolved_count := v_sibling_resolved_cancels
  );

  if v_sibling_resolved_cancels > 0 then
    raise notice 'rollover: % cancelled because a sibling already settled the order', v_sibling_resolved_cancels;
  end if;
  if v_same_agent_cancels > 0 then
    raise notice 'rollover: % same-agent duplicates cancelled', v_same_agent_cancels;
  end if;
  if v_cross_agent_cancels > 0 then
    raise notice 'rollover: % cross-agent duplicates cancelled (race-lost or all-pending collapse)', v_cross_agent_cancels;
  end if;
  if v_cap_hits > 0 then
    raise notice 'rollover: % deliveries hit the carry cap and were marked unserious (% truncated from capped_ids list)',
      v_cap_hits, v_capped_overflow;
  end if;
  if v_policy_cancels > 0 then
    raise notice 'rollover: % deliveries auto-cancelled by client policy (failed_delivery)', v_policy_cancels;
  end if;

  return v_count;
end;
$function$

