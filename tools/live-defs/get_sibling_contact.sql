-- get_sibling_contact(p_delivery_id) — "another agent is also on this order"
-- ---------------------------------------------------------------------------
-- A customer order can legitimately land as TWO delivery rows under two agents
-- (the cross-agent race — allowed; never blocked). RLS hides each row from the
-- other agent, so neither knows the other is also calling the customer → the
-- customer gets contacted twice and it reads as disorganized.
--
-- This SECURITY DEFINER read surfaces, for a given delivery, the most-recently-
-- worked SIBLING that another agent already engaged — so the UI can show a
-- "Mr Austin already reached this customer (Available) at 14:02" banner before
-- the second agent dials. No new data: contact is inferred from the sibling's
-- status (active = reached; soft_failure = attempted; delivered/picked_up/
-- waybilled = already fulfilled). Dead duplicates (cancelled / failed / etc.)
-- are deliberately excluded so a killed twin never mutes the live row.
--
-- Reuses _find_sibling_deliveries (the same matcher the delivered-sibling guard
-- in change_delivery_status already trusts), which is SECURITY DEFINER and so
-- sees the sibling row across RLS.

create or replace function public.get_sibling_contact(p_delivery_id uuid)
 returns table(
   sibling_delivery_id uuid,
   agent_id            uuid,
   agent_name          text,
   status              text,
   status_label        text,
   category            text,
   worked_at           timestamptz
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_d public.deliveries%rowtype;
begin
  select * into v_d from public.deliveries where id = p_delivery_id;
  if not found then return; end if;

  -- Only the delivery's own assigned agent, or ops, may ask about its siblings.
  -- Mirrors who can see the delivery itself; the function is SECURITY DEFINER so
  -- it can read the sibling row RLS hides from the agent.
  if not (public.is_admin_or_dispatcher() or v_d.assigned_agent_id = auth.uid()) then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select s.id,
         s.assigned_agent_id,
         coalesce(u.display_name, 'another agent')::text,
         s.current_status,
         coalesce(sd.label, s.current_status)::text,
         sd.category,
         coalesce(h.last_at, s.updated_at)
    from public._find_sibling_deliveries(p_delivery_id) s
    join public.delivery_status_defs sd on sd.status = s.current_status
    left join public.users u on u.id = s.assigned_agent_id
    left join lateral (
      select max(changed_at) as last_at
        from public.delivery_status_history
       where delivery_id = s.id
    ) h on true
   where s.deleted_at is null
     -- only OTHER agents' work (a row this same agent holds isn't a coordination
     -- risk and would read as a confusing self-reference)
     and s.assigned_agent_id is distinct from v_d.assigned_agent_id
     -- contacted/active or already fulfilled — never a dead duplicate
     and (sd.category in ('active', 'soft_failure')
          or s.current_status in ('delivered', 'picked_up', 'waybilled'))
   order by coalesce(h.last_at, s.updated_at) desc
   limit 1;
end;
$function$;

revoke all on function public.get_sibling_contact(uuid) from public;
grant execute on function public.get_sibling_contact(uuid) to authenticated;
