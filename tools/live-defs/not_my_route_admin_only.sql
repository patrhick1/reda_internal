-- 'Not my route' becomes an ADMIN/DISPATCHER-only flag (2026-06-25, Uzo).
--
-- Problem: a 'not_my_route' flag is a reassignment request — only admins/
-- dispatchers can reassign. But reps could see it and reply ("On it"), and any
-- rep engagement (reply / "Mark handled" / claim-followup) calls
-- mark_messages_read, which stamps read_at on the agent's message. The admin
-- "open issues" feed filters on `read_at is null`, so a rep clearing it made the
-- issue VANISH from the admin's feed before anyone could reassign.
--
-- Fix (server half; the mobile app hides + blocks the rep UI to match):
--   1. mark_messages_read   — a rep can never clear a 'not_my_route' flag, so it
--                             stays on the admin/dispatcher feed until THEY act.
--                             This one guard covers every consumption path
--                             (reply / Mark handled / claim_followup all route
--                             through here).
--   2. reply_to_delivery    — reject a rep reply while an open 'not_my_route'
--                             flag exists (mirrors the hidden UI composer).
--   3. tg_notify_delivery_message — push 'not_my_route' to 'managers' (admin +
--                             dispatcher) instead of 'reps'; other flags still
--                             ping reps, who own normal agent-issue handling.
--
-- Idempotent: all CREATE OR REPLACE. Safe to re-run. Apply in the Supabase SQL
-- editor (or psql). Other flag types (wrong_address, payment_dispute, …) are
-- unchanged and still handled by reps.

begin;

-- 1. mark_messages_read ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user uuid := auth.uid();
  v_role text;
begin
  if v_user is null then
    return;
  end if;
  select role into v_role from public.users where id = v_user;
  -- Role direction, not author_id: each side clears only the OTHER side's
  -- messages. An agent reads ops messages; an ops user reads agent messages.
  -- This avoids one ops user marking another ops user's message read (which
  -- would falsely drop the agent's "ops replied" badge).
  update public.delivery_messages
     set read_at = now()
   where delivery_id = p_delivery_id
     and read_at is null
     and case when v_role = 'agent' then author_role <> 'agent'
              else author_role = 'agent' end
     -- A rep can never clear a 'not my route' flag: it's reassigned by an
     -- admin/dispatcher. Clearing it (reply / Mark handled / claim) would drop
     -- it off the admin "open issues" feed (filters read_at is null) before
     -- anyone with reassign rights acted. Keep it unread for reps.
     and not (v_role = 'rep' and issue_type is not distinct from 'not_my_route');
end $function$;

