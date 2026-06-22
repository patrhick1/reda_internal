-- No Product -> non-terminal soft-fail (Uzo, 2026-06-22)
--
-- "No product" is a transient supply blocker (the assigned rider isn't carrying
-- the product), NOT an order outcome. As a terminal status it (a) CASCADED — one
-- rider's "no product" cancelled every other racing agent's row, including agents
-- who DID have the product; (b) LOCKED the row, so the rider couldn't complete the
-- delivery once Uzo sent the product over; and (c) read as a final disposition.
--
-- Recategorising it to a non-terminal soft_failure fixes all three at once: the
-- realtime cascade (tg_handle_sibling_coordination) and the EOD resolved-sibling
-- backstop (run_eod_rollover) both key off category='terminal', so a non-terminal
-- no_product drops out of BOTH automatically — no edits needed there. It is now
-- entered via a dedicated "No product" agent flag (issue_type='no_product') and is
-- excluded from the carry-cap in rollover_delivery (separate file) so it rolls
-- forward until delivered or explicitly cancelled instead of auto-closing to
-- 'unserious' (which would wrongly blame the customer for Reda's supply gap).
-- Admin is still notified on entry (no_product kept in tg_notify_delivery_status_change).

begin;

-- 1. Recategorise: terminal -> soft_failure (non-terminal => revertible + non-cascading).
update public.delivery_status_defs
   set category = 'soft_failure'
 where status = 'no_product';

-- 2. Allow the new 'no_product' agent-flag issue type on the message table.
alter table public.delivery_messages
  drop constraint delivery_messages_issue_type_check,
  add constraint delivery_messages_issue_type_check
    check (issue_type = any (array[
      'wrong_address'::text, 'cant_reach_client'::text, 'payment_dispute'::text,
      'product_issue'::text, 'not_my_route'::text, 'no_product'::text, 'other'::text
    ]));

-- 3. _dm_is_terminal_status: no_product is no longer terminal for the messaging /
--    flag layer, so a no_product row can still be flagged and isn't treated as closed.
create or replace function public._dm_is_terminal_status(p_status text)
 returns boolean
 language sql
 immutable
as $function$
  select p_status = any(array[
    'delivered','cancelled','failed_delivery','unserious','rolled_over'
  ])
$function$;

-- 4. flag_delivery_issue: accept 'no_product' in the issue-type whitelist so the
--    new agent flag can both seed an ops thread AND set the soft no_product status.
create or replace function public.flag_delivery_issue(p_delivery_id uuid, p_issue_type text, p_note text, p_new_status text, p_client_uuid uuid)
 returns delivery_messages
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  v_user     uuid := auth.uid();
  v_status   text;
  v_agent    uuid;
  v_existing public.delivery_messages%rowtype;
  v_new      public.delivery_messages%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_client_uuid is null then
    raise exception 'p_client_uuid is required' using errcode = '22023';
  end if;
  if p_issue_type is null or p_issue_type not in (
    'wrong_address','cant_reach_client','payment_dispute','product_issue','not_my_route','no_product','other'
  ) then
    raise exception 'invalid issue_type: %', coalesce(p_issue_type, 'null')
      using errcode = '22023';
  end if;

  -- Idempotency: if this client_uuid already produced a message, return it.
  select * into v_existing
    from public.delivery_messages
   where client_uuid = p_client_uuid;
  if found then
    return v_existing;
  end if;

  select current_status, assigned_agent_id
    into v_status, v_agent
    from public.deliveries
   where id = p_delivery_id;
  if v_status is null then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if v_agent is null or v_agent <> v_user then
    raise exception 'only the assigned agent can flag this delivery'
      using errcode = '42501';
  end if;
  if public._dm_is_terminal_status(v_status) then
    raise exception 'cannot flag a terminal delivery (status %)', v_status
      using errcode = '22023';
  end if;

  -- Step 1: optional status transition. change_delivery_status reads
  -- auth.uid() for its own role check; security-definer wrapping preserves
  -- auth.uid(), so the inner check still sees the agent. Note that the
  -- existing RPC takes p_client_uuid as TEXT, not UUID -- cast explicitly.
  -- Default-null trailing args are omitted entirely so PG can resolve the
  -- function signature without ambiguous unknown types.
  if p_new_status is not null then
    perform public.change_delivery_status(
      p_client_uuid => p_client_uuid::text,
      p_delivery_id => p_delivery_id,
      p_to_status   => p_new_status,
      p_reason      => p_issue_type,
      p_notes       => p_note
    );
  end if;

  -- Step 2: insert the message.
  insert into public.delivery_messages (
    delivery_id, author_id, author_role, issue_type, note, client_uuid
  ) values (
    p_delivery_id, v_user, 'agent', p_issue_type, nullif(trim(coalesce(p_note,'')), ''), p_client_uuid
  ) returning * into v_new;

  perform public.write_audit(
    'delivery_message', v_new.id,
    null,
    jsonb_build_object('issue_type', p_issue_type, 'note', p_note, 'new_status', p_new_status),
    'flag', null
  );

  return v_new;
end $function$;

commit;
