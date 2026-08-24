-- Consolidate multi-agent sibling deliveries that converge on one postponed date.
--
-- Keeps Reda's intentional multi-agent race behavior while the order is active.
-- Once two copies are both postponed to the same date, the latest postponement
-- becomes canonical and the older copy is closed as a non-financial duplicate.
-- release_postponed_due repeats the same grouping defensively before making due
-- postponed orders visible in the unassigned pool.

begin;

create or replace function public.tg_handle_sibling_coordination()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_system_id constant uuid := '2d8d5895-d2a8-4900-b15e-7662b176a805';
  v_sibling record;
  v_agent_first text;
  v_agent_display text;
  v_is_terminal_entry boolean;
  v_resolving_label text;
  v_lock_key text;
begin
  -- EOD owns its own snapshot-driven sibling handling. Cascading in the middle
  -- of that loop would invalidate rows that EOD is about to process.
  if coalesce(current_setting('reda.in_eod_rollover', true), '') = 'true' then
    return new;
  end if;

  -- Updates made by this trigger re-enter it. The outer invocation has already
  -- coordinated the whole sibling group.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- Stage 1: stand-by signal on first claim (existing behavior).
  if old.current_status = 'pending' and new.current_status = 'available' then
    select split_part(coalesce(display_name, 'Agent'), ' ', 1)
      into v_agent_first
      from public.users
     where id = new.assigned_agent_id;

    for v_sibling in
      select s.*
        from public._find_sibling_deliveries(new.id) s
        join public.delivery_status_defs sd on sd.status = s.current_status
       where sd.category <> 'terminal'
         and s.assigned_agent_id is not null
    loop
      perform public.send_edge_notification(jsonb_build_object(
        'audience', 'user',
        'user_id',  v_sibling.assigned_agent_id::text,
        'title',    'Stand by',
        'body',     coalesce(v_agent_first, 'Another agent') || ' is on '
                    || coalesce(new.customer_name, 'this delivery') || '. Hold for now.',
        'data',     jsonb_build_object('delivery_id', v_sibling.id)
      ));
    end loop;
  end if;

  -- Stage 1.5: two live race copies may both be postponed. When they converge
  -- on the same target date, retain the copy carrying the latest customer
  -- interaction (NEW) and close older postponed siblings as duplicates.
  --
  -- The transaction-scoped lock serializes simultaneous postponements for the
  -- same customer/items/date. After the first transaction commits, the second
  -- sees it and deterministically becomes the canonical latest interaction.
  if new.order_type = 'delivery'
     and new.current_status = 'postponed'
     and new.scheduled_date is not null
     and (
       old.current_status is distinct from new.current_status
       or old.scheduled_date is distinct from new.scheduled_date
     )
  then
    v_lock_key := concat_ws('|',
      new.client_id::text,
      coalesce(new.customer_phone_normalized, ''),
      coalesce(new.items_fingerprint, new.product_catalog_id::text, ''),
      new.scheduled_date::text
    );
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));

    for v_sibling in
      select s.*
        from public.deliveries s
        join public._find_sibling_deliveries(new.id) matched on matched.id = s.id
       where s.current_status = 'postponed'
         and s.order_type = 'delivery'
       order by s.updated_at desc, s.created_at asc, s.id asc
       for update of s
    loop
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id,
         client_uuid, reason, effective_at)
      values
        (v_sibling.id, v_sibling.current_status, 'cancelled', v_system_id,
         'postpone-consolidate:' || new.id::text || ':' || v_sibling.id::text,
         'Duplicate postponed copy consolidated into order ' || new.id::text
           || ' for ' || new.scheduled_date::text || '.',
         now())
      on conflict (client_uuid) do nothing;

      update public.deliveries
         set current_status     = 'cancelled',
             assigned_agent_id = null,
             updated_at         = now()
       where id = v_sibling.id
         and current_status = 'postponed';

      if found then
        perform public.write_audit(
          p_entity_type := 'delivery',
          p_entity_id   := v_sibling.id,
          p_old         := jsonb_build_object(
            'current_status', v_sibling.current_status,
            'assigned_agent_id', v_sibling.assigned_agent_id,
            'scheduled_date', v_sibling.scheduled_date
          ),
          p_new         := jsonb_build_object(
            'current_status', 'cancelled',
            'assigned_agent_id', null,
            'scheduled_date', v_sibling.scheduled_date,
            'canonical_delivery_id', new.id
          ),
          p_reason      := 'postpone_sibling_consolidated',
          p_actor_id    := v_system_id
        );
      end if;
    end loop;
  end if;

  -- Stage 2: cancel open siblings on entry to a resolving terminal status
  -- (existing behavior). rolled_over belongs to EOD; agent_cancelled means the
  -- order remains live for another agent.
  v_is_terminal_entry := exists (
    select 1
      from public.delivery_status_defs
     where status = new.current_status
       and category = 'terminal'
       and status <> 'rolled_over'
       and status <> 'agent_cancelled'
  ) and old.current_status is distinct from new.current_status;

  if v_is_terminal_entry then
    select coalesce(display_name, 'Agent')
      into v_agent_display
      from public.users
     where id = new.assigned_agent_id;

    select label
      into v_resolving_label
      from public.delivery_status_defs
     where status = new.current_status;
    v_resolving_label := coalesce(v_resolving_label, new.current_status);

    for v_sibling in
      select s.*
        from public._find_sibling_deliveries(new.id) s
        join public.delivery_status_defs sd on sd.status = s.current_status
       where sd.category <> 'terminal'
    loop
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id,
         client_uuid, reason, effective_at)
      values
        (v_sibling.id, v_sibling.current_status, 'cancelled', v_system_id,
         'sibling-cancel:' || new.id::text || ':' || v_sibling.id::text,
         coalesce(v_agent_display, 'Another agent')
           || ' handled the same order (' || v_resolving_label
           || '). Closed as duplicate.',
         now());

      update public.deliveries
         set current_status = 'cancelled',
             updated_at     = now()
       where id = v_sibling.id;

      if v_sibling.assigned_agent_id is not null then
        perform public.send_edge_notification(jsonb_build_object(
          'audience', 'user',
          'user_id',  v_sibling.assigned_agent_id::text,
          'title',    'Delivery closed',
          'body',     coalesce(v_agent_display, 'Another agent') || ' handled '
                      || coalesce(new.customer_name, 'this customer') || '''s order ('
                      || v_resolving_label || '). Your row is closed as duplicate.',
          'data',     jsonb_build_object('delivery_id', v_sibling.id)
        ));
      end if;
    end loop;
  end if;

  return new;
end
$function$;

-- Include scheduled_date so changing the target of an already-postponed order
-- is coordinated too. An UPDATE touching both columns still fires only once.
drop trigger if exists handle_sibling_coordination on public.deliveries;
create trigger handle_sibling_coordination
after update of current_status, scheduled_date on public.deliveries
for each row execute function public.tg_handle_sibling_coordination();

create or replace function public.release_postponed_due(p_due_date date)
returns integer
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
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
       where d.current_status = 'postponed'
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
     where d.current_status = 'postponed'
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
$function$;

revoke all on function public.release_postponed_due(date) from public, anon;
grant execute on function public.release_postponed_due(date) to authenticated, service_role;

commit;
