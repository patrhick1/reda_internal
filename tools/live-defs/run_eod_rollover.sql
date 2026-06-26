CREATE OR REPLACE FUNCTION public.run_eod_rollover(p_for_date date DEFAULT CURRENT_DATE, p_reason text DEFAULT 'eod_rollover'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
 SET statement_timeout TO '120s'
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
  v_followup_closes          integer := 0;   -- follow_up closed to deferred_to_client
  v_disinterest_closes       integer := 0;   -- not_around/not_available closed to unserious
  v_capped_ids               uuid[]  := array[]::uuid[];
  v_new_child_id             uuid;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'eod rollover requires admin or dispatcher role' using errcode = '42501';
  end if;

  perform set_config('reda.in_eod_rollover', 'true', true);

  for v_row in
    with eligible as (
      select d.id, d.client_id, d.assigned_agent_id, d.current_status,
             d.customer_phone_normalized,
             coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,  -- [Feature A]
             d.scheduled_date,
             d.text_fingerprint,
             public._norm_address(d.raw_address) as norm_addr,
             d.created_at, d.updated_at, d.rollover_count,
             sd.sort_order as status_sort,
             resolved.sibling_status as resolved_sibling_status,
             resolved.sibling_label  as resolved_sibling_label,
             (resolved.sibling_status is not null) as has_resolved_sibling
        from public.deliveries d
        join public.delivery_status_defs sd on sd.status = d.current_status
        left join lateral (
          select sib.current_status as sibling_status, sib_def.label as sibling_label
            from public._find_sibling_deliveries(d.id) sib
            join public.delivery_status_defs sib_def on sib_def.status = sib.current_status
           where sib_def.category = 'terminal'
             and sib.current_status not in ('agent_cancelled', 'rolled_over')
           order by sib.created_at desc, sib.id limit 1
        ) as resolved on true
       where d.scheduled_date = p_for_date
         and d.deleted_at is null
         and d.order_type = 'delivery'   -- waybills/pickups are money-only & terminal; they never roll
         and sd.category <> 'terminal'
         and not exists (
           select 1 from public.deliveries c
            where c.parent_delivery_id = d.id and c.created_via = 'rollover')
    ),
    clustered as (
      -- Sibling clustering for dedup. Two same-customer / same-items / same-day
      -- rows are the SAME order (siblings) if their raw-message text_fingerprint
      -- matches OR their normalized address matches — the exact definition used
      -- by _find_sibling_deliveries. The OLD key used the normalized address
      -- ONLY, which missed true siblings whenever the LLM extracted the address
      -- differently from an identical forward (e.g. "ikorodu" vs "odogunya
      -- ikorodu"), so both rolled forward as duplicates. sib_cluster = the min id
      -- over a row's siblings in the eligible set (self always included via
      -- e2.id = e.id), giving a stable per-cluster grouping key.
      select e.*,
             (select min(e2.id::text)
                from eligible e2
               where e2.customer_phone_normalized = e.customer_phone_normalized
                 and e2.item_key       = e.item_key
                 and e2.scheduled_date = e.scheduled_date
                 and (
                   e2.id = e.id
                   or (e2.text_fingerprint is not null and e2.text_fingerprint = e.text_fingerprint)
                   or (e2.norm_addr       is not null and e2.norm_addr       = e.norm_addr)
                 )
             ) as sib_cluster
        from eligible e
    ),
    same_agent_ranked as (
      select c.*,
             row_number() over (
               partition by c.customer_phone_normalized, c.item_key,
                            c.scheduled_date, c.sib_cluster,
                            coalesce(c.assigned_agent_id::text, '!unassigned:' || c.id::text)
               order by c.status_sort desc, c.updated_at desc, c.created_at asc, c.id asc
             ) as same_agent_rn
        from clustered c
    ),
    cross_agent_ranked as (
      select s.*,
             count(*) filter (where s.same_agent_rn = 1)
               over (partition by s.customer_phone_normalized, s.item_key,
                                  s.scheduled_date, s.sib_cluster) as group_canonical_count,
             max(s.status_sort) filter (where s.same_agent_rn = 1)
               over (partition by s.customer_phone_normalized, s.item_key,
                                  s.scheduled_date, s.sib_cluster) as group_max_sort,
             row_number() over (
               partition by s.customer_phone_normalized, s.item_key,
                            s.scheduled_date, s.sib_cluster
               order by s.status_sort desc, s.updated_at desc, s.created_at asc, s.id asc
             ) as cross_agent_rn
        from same_agent_ranked s
    )
    select id, client_id, assigned_agent_id, current_status, rollover_count,
           same_agent_rn, cross_agent_rn, group_canonical_count, group_max_sort,
           has_resolved_sibling, resolved_sibling_status, resolved_sibling_label
      from cross_agent_ranked
     order by customer_phone_normalized, item_key, sib_cluster, same_agent_rn, cross_agent_rn
  loop
    if v_row.has_resolved_sibling then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-sibling-resolved:' || p_for_date::text || ':' || v_row.id::text,
         'Another agent already handled this order ('
           || coalesce(v_row.resolved_sibling_label, v_row.resolved_sibling_status)
           || '). Closed as duplicate.', now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.id;
      v_sibling_resolved_cancels := v_sibling_resolved_cancels + 1;
      continue;
    end if;

    if v_row.same_agent_rn > 1 then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-same-agent:' || p_for_date::text || ':' || v_row.id::text,
         'duplicate not completed, same-agent deduped on rollover', now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.id;
      v_same_agent_cancels := v_same_agent_cancels + 1;
      continue;
    end if;

    if v_row.group_canonical_count > 1 and v_row.cross_agent_rn > 1 then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-cross-agent:' || p_for_date::text || ':' || v_row.id::text,
         case when v_row.group_max_sort > 1 then 'race lost, deduped on rollover'
              else 'duplicate not completed, cross-agent deduped on rollover' end, now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.id;
      v_cross_agent_cancels := v_cross_agent_cancels + 1;
      continue;
    end if;

    -- not_around / not_available are disinterest signals (customer not interested,
    -- no money, or playing with the order form) — not "try later". Close them to
    -- unserious at EOD for every client instead of rolling. Placed BEFORE the
    -- per-client auto_cancel policy so these always close as unserious (not
    -- failed_delivery), and before rollover so they never carry or count to the cap.
    if v_row.current_status in ('not_around','not_available') then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-disinterest-close:' || v_row.id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.id, p_to_status => 'unserious',
        p_reason => 'eod_disinterest_close:not_interested');
      v_disinterest_closes := v_disinterest_closes + 1;
      continue;
    end if;

    if v_row.current_status in ('not_answering','not_connecting','number_busy','switched_off')
       and exists (select 1 from public.clients c where c.id = v_row.client_id and c.auto_cancel_soft_fails)
    then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-auto-cancel:' || v_row.id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.id, p_to_status => 'failed_delivery',
        p_reason => 'eod_auto_cancel:client_policy');
      v_policy_cancels := v_policy_cancels + 1;
      continue;
    end if;

    -- follow_up is excluded from the rollover. A still-open follow_up at EOD closes
    -- out to deferred_to_client (terminal) instead of rolling, so it neither carries
    -- forward nor counts toward the carry cap. Placed AFTER the dedup/sibling/policy
    -- branches so a duplicate follow_up still cancels as a duplicate first.
    if v_row.current_status = 'follow_up' then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-followup-close:' || v_row.id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.id, p_to_status => 'deferred_to_client',
        p_reason => 'eod_followup_close:excluded_from_rollover');
      v_followup_closes := v_followup_closes + 1;
      continue;
    end if;

    v_new_child_id := public.rollover_delivery(
      p_client_uuid := 'eod:' || p_for_date::text || ':' || v_row.id::text,
      p_delivery_id := v_row.id,
      p_new_scheduled_date := (p_for_date + interval '1 day')::date,
      p_reason := p_reason, p_notify := false);

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
    p_for_date := p_for_date, p_cap_hit_count := v_cap_hits,
    p_same_agent_count := v_same_agent_cancels, p_race_lost_count := v_cross_agent_cancels,
    p_capped_ids := v_capped_ids, p_policy_cancel_count := v_policy_cancels,
    p_sibling_resolved_count := v_sibling_resolved_cancels);

  if v_sibling_resolved_cancels > 0 then raise notice 'rollover: % cancelled because a sibling already settled the order', v_sibling_resolved_cancels; end if;
  if v_same_agent_cancels > 0 then raise notice 'rollover: % same-agent duplicates cancelled', v_same_agent_cancels; end if;
  if v_cross_agent_cancels > 0 then raise notice 'rollover: % cross-agent duplicates cancelled (race-lost or all-pending collapse)', v_cross_agent_cancels; end if;
  if v_cap_hits > 0 then raise notice 'rollover: % deliveries hit the carry cap and were marked unserious (% truncated)', v_cap_hits, v_capped_overflow; end if;
  if v_policy_cancels > 0 then raise notice 'rollover: % deliveries auto-cancelled by client policy (failed_delivery)', v_policy_cancels; end if;
  if v_followup_closes > 0 then raise notice 'rollover: % follow_up deliveries closed out to deferred_to_client (excluded from rollover)', v_followup_closes; end if;
  if v_disinterest_closes > 0 then raise notice 'rollover: % not_around/not_available deliveries closed to unserious (disinterest, excluded from rollover)', v_disinterest_closes; end if;

  return v_count;
end;
$function$
