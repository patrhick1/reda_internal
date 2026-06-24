-- Agent detail banner: return the latest reassignment that handed an order to
-- its current agent, but only until that agent performs a newer status action.
--
-- Reuses audit_log (all assignment paths already write assigned_agent_id there).
-- idx_audit_log_entity(entity_type, entity_id, changed_at desc) keeps this a
-- narrow indexed lookup. No new table or write path.

create or replace function public.get_delivery_handoff_state(p_delivery_id uuid)
returns table(
  handed_at timestamptz,
  handed_by_name text,
  from_agent_name text
)
language sql
stable
security definer
set search_path to 'public', 'auth'
as $function$
  with latest_handoff as (
    select
      a.id,
      a.changed_at,
      a.changed_by_user_id,
      nullif(a.old_value, '')::uuid as old_agent_id
    from public.audit_log a
    where a.entity_type = 'delivery'
      and a.entity_id = p_delivery_id
      and a.field_name = 'assigned_agent_id'
      and a.new_value = auth.uid()::text
      and exists (
        select 1
        from public.audit_log prior
        where prior.entity_type = 'delivery'
          and prior.entity_id = a.entity_id
          and prior.field_name = 'assigned_agent_id'
          and (prior.changed_at, prior.id) < (a.changed_at, a.id)
      )
    order by a.changed_at desc, a.id desc
    limit 1
  )
  select
    r.changed_at as handed_at,
    actor.display_name as handed_by_name,
    previous_agent.display_name as from_agent_name
  from public.deliveries d
  join latest_handoff r on true
  left join public.users actor on actor.id = r.changed_by_user_id
  left join public.users previous_agent on previous_agent.id = r.old_agent_id
  where d.id = p_delivery_id
    and d.assigned_agent_id = auth.uid()
    and d.deleted_at is null
    and r.changed_at > coalesce(
      (
        select max(h.changed_at)
        from public.delivery_status_history h
        where h.delivery_id = d.id
          and h.changed_by_user_id = auth.uid()
      ),
      '-infinity'::timestamptz
    );
$function$;

revoke all on function public.get_delivery_handoff_state(uuid) from public, anon;
grant execute on function public.get_delivery_handoff_state(uuid) to authenticated, service_role;
