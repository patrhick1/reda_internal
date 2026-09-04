-- Bulk unassign — send N selected deliveries back to the Unassigned queue.
--
-- Greg's card (2026-08-31): mis-assigned orders had to be opened one by one
-- to unassign. The single path (unassign_delivery) already has the right
-- gates — manager only, reason required, never a closed or deleted row —
-- so the bulk RPC loops it in per-row subtransactions, exactly like
-- bulk_change_delivery_status loops change_delivery_status. Nothing about
-- who may unassign what is duplicated here.
--
-- The one thing the loop must NOT inherit is the per-row push: the assignment
-- trigger tells a rider each time a row leaves their list, so unassigning 30
-- rows would ring their phone 30 times. The RPC sets a transaction-local flag
-- the trigger now honours, collects the riders it touched, and sends each one
-- a single summary push at the end. bulk_assign_deliveries has the same
-- per-row-push shape today and can adopt the flag later.
begin;

-- ---------------------------------------------------------------------------
-- Trigger: identical to tools/live-defs/tg_notify_assignment_push.sql
-- (captured 2026-09-04) plus the flag check at the top.
-- ---------------------------------------------------------------------------
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
$function$;

-- ---------------------------------------------------------------------------
-- The bulk RPC
-- ---------------------------------------------------------------------------
create or replace function public.bulk_unassign_deliveries(
  p_client_uuid text, p_delivery_ids uuid[], p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, auth
as $fn$
declare
  v_actor   uuid := auth.uid();
  v_reason  text := nullif(btrim(p_reason), '');
  v_ids     uuid[];
  v_id      uuid;
  v_row     record;
  v_done    integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_agents  jsonb := '{}'::jsonb;   -- former agent id -> rows taken off their list
  v_agent   record;
begin
  if not public.is_manager() then
    raise exception 'unassign requires admin or dispatcher role' using errcode = '42501';
  end if;
  if p_client_uuid is null or btrim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason required for unassign' using errcode = '22023';
  end if;
  -- Dedupe and sort: two overlapping batches then lock rows in the same order.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_ids
    from unnest(p_delivery_ids) x where x is not null;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('unassigned_count', 0, 'skipped_count', 0,
      'skipped', '[]'::jsonb, 'agents', '[]'::jsonb);
  end if;
  if array_length(v_ids, 1) > 200 then
    raise exception 'Unassign at most 200 deliveries at a time' using errcode = '22023';
  end if;

  perform set_config('reda.suppress_assignment_push', 'true', true);

  foreach v_id in array v_ids loop
    select d.id, d.customer_name, d.assigned_agent_id, d.deleted_at, d.current_status, sd.category
      into v_row
      from public.deliveries d
      left join public.delivery_status_defs sd on sd.status = d.current_status
     where d.id = v_id;
    if not found then
      v_skipped := v_skipped || jsonb_build_object('delivery_id', v_id, 'customer_name', null, 'why', 'not found');
    elsif v_row.deleted_at is not null then
      v_skipped := v_skipped || jsonb_build_object('delivery_id', v_id, 'customer_name', v_row.customer_name, 'why', 'deleted');
    elsif v_row.category = 'terminal' then
      v_skipped := v_skipped || jsonb_build_object('delivery_id', v_id, 'customer_name', v_row.customer_name,
        'why', 'closed (' || replace(v_row.current_status, '_', ' ') || ')');
    elsif v_row.assigned_agent_id is null then
      v_skipped := v_skipped || jsonb_build_object('delivery_id', v_id, 'customer_name', v_row.customer_name, 'why', 'already in the queue');
    else
      -- Per-row subtransaction through the canonical single path (same gates,
      -- same audit shape). A refusal becomes a skip, not a failed batch.
      begin
        perform public.unassign_delivery(v_id, v_reason || ' (bulk ' || left(p_client_uuid, 8) || ')');
        v_done := v_done + 1;
        v_agents := jsonb_set(v_agents, array[v_row.assigned_agent_id::text],
          to_jsonb(coalesce((v_agents->>v_row.assigned_agent_id::text)::integer, 0) + 1));
      exception when others then
        v_skipped := v_skipped || jsonb_build_object('delivery_id', v_id, 'customer_name', v_row.customer_name, 'why', sqlerrm);
      end;
    end if;
  end loop;

  -- One summary push per former rider. Never the person doing the unassign.
  for v_agent in
    select e.key::uuid as agent_id, e.value::integer as n from jsonb_each_text(v_agents) e
  loop
    if v_agent.agent_id is distinct from v_actor then
      perform public.send_edge_notification(jsonb_build_object(
        'audience', 'user',
        'user_id',  v_agent.agent_id::text,
        'title',    case when v_agent.n = 1 then 'Order moved to the queue'
                         else v_agent.n || ' orders moved to the queue' end,
        'body',     case when v_agent.n = 1 then 'One delivery is no longer on your list.'
                         else v_agent.n || ' deliveries are no longer on your list.' end,
        'data',     jsonb_build_object('kind', 'bulk_unassign', 'count', v_agent.n)));
    end if;
  end loop;

  -- The flag is transaction-local; clear it so nothing later in the same
  -- transaction (smoke tests, future composite RPCs) is silenced by accident.
  perform set_config('reda.suppress_assignment_push', 'false', true);

  return jsonb_build_object(
    'unassigned_count', v_done,
    'skipped_count',    jsonb_array_length(v_skipped),
    'skipped',          v_skipped,
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'agent_id', e.key, 'agent_name', u.display_name, 'count', e.value::integer)
               order by e.value::integer desc, u.display_name), '[]'::jsonb)
        from jsonb_each_text(v_agents) e
        left join public.users u on u.id = e.key::uuid));
end;
$fn$;

revoke all on function public.bulk_unassign_deliveries(text, uuid[], text) from public, anon, authenticated, service_role;
grant execute on function public.bulk_unassign_deliveries(text, uuid[], text) to authenticated;

notify pgrst, 'reload schema';
commit;
