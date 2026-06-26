-- Mirror of the live delete_delivery / bulk_delete_deliveries (applied 2026-06-22).
--
-- Change vs prior: soft-deleting a delivery now also resolves its open
-- issues/threads by marking the delivery's unread delivery_messages read. read_at
-- is the existing resolution signal the ops "Open issues from agents" feed
-- (listOpenIssuesForOps) and the unread badges already key off — so a flag like
-- "Not my route" on a deleted order no longer lingers with no way to clear it
-- (the delivery is gone, so ops can't open the thread). Fixing at the source
-- means no per-query deleted_at guard to remember and no new column/concept.
-- Everything else (manager gate, FINAL_STATUSES guard, idempotency, audit) is
-- unchanged.
--
-- A one-time backfill (clear unread messages on already-deleted deliveries) was
-- run alongside this apply; it is a data fix, not a definition, so it lives in
-- scripts/resolve-issues-on-delete.sql, not here.

create or replace function public.delete_delivery(p_delivery_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_row   public.deliveries%rowtype;
begin
  if not public.is_manager() then
    raise exception 'delete requires admin or dispatcher role' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required for delete' using errcode = '22023';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;

  -- Idempotent re-call: already deleted is a no-op (not an error).
  if v_row.deleted_at is not null then
    return;
  end if;

  -- FINAL_STATUSES gate. delivered/rolled_over need surgical handling we
  -- haven't built (stock release, parent/child chain). Refuse here — EXCEPT for
  -- waybills/pickups/failed-deliveries, which are money-only records (no stock,
  -- no rollover chain) created directly as 'delivered'. Soft-deleting one is the
  -- clean way to undo a mistaken charge — it simply drops out of reconciliation
  -- (which filters deleted_at). Reverting them to 'pending' is blocked elsewhere
  -- because it poisons the EOD rollover, so delete is their only undo path.
  if v_row.current_status in ('delivered', 'rolled_over')
     and v_row.order_type <> 'waybill' then
    raise exception 'cannot delete a delivery in status % — correct via the state machine first', v_row.current_status
      using errcode = '22023';
  end if;

  update public.deliveries
     set deleted_at = now(),
         updated_at = now()
   where id = p_delivery_id;

  -- Resolve the delivery's open issues/threads: a deleted order has nothing to
  -- action. read_at is the existing resolution signal the ops issue feed and
  -- unread badges key off, so this clears the phantom everywhere at once.
  update public.delivery_messages
     set read_at = now()
   where delivery_id = p_delivery_id
     and read_at is null;

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := p_delivery_id,
    p_old         := jsonb_build_object(
                       'deleted_at', null,
                       'current_status', v_row.current_status,
                       'assigned_agent_id', v_row.assigned_agent_id
                     ),
    p_new         := jsonb_build_object('deleted_at', now()),
    p_reason      := btrim(p_reason)
  );
end;
$function$;

create or replace function public.bulk_delete_deliveries(p_delivery_ids uuid[], p_reason text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_actor   uuid := auth.uid();
  v_row     record;
  v_deleted int  := 0;
  v_skipped int  := 0;
begin
  if not public.is_admin() then
    raise exception 'bulk delete requires admin role' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required for bulk delete' using errcode = '22023';
  end if;
  if p_delivery_ids is null or array_length(p_delivery_ids, 1) is null then
    return jsonb_build_object('deleted_count', 0, 'skipped_count', 0);
  end if;

  for v_row in
    select id, current_status, deleted_at, assigned_agent_id
      from public.deliveries
     where id = any(p_delivery_ids)
     for update
  loop
    if v_row.deleted_at is not null
       or v_row.current_status in ('delivered', 'rolled_over') then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update public.deliveries
       set deleted_at = now(),
           updated_at = now()
     where id = v_row.id;

    -- Resolve open issues/threads on the deleted row (see delete_delivery).
    update public.delivery_messages
       set read_at = now()
     where delivery_id = v_row.id
       and read_at is null;

    perform public.write_audit(
      p_actor_id    := v_actor,
      p_entity_type := 'delivery',
      p_entity_id   := v_row.id,
      p_old         := jsonb_build_object(
                         'deleted_at', null,
                         'current_status', v_row.current_status,
                         'assigned_agent_id', v_row.assigned_agent_id
                       ),
      p_new         := jsonb_build_object('deleted_at', now()),
      p_reason      := btrim(p_reason)
    );

    v_deleted := v_deleted + 1;
  end loop;

  return jsonb_build_object('deleted_count', v_deleted, 'skipped_count', v_skipped);
end;
$function$;
