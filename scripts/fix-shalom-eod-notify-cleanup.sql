-- Fix Shalom EOD postponed closes + failed-delivery notification policy.
--
-- 1. release_postponed_due now uses change_delivery_status, so leaving
--    postponed snaps scheduled_date back to the Lagos action day.
-- 2. The closed row is unassigned instead of remaining in the former agent's
--    future workload.
-- 3. Existing policy-closed postponed rows are repaired to the day they were
--    actually postponed and unassigned.
-- 4. Rep notification SLA excludes failed_delivery for clients whose
--    auto_cancel_soft_fails policy is enabled, matching the app's To notify rule.

begin;

create or replace function public.release_postponed_due(p_due_date date)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_actor     uuid := auth.uid();
  v_row       record;
  v_count     integer := 0;
  v_cancelled integer := 0;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'releasing postponed orders requires admin or dispatcher role'
      using errcode = '42501';
  end if;

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
        p_client_uuid => 'eod-autocancel-postponed:' || v_row.scheduled_date::text || ':' || v_row.id::text,
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
      (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
    values
      (v_row.id, v_row.current_status, 'pending', v_actor,
       'eod-release-postponed:' || v_row.scheduled_date::text || ':' || v_row.id::text,
       'postponed order came due — released to the unassigned pool for fresh assignment', now())
    on conflict (client_uuid) do nothing;

    update public.deliveries
       set current_status     = 'pending',
           assigned_agent_id = null,
           rolled_from_status = 'postponed',
           rolled_from_date   = v_row.scheduled_date,
           updated_at         = now()
     where id = v_row.id;

    perform public.write_audit(
      'delivery', v_row.id,
      jsonb_build_object(
        'current_status', 'postponed',
        'assigned_agent_id', v_row.assigned_agent_id,
        'scheduled_date', v_row.scheduled_date
      ),
      jsonb_build_object(
        'current_status', 'pending',
        'assigned_agent_id', null,
        'scheduled_date', v_row.scheduled_date,
        'rolled_from_status', 'postponed'
      ),
      'eod_release_postponed'
    );

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    raise notice 'eod: released % postponed order(s) due on/before % into the unassigned pool',
      v_count, p_due_date;
  end if;
  if v_cancelled > 0 then
    raise notice 'eod: auto-cancelled % postponed order(s) due on/before % per client policy',
      v_cancelled, p_due_date;
  end if;
  return v_count;
end;
$function$;

-- Repair only terminal rows whose failed transition came from the Shalom
-- postponed policy. The original postpone history is the authoritative work
-- date; the later failure timestamp is not.
do $cleanup$
declare
  v_row       record;
  v_system_id uuid;
begin
  select id into v_system_id
  from public.users
  where lower(email) = lower('system@reda.local')
  limit 1;

  if v_system_id is null then
    raise exception 'Reda System user not found; cleanup audit cannot be attributed';
  end if;

  for v_row in
    with policy_close as (
      select distinct on (h.delivery_id)
        h.delivery_id,
        h.changed_at as failed_at
      from public.delivery_status_history h
      where h.from_status = 'postponed'
        and h.to_status = 'failed_delivery'
        and (
          h.reason = 'eod_auto_cancel:client_policy'
          or h.reason like 'postponed order came due%auto-cancelled per client policy%'
        )
      order by h.delivery_id, h.changed_at desc
    )
    select
      d.id,
      d.scheduled_date as old_scheduled_date,
      d.assigned_agent_id as old_assigned_agent_id,
      (postponed.changed_at at time zone 'Africa/Lagos')::date as corrected_date
    from policy_close pc
    join public.deliveries d on d.id = pc.delivery_id
    join public.clients c on c.id = d.client_id
    join lateral (
      select h.changed_at
      from public.delivery_status_history h
      where h.delivery_id = d.id
        and h.to_status = 'postponed'
        and h.changed_at <= pc.failed_at
      order by h.changed_at desc
      limit 1
    ) postponed on true
    where c.auto_cancel_soft_fails
      and d.current_status = 'failed_delivery'
      and d.deleted_at is null
      and (
        d.scheduled_date is distinct from
          (postponed.changed_at at time zone 'Africa/Lagos')::date
        or d.assigned_agent_id is not null
      )
  loop
    update public.deliveries
       set scheduled_date = v_row.corrected_date,
           assigned_agent_id = null,
           updated_at = now()
     where id = v_row.id;

    perform public.write_audit(
      'delivery', v_row.id,
      jsonb_build_object(
        'scheduled_date', v_row.old_scheduled_date,
        'assigned_agent_id', v_row.old_assigned_agent_id
      ),
      jsonb_build_object(
        'scheduled_date', v_row.corrected_date,
        'assigned_agent_id', null
      ),
      'repair_eod_postponed_policy_close_2026_07_28',
      v_system_id
    );
  end loop;
end;
$cleanup$;

create or replace function public.rep_notify_coverage(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  notifiable_updates             bigint,
  notified                       bigint,
  pct_notified                   numeric,
  not_notified                   bigint,
  median_minutes_to_notify       numeric,
  backlog_open                   bigint,
  oldest_open_update_age_minutes numeric,
  last_team_notify_at            timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'auth'
as $function$
declare
  k_notify_exempt constant text[] := array[
    'pending','delivered','rolled_over','agent_cancelled',
    'deferred_to_client','unserious','picked_up','waybilled'];
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'not authorised to view rep performance' using errcode = '42501';
  end if;

  return query
  with notifiable as (
    select dsh.id as status_history_id, dsh.delivery_id, dsh.changed_at
      from public.delivery_status_history dsh
      join public.deliveries d on d.id = dsh.delivery_id and d.deleted_at is null
      join public.clients c on c.id = d.client_id
     where dsh.changed_at >= p_from and dsh.changed_at < p_to
       and dsh.to_status <> all (k_notify_exempt)
       and not (dsh.to_status = 'failed_delivery' and c.auto_cancel_soft_fails)
  ),
  joined as (
    select nf.status_history_id, nf.delivery_id, nf.changed_at, dcn.notified_at,
           case when dcn.notified_at is not null
                then extract(epoch from (dcn.notified_at - nf.changed_at)) / 60.0
           end as minutes_to_notify
      from notifiable nf
      left join public.delivery_client_notifications dcn
        on dcn.status_history_id = nf.status_history_id
  ),
  agg as (
    select count(*) as notifiable_updates,
           count(j.notified_at) as notified,
           count(*) filter (where j.notified_at is null) as not_notified,
           percentile_cont(0.5) within group (order by j.minutes_to_notify)
             filter (where j.notified_at is not null) as median_minutes
      from joined j
  ),
  backlog as (
    select count(*) as backlog_open,
           extract(epoch from (now() - min(lh.changed_at))) / 60.0 as oldest_open_age_min
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
      join lateral (
        select h.id, h.changed_at
        from public.delivery_status_history h
        where h.delivery_id = d.id
        order by h.changed_at desc
        limit 1
      ) lh on true
      left join public.delivery_client_notifications dcn
        on dcn.status_history_id = lh.id
     where d.deleted_at is null
       and sd.category <> 'terminal'
       and d.current_status <> all (k_notify_exempt)
       and dcn.status_history_id is null
  )
  select
    agg.notifiable_updates,
    agg.notified,
    case when agg.notifiable_updates = 0 then 0::numeric
         else round(100.0 * agg.notified / agg.notifiable_updates, 1) end,
    agg.not_notified,
    round(agg.median_minutes::numeric, 1),
    backlog.backlog_open,
    round(backlog.oldest_open_age_min::numeric, 1),
    (select max(dcn2.notified_at) from public.delivery_client_notifications dcn2)
  from agg, backlog;
end;
$function$;

grant execute on function public.release_postponed_due(date) to authenticated, service_role;
grant execute on function public.rep_notify_coverage(timestamptz, timestamptz) to authenticated;

commit;