-- 2. reply_to_delivery ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reply_to_delivery(p_delivery_id uuid, p_text text, p_client_uuid uuid)
 RETURNS delivery_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user           uuid := auth.uid();
  v_role           text;
  v_status         text;
  v_assigned_agent uuid;
  v_existing       public.delivery_messages%rowtype;
  v_new            public.delivery_messages%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_client_uuid is null then
    raise exception 'p_client_uuid is required' using errcode = '22023';
  end if;
  if p_text is null or length(trim(p_text)) = 0 then
    raise exception 'reply text is required' using errcode = '22023';
  end if;

  -- Idempotency. Same client_uuid = same row.
  select * into v_existing
    from public.delivery_messages
   where client_uuid = p_client_uuid;
  if found then
    return v_existing;
  end if;

  select current_status, assigned_agent_id
    into v_status, v_assigned_agent
    from public.deliveries where id = p_delivery_id;
  if v_status is null then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if public._dm_is_terminal_status(v_status) then
    raise exception 'cannot reply on a terminal delivery (status %)', v_status
      using errcode = '22023';
  end if;

  -- Participant gate: assigned agent OR any operational coordinator role
  -- (admin/dispatcher/rep). is_admin_or_dispatcher() is the shared helper
  -- whose body already names that set; this preserves the single source of
  -- truth for "ops" across the codebase.
  select role into v_role from public.users where id = v_user;
  if not (
    public.is_admin_or_dispatcher()
    or (v_role = 'agent' and v_assigned_agent = v_user)
  ) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- 'Not my route' is an admin/dispatcher reassignment job. Reps may read the
  -- thread but must not engage while the flag is open: a reply would mislead the
  -- agent and (via mark_messages_read below) try to consume the flag. The UI
  -- already hides the composer for reps in this case; this is the server guard.
  if v_role = 'rep' and exists (
    select 1 from public.delivery_messages
     where delivery_id = p_delivery_id
       and author_role = 'agent'
       and issue_type = 'not_my_route'
       and read_at is null
  ) then
    raise exception 'not my route is handled by an admin or dispatcher'
      using errcode = '42501';
  end if;

  -- author_role is the user's actual role — drives the trigger's push
  -- routing (agent → reps, ops → assigned agent).
  insert into public.delivery_messages (
    delivery_id, author_id, author_role, note, client_uuid
  ) values (
    p_delivery_id, v_user, v_role, trim(p_text), p_client_uuid
  ) returning * into v_new;

  -- Replying IS engaging, so clear the other party's unread for this delivery.
  -- (ops reply → clears the agent's messages → ops badge clears; agent reply →
  -- clears ops messages → agent badge clears.) Role-aware via auth.uid().
  perform public.mark_messages_read(p_delivery_id);

  perform public.write_audit(
    'delivery_message', v_new.id,
    null,
    jsonb_build_object('text', p_text),
    'reply', null
  );

  return v_new;
end $function$;

-- 3. tg_notify_delivery_message -------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_notify_delivery_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer    text;
  v_agent_first text;
  v_agent_id    uuid;
  v_author_name text;
  v_label       text;
begin
  if new.author_role = 'agent' then
    -- Auto-seeded soft-fail notes (an agent picking number_busy/not_connecting/
    -- switched_off/etc. routes through flag_delivery_issue with
    -- issue_type='cant_reach_client') are routine call outcomes, not the agent
    -- reaching out — so they push no one. Mirrors the mobile AUTO_SEEDED_ISSUE_TYPES
    -- set and the list badge (opsUnreadAgentCounts). Deliberate contact (a reply,
    -- issue_type null, or an actionable flag) still notifies.
    if new.issue_type = 'cant_reach_client' then
      return new;
    end if;

    select d.customer_name, split_part(coalesce(u.display_name, 'Agent'), ' ', 1)
      into v_customer, v_agent_first
      from public.deliveries d
      left join public.users u on u.id = d.assigned_agent_id
     where d.id = new.delivery_id;

    v_label := public._dm_issue_label(new.issue_type);

    -- Reps own agent issues, EXCEPT 'not my route': that's a reassignment only
    -- admins/dispatchers can do, so route it to 'managers' (admin + dispatcher).
    -- 'reps' / 'managers' both resolve in the send-notification edge function.
    perform public.send_edge_notification(jsonb_build_object(
      'audience', case when new.issue_type = 'not_my_route' then 'managers' else 'reps' end,
      'title',    'Issue flagged',
      'body',     v_label || ' · ' || coalesce(v_customer, 'customer')
                  || ' (' || coalesce(v_agent_first, 'Agent') || ')',
      'data',     jsonb_build_object('delivery_id', new.delivery_id)
    ));
  else
    -- ops_to_agent
    select assigned_agent_id into v_agent_id
      from public.deliveries where id = new.delivery_id;
    if v_agent_id is null then
      return new;
    end if;

    select display_name into v_author_name
      from public.users where id = new.author_id;

    perform public.send_edge_notification(jsonb_build_object(
      'audience', 'user',
      'user_id',  v_agent_id::text,
      'title',    'Reply from ' || coalesce(v_author_name, 'ops'),
      'body',     left(coalesce(new.note, ''), 120),
      'data',     jsonb_build_object('delivery_id', new.delivery_id)
    ));
  end if;
  return new;
end $function$;

commit;
