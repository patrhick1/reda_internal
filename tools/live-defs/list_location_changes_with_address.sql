-- Deployable patch: include the delivery's raw address in the existing
-- manager zone-approval list. The address is projected by the same joined RPC,
-- so the UI does not need a second request per approval row.
--
-- The transaction makes the RETURNS TABLE replacement atomic for callers.
begin;

drop function if exists public.list_location_changes(text[]);

create function public.list_location_changes(p_states text[] default null)
returns table(
  change_id          uuid,
  delivery_id        uuid,
  state              text,
  customer_name      text,
  raw_address        text,
  current_status     text,
  scheduled_date     date,
  agent_id           uuid,
  agent_name         text,
  from_location_id   uuid,
  from_location_name text,
  to_location_id     uuid,
  to_location_name   text,
  from_charged       numeric,
  to_charged         numeric,
  from_agent_payment numeric,
  to_agent_payment   numeric,
  reason             text,
  created_at         timestamptz,
  decided_at         timestamptz
)
language sql
security definer
set search_path to 'public', 'auth'
stable
as $function$
  select c.id, c.delivery_id, c.state,
         d.customer_name, d.raw_address, d.current_status, d.scheduled_date,
         c.requested_by_agent_id, u.display_name,
         c.from_location_id, fl.name, c.to_location_id, tl.name,
         c.from_charged, c.to_charged, c.from_agent_payment, c.to_agent_payment,
         c.reason, c.created_at, c.decided_at
    from public.delivery_location_changes c
    join public.deliveries d on d.id = c.delivery_id
    left join public.users u on u.id = c.requested_by_agent_id
    left join public.locations fl on fl.id = c.from_location_id
    left join public.locations tl on tl.id = c.to_location_id
   where public.is_manager()
     and (p_states is null or c.state = any(p_states))
   order by c.created_at desc
   limit 200;
$function$;

grant execute on function public.list_location_changes(text[]) to authenticated;

commit;
