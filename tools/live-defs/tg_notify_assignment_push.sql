-- tg_notify_assignment_push as live on the box after the bulk-unassign change (2026-09-04).
-- Diff vs the pre-change capture (commit 2fa4e5c) is the reda.suppress_assignment_push check;
-- see supabase/migrations/20260904003000_bulk_unassign_deliveries.sql.

CREATE OR REPLACE FUNCTION public.tg_notify_assignment_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_new uuid := new.assigned_agent_id;
  v_old uuid := case when TG_OP = 'UPDATE' then (old).assigned_agent_id else null end;
begin
  -- Bulk RPCs set this for the transaction and send ONE summary push per
  -- rider themselves (see bulk_unassign_deliveries).
  if coalesce(current_setting('reda.suppress_assignment_push', true), '') = 'true' then
    return new;
  end if;
  -- NEW: notify the agent who LOST the row — reassigned to another agent OR
  -- unassigned back to the queue. Skip on insert/no-op, and never ping the
  -- person who performed the move (e.g. a lead handing off their own delivery).
  if TG_OP = 'UPDATE'
     and v_old is not null
     and v_old is distinct from v_new
     and v_old is distinct from auth.uid()
  then
    perform public.send_edge_notification(jsonb_build_object(
      'audience', 'user',
      'user_id',  v_old::text,
      'title',    case when v_new is null then 'Order moved to the queue'
                       else 'Order reassigned' end,
      'body',     coalesce(new.customer_name, 'A delivery')
                  || case when v_new is null then ' is no longer on your list.'
                          else ' was reassigned to another agent.' end,
      'data',     jsonb_build_object('delivery_id', new.id)
    ));
  end if;
  -- EXISTING: push the NEW assignee (unchanged).
  if v_new is null then return new; end if;
  if TG_OP = 'UPDATE' and v_new is not distinct from v_old then return new; end if;
  perform public.send_edge_notification(
    jsonb_build_object('audience', 'assignment', 'delivery_id', new.id)
  );
  return new;
end;
$function$

