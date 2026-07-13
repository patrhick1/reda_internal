-- count_pending_location_changes — scalar badge count for the pending agent
-- zone-change (delivery_location_changes) approval queue.
--
-- Mirrors list_location_changes' security model EXACTLY: SECURITY DEFINER, the
-- same public.is_manager() gate, same search_path. It just returns a single
-- bigint instead of up to 200 wide joined rows. The admin Home / dispatcher
-- Dashboard badge polls this every 30s; before, the mobile
-- countPendingLocationChanges() called list_location_changes(['pending']) and
-- read rows.length — i.e. it downloaded the whole joined result set only to
-- count it (Supabase egress audit, item 3 / item 9).
--
-- Non-managers: public.is_manager() is false, so the WHERE excludes every row
-- and the count is 0 — identical to today's behaviour where the list RPC
-- returns nothing (rows.length === 0) for them.
create or replace function public.count_pending_location_changes()
returns bigint
language sql
stable
security definer
set search_path to 'public', 'auth'
as $function$
  select count(*)
  from public.delivery_location_changes c
  where public.is_manager()
    and c.state = 'pending';
$function$;

grant execute on function public.count_pending_location_changes()
  to authenticated, anon, service_role;
