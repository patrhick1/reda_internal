-- release_postponed_due as live on the box, captured 2026-09-09 after the replacement-status change
-- (supabase/migrations/20260909170000_replacement_normal_status.sql). The tracked copy had drifted
-- across earlier migrations; this is the real one.

CREATE OR REPLACE FUNCTION public.release_postponed_due(p_due_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_system_id uuid;
  v_row record;
  v_duplicate record;
  v_count integer := 0;
  v_cancelled integer := 0;
  v_deduped integer := 0;
  v_previous_eod_setting text := coalesce(current_setting('reda.in_eod_rollover', true), '');
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'releasing postponed orders requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  select id into v_system_id
    from public.users
   where lower(email) = 'system@reda.local'
   limit 1;
  if v_system_id is null then
    raise exception 'Reda System user not found; postponed release cannot be audited';
  end if;
  v_actor := coalesce(v_actor, v_system_id);

  -- Suppress the terminal sibling cascade while this function deliberately
  -- selects one canonical row and closes only the ranked surplus copies.
  perform set_config('reda.in_eod_rollover', 'true', true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('release_postponed_due:' || p_due_date::text, 0)
  );

  -- Defensive backstop. Immediate consolidation handles new postponements,
  -- while this pass repairs pre-existing rows and any legacy/race edge case
  -- before users see them in the unassigned pool.
  for v_duplicate in
    with eligible as (
      select d.id, d.client_id, d.customer_phone_normalized,
             coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,
             d.scheduled_date, d.text_fingerprint,
             public._norm_address(d.raw_address) as norm_addr,
             d.assigned_agent_id, d.created_at, d.updated_at
        from public.deliveries d
       where d.order_type = 'delivery' and d.current_status = 'postponed'
         and d.scheduled_date <= p_due_date
         and d.deleted_at is null
         and d.order_type = 'delivery'
         and d.customer_phone_normalized is not null
    ),
    clustered as (
      select e.*,
             (
               select min(e2.id::text)
                 from eligible e2
                where e2.client_id = e.client_id
                  and e2.customer_phone_normalized = e.customer_phone_normalized
                  and e2.item_key = e.item_key
                  and e2.scheduled_date = e.scheduled_date
                  and (
                    e2.id = e.id
                    or (e2.text_fingerprint is not null
                        and e2.text_fingerprint = e.text_fingerprint)
                    or (e2.norm_addr is not null and e2.norm_addr = e.norm_addr)
                  )
             ) as sibling_cluster
        from eligible e
    ),
    ranked as (
      select c.*,
             row_number() over (
               partition by c.client_id, c.customer_phone_normalized,
                            c.item_key, c.scheduled_date, c.sibling_cluster
               order by c.updated_at desc, c.created_at asc, c.id asc
             ) as duplicate_rank,
             first_value(c.id) over (
               partition by c.client_id, c.customer_phone_normalized,
                            c.item_key, c.scheduled_date, c.sibling_cluster
               order by c.updated_at desc, c.created_at asc, c.id asc
             ) as canonical_delivery_id
        from clustered c
    )
    select *
      from ranked
     where duplicate_rank > 1
     order by scheduled_date, sibling_cluster, duplicate_rank
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      concat_ws('|',
        v_duplicate.client_id::text,
        v_duplicate.customer_phone_normalized,
        v_duplicate.item_key,
        v_duplicate.scheduled_date::text
      ), 0
    ));

    -- Recheck under a row lock: an immediate-consolidation trigger may have
    -- closed this copy while the release job was waiting.
    perform 1
      from public.deliveries
     where id = v_duplicate.id
       and current_status = 'postponed'
     for update;
    if not found then
      continue;
    end if;

    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id,
       client_uuid, reason, effective_at)
    values
      (v_duplicate.id, 'postponed', 'cancelled', v_system_id,
       'postpone-release-dedup:' || v_duplicate.canonical_delivery_id::text
         || ':' || v_duplicate.id::text,
       'Duplicate postponed copy consolidated into order '
         || v_duplicate.canonical_delivery_id::text || ' before release.',
       now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status     = 'cancelled',
           assigned_agent_id = null,
           updated_at         = now()
     where id = v_duplicate.id
       and current_status = 'postponed';

    if found then
      perform public.write_audit(
        p_entity_type := 'delivery',
        p_entity_id   := v_duplicate.id,
        p_old         := jsonb_build_object(
          'current_status', 'postponed',
          'assigned_agent_id', v_duplicate.assigned_agent_id,
          'scheduled_date', v_duplicate.scheduled_date
        ),
        p_new         := jsonb_build_object(
          'current_status', 'cancelled',
          'assigned_agent_id', null,
          'scheduled_date', v_duplicate.scheduled_date,
          'canonical_delivery_id', v_duplicate.canonical_delivery_id
        ),
        p_reason      := 'postponed_release_duplicate_consolidated',
        p_actor_id    := v_system_id
      );
      v_deduped := v_deduped + 1;
    end if;
  end loop;

  -- Existing release/auto-cancel behavior, now operating only on canonical
  -- rows after the defensive deduplication pass.
  for v_row in
    select d.id, d.current_status, d.scheduled_date, d.assigned_agent_id,
           cl.auto_cancel_soft_fails
      from public.deliveries d
      join public.clients cl on cl.id = d.client_id
     where d.order_type = 'delivery' and d.current_status = 'postponed'
       and d.scheduled_date <= p_due_date
       and d.deleted_at is null
     for update of d
  loop
    if v_row.auto_cancel_soft_fails then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-autocancel-postponed:' || v_row.scheduled_date::text
          || ':' || v_row.id::text,
        p_delivery_id => v_row.id,
        p_to_status   => 'failed_delivery',
        p_reason      => 'eod_auto_cancel:client_policy'
      );

      update public.deliveries
         set assigned_agent_id = null,
             updated_at = now()
       where id = v_row.id;

      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id,
       client_uuid, reason, effective_at)
    values
      (v_row.id, v_row.current_status, 'pending', v_actor,
       'eod-release-postponed:' || v_row.scheduled_date::text || ':' || v_row.id::text,
       'postponed order came due — released to the unassigned pool for fresh assignment',
       now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status      = 'pending',
           assigned_agent_id  = null,
           rolled_from_status = 'postponed',
           rolled_from_date   = v_row.scheduled_date,
           updated_at         = now()
     where id = v_row.id;

    perform public.write_audit(
      p_entity_type := 'delivery',
      p_entity_id   := v_row.id,
      p_old         := jsonb_build_object(
        'current_status', 'postponed',
        'assigned_agent_id', v_row.assigned_agent_id,
        'scheduled_date', v_row.scheduled_date
      ),
      p_new         := jsonb_build_object(
        'current_status', 'pending',
        'assigned_agent_id', null,
        'scheduled_date', v_row.scheduled_date,
        'rolled_from_status', 'postponed'
      ),
      p_reason      := 'eod_release_postponed',
      p_actor_id    := v_actor
    );

    v_count := v_count + 1;
  end loop;

  if v_deduped > 0 then
    raise notice 'eod: consolidated % duplicate postponed copy/copies before release',
      v_deduped;
  end if;
  if v_count > 0 then
    raise notice 'eod: released % postponed order(s) due on/before % into the unassigned pool',
      v_count, p_due_date;
  end if;
  if v_cancelled > 0 then
    raise notice 'eod: auto-cancelled % postponed order(s) due on/before % per client policy',
      v_cancelled, p_due_date;
  end if;

  -- A direct RPC call may share a wider transaction. Restore the caller's
  -- setting so unrelated status changes later in that transaction are not
  -- accidentally exempted from sibling coordination.
  perform set_config('reda.in_eod_rollover', v_previous_eod_setting, true);

  return v_count;
end
$function$

