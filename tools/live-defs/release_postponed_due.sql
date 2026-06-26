-- ============================================================================
-- release_postponed_due — release postponed orders that have reached their
-- release window back into the unassigned pool for fresh assignment.
--
-- A postponed order due day D should be released on the night of D-1, so the
-- rider keeps (and can revert) it until then, and ops assigns it fresh on D.
--
-- CATCH-UP (changed 2026-06-26): releases every postponed order due ON OR
-- BEFORE p_due_date (`scheduled_date <= p_due_date`), not just the exact
-- date. Callers pass (today_lagos + 1), so the normal nightly run releases
-- "tomorrow's" batch; but if a night is missed or its transaction is rolled back
-- (e.g. the 2026-06-25 EOD aborted on a stranded waybill and reverted the
-- release with it), the NEXT run still picks up the now-overdue orders instead
-- of orphaning them as postponed-but-assigned forever. Idempotent: a released
-- row is no longer 'postponed', so re-running never double-releases.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.release_postponed_due(p_due_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_row   record;
  v_count integer := 0;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'releasing postponed orders requires admin or dispatcher role' using errcode = '42501';
  end if;

  for v_row in
    select id, current_status, scheduled_date, assigned_agent_id
      from public.deliveries
     where current_status = 'postponed'
       and scheduled_date <= p_due_date
       and deleted_at is null
     for update
  loop
    -- Per-row idempotency already comes from the `current_status = 'postponed'`
    -- filter, so this insert doesn't need the unique key to dedup. on-conflict is
    -- belt-and-braces: if a row is released, re-postponed to the SAME due date, and
    -- released again the same day, the deterministic client_uuid would collide with
    -- the UNIQUE index and otherwise abort the whole EOD sweep. Skip instead.
    insert into public.delivery_status_history
      (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
    values
      (v_row.id, v_row.current_status, 'pending', v_actor,
       'eod-release-postponed:' || v_row.scheduled_date::text || ':' || v_row.id::text,
       'postponed order came due — released to the unassigned pool for fresh assignment', now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status    = 'pending',
           assigned_agent_id = null,
           rolled_from_status = 'postponed',
           rolled_from_date   = v_row.scheduled_date,
           updated_at         = now()
     where id = v_row.id;

    perform public.write_audit(
      'delivery', v_row.id,
      jsonb_build_object('current_status', 'postponed', 'assigned_agent_id', v_row.assigned_agent_id,
                         'scheduled_date', v_row.scheduled_date),
      jsonb_build_object('current_status', 'pending', 'assigned_agent_id', null,
                         'scheduled_date', v_row.scheduled_date,
                         'rolled_from_status', 'postponed'),
      'eod_release_postponed'
    );

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    raise notice 'eod: released % postponed order(s) due on/before % into the unassigned pool', v_count, p_due_date;
  end if;
  return v_count;
end;
$function$;
