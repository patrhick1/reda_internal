-- One-time cleanup for the two surplus postponed-origin rows confirmed on
-- 2026-08-24. Uses the live EOD classifier rather than hard-coded customer data,
-- and only touches released-from-postponed rows that are presently classified
-- as duplicate siblings. Re-running is a no-op.

begin;

do $cleanup$
declare
  v_system_id uuid;
  v_row record;
begin
  select id into v_system_id
    from public.users
   where lower(email) = 'system@reda.local'
   limit 1;
  if v_system_id is null then
    raise exception 'Reda System user not found; cleanup cannot be audited';
  end if;

  -- Prevent the ordinary terminal-status sibling cascade from closing the
  -- canonical row while the targeted duplicate is being cancelled.
  perform set_config('reda.in_eod_rollover', 'true', true);

  for v_row in
    select d.id, d.current_status, d.assigned_agent_id, d.scheduled_date,
           sibling.id as canonical_delivery_id
      from public._eod_classify((now() at time zone 'Africa/Lagos')::date) e
      join public.deliveries d on d.id = e.delivery_id
      left join lateral (
        select s.id
          from public._find_sibling_deliveries(d.id) s
          join public.delivery_status_defs sd on sd.status = s.current_status
         where sd.category <> 'terminal'
         order by sd.sort_order desc, s.updated_at desc, s.created_at asc, s.id asc
         limit 1
      ) sibling on true
     where e.action in ('dedup_same_agent', 'dedup_cross_agent')
       and d.rolled_from_status = 'postponed'
       and d.scheduled_date = (now() at time zone 'Africa/Lagos')::date
       and d.deleted_at is null
     order by d.id
     for update of d
  loop
    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id,
       client_uuid, reason, effective_at)
    values
      (v_row.id, v_row.current_status, 'cancelled', v_system_id,
       'cleanup-postponed-duplicate-20260824:' || v_row.id::text,
       'Released postponed duplicate consolidated into order '
         || coalesce(v_row.canonical_delivery_id::text, 'canonical sibling') || '.',
       now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status     = 'cancelled',
           assigned_agent_id = null,
           updated_at         = now()
     where id = v_row.id
       and current_status = v_row.current_status;

    if found then
      perform public.write_audit(
        p_entity_type := 'delivery',
        p_entity_id   := v_row.id,
        p_old         := jsonb_build_object(
          'current_status', v_row.current_status,
          'assigned_agent_id', v_row.assigned_agent_id,
          'scheduled_date', v_row.scheduled_date
        ),
        p_new         := jsonb_build_object(
          'current_status', 'cancelled',
          'assigned_agent_id', null,
          'scheduled_date', v_row.scheduled_date,
          'canonical_delivery_id', v_row.canonical_delivery_id
        ),
        p_reason      := 'cleanup_released_postponed_duplicate_20260824',
        p_actor_id    := v_system_id
      );
    end if;
  end loop;
end
$cleanup$;

commit;
