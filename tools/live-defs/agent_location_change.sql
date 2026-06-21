-- ============================================================================
-- Agent-driven delivery zone change, with manager approval
-- ============================================================================
-- A delivery is zoned at intake from the ordered address, but the agent often
-- delivers the customer somewhere ELSE (relocated / met at work / redirected).
-- location_id is a BILLING ZONE that drives charged_snapshot (Reda's fee billed
-- to the vendor) and agent_payment_snapshot (agent pay) via effective_rate.
-- Today only managers can change a zone, so a delivery-elsewhere is silently
-- mis-billed. This lets the ASSIGNED AGENT record the actual zone, with money
-- following it, gated by the self-dealing risk:
--   * new zone does NOT raise agent pay (or first-time set) -> AUTO-APPLY
--   * new zone RAISES agent pay                             -> HOLD for a manager
-- Managers (is_manager = admin+dispatcher) approve / reject / revert.
--
-- Design notes:
--   * Dedicated table + SECURITY DEFINER RPCs (base-table writes are locked
--     down; mirrors correct_delivery_location / return_delivery_leftover).
--   * change_delivery_status is NOT touched. The agent action is offline-queued
--     alongside the mark-delivered job; out-of-order safety comes from the RPC
--     accepting both pre-delivery AND delivered rows (re-snapshot either way).
--   * Idempotent on p_client_uuid (real UNIQUE constraint, concurrency-safe).
--   * Settlement drift (settlements is live): a change on an already-settled
--     scheduled_date is surfaced (returned + audited + managers pushed even on
--     auto-apply), never blocked — matches the house snapshot+drift model.
--
-- Apply: psql "$SUPABASE_DB_URI" -1 -f scripts/agent-location-change.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A1. Table
-- ----------------------------------------------------------------------------
create table if not exists public.delivery_location_changes (
  id                     uuid primary key default gen_random_uuid(),
  client_uuid            text not null,
  delivery_id            uuid not null references public.deliveries(id),
  requested_by_agent_id  uuid not null references public.users(id),
  from_location_id       uuid references public.locations(id),   -- nullable: row may have had no zone
  to_location_id         uuid not null references public.locations(id),
  from_charged           numeric,                                -- snapshot BEFORE (nullable)
  from_agent_payment     numeric,
  to_charged             numeric not null,                       -- request-time recompute (display/audit)
  to_agent_payment       numeric not null,
  reason                 text not null,
  state                  text not null default 'pending'
                           check (state in ('pending','applied','approved','rejected','reverted')),
  decided_by_user_id     uuid references public.users(id),
  decided_at             timestamptz,
  created_at             timestamptz not null default now(),
  constraint dlc_client_uuid_uniq unique (client_uuid)
);

-- At most one OPEN request per delivery (server-enforced, not an app check).
create unique index if not exists dlc_one_open_per_delivery
  on public.delivery_location_changes (delivery_id) where state = 'pending';
create index if not exists dlc_delivery on public.delivery_location_changes (delivery_id);
create index if not exists dlc_pending  on public.delivery_location_changes (state) where state = 'pending';

alter table public.delivery_location_changes enable row level security;
revoke all on public.delivery_location_changes from authenticated, anon;
grant select on public.delivery_location_changes to authenticated;     -- writes only via the RPCs below
drop policy if exists dlc_select_own on public.delivery_location_changes;
create policy dlc_select_own on public.delivery_location_changes
  for select to authenticated
  using (requested_by_agent_id = auth.uid() or public.is_admin_or_dispatcher());

-- ----------------------------------------------------------------------------
-- A2. Shared helper: apply a zone + re-snapshot both money columns + audit.
--     Private (no grant to authenticated) — only the SECURITY DEFINER RPCs
--     below call it, so the money-snapshot logic lives in ONE place.
-- ----------------------------------------------------------------------------
create or replace function public._apply_delivery_zone(
  p_delivery_id  uuid,
  p_location_id  uuid,
  p_audit_reason text
)
returns table(charged numeric, agent_payment numeric)
language plpgsql security definer set search_path to 'public', 'auth'
as $fn$
declare
  v_row           public.deliveries%rowtype;
  v_charged       numeric;
  v_agent_payment numeric;
begin
  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;

  -- Keyed on (location, client, agent) exactly like correct_delivery_location /
  -- update_delivery_fields; passing assigned_agent_id reapplies the agent bonus.
  select er.charged, er.agent_payment
    into v_charged, v_agent_payment
    from public.effective_rate(p_location_id, v_row.client_id, v_row.assigned_agent_id) er;
  if v_charged is null then
    raise exception
      'no active rate card for (location=%, client=%); add one before changing the zone',
      p_location_id, v_row.client_id
      using errcode = '22023',
            hint   = 'add a rate_card row for this location/client first';
  end if;

  update public.deliveries
     set location_id            = p_location_id,
         charged_snapshot       = v_charged,
         agent_payment_snapshot = v_agent_payment,
         updated_at             = now()
   where id = p_delivery_id;

  perform public.write_audit(
    p_entity_type := 'delivery',
    p_entity_id   := p_delivery_id,
    p_old := jsonb_build_object(
      'location_id',            v_row.location_id,
      'charged_snapshot',       v_row.charged_snapshot,
      'agent_payment_snapshot', v_row.agent_payment_snapshot
    ),
    p_new := jsonb_build_object(
      'location_id',            p_location_id,
      'charged_snapshot',       v_charged,
      'agent_payment_snapshot', v_agent_payment
    ),
    p_reason   := p_audit_reason,
    p_actor_id := auth.uid()
  );

  charged := v_charged;
  agent_payment := v_agent_payment;
  return next;
end;
$fn$;

revoke all on function public._apply_delivery_zone(uuid, uuid, text) from public, authenticated, anon;

-- ----------------------------------------------------------------------------
-- A3. Agent submits an actual-zone change (offline-queued; idempotent).
-- ----------------------------------------------------------------------------
create or replace function public.agent_change_delivery_location(
  p_client_uuid text,
  p_delivery_id uuid,
  p_location_id uuid,
  p_reason      text
)
returns jsonb
language plpgsql security definer set search_path to 'public', 'auth'
as $fn$
declare
  v_actor       uuid := auth.uid();
  v_role        text := public.current_user_role();
  v_d           public.deliveries%rowtype;
  v_ineligible  boolean;
  v_to_charged  numeric;
  v_to_agent    numeric;
  v_auto        boolean;
  v_state       text;
  v_settled     boolean;
  v_change_id   uuid;
  v_existing    public.delivery_location_changes%rowtype;
begin
  if v_actor is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_client_uuid is null or btrim(p_client_uuid) = '' then
    raise exception 'client_uuid required' using errcode = '23514';
  end if;
  if p_location_id is null then raise exception 'a target zone is required' using errcode = '22023'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason required' using errcode = '22023'; end if;

  -- Idempotency (queue retries): same client_uuid -> return the recorded outcome.
  select * into v_existing from public.delivery_location_changes where client_uuid = p_client_uuid limit 1;
  if found then
    return jsonb_build_object('outcome', v_existing.state, 'change_id', v_existing.id, 'idempotent', true);
  end if;

  select * into v_d from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002'; end if;
  if v_d.deleted_at is not null then raise exception 'delivery has been deleted' using errcode = '22023'; end if;

  -- Ownership: the assigned agent, their own row. Ops use the manager RPCs.
  if not (v_role = 'agent' and v_d.assigned_agent_id = v_actor) then
    raise exception 'permission denied: only the assigned agent can change their delivery zone'
      using errcode = '42501';
  end if;

  -- Eligibility: non-terminal OR delivered; reject other terminals + deleted.
  select (sd.category = 'terminal' and v_d.current_status <> 'delivered')
    into v_ineligible
    from public.delivery_status_defs sd where sd.status = v_d.current_status;
  if coalesce(v_ineligible, false) then
    raise exception 'cannot change the zone of a % order', v_d.current_status using errcode = '22023';
  end if;

  if p_location_id = v_d.location_id then
    raise exception 'zone is unchanged' using errcode = '22023';
  end if;

  if exists (select 1 from public.delivery_location_changes
              where delivery_id = p_delivery_id and state = 'pending') then
    raise exception 'a zone change for this order is already awaiting approval' using errcode = '22023';
  end if;

  -- New rate (bonus baked in via the assigned agent).
  select er.charged, er.agent_payment
    into v_to_charged, v_to_agent
    from public.effective_rate(p_location_id, v_d.client_id, v_d.assigned_agent_id) er;
  if v_to_charged is null then
    raise exception
      'no active rate card for (location=%, client=%); cannot change the zone',
      p_location_id, v_d.client_id
      using errcode = '22023',
            hint   = 'add a rate_card row for this location/client first';
  end if;

  -- Decision: first-time set (no prior zone/pay), or agent pay NOT increasing
  -- -> auto-apply. Otherwise hold for a manager.
  v_auto := (v_d.location_id is null)
         or (v_d.agent_payment_snapshot is null)
         or (v_to_agent <= v_d.agent_payment_snapshot);

  -- Settled-day drift: is the delivery's scheduled_date already settled for the
  -- client OR the agent (non-voided)?
  select exists (
    select 1 from public.settlements s
     where s.voided_at is null
       and s.period_date = v_d.scheduled_date
       and ( (s.subject_type = 'client' and s.subject_id = v_d.client_id)
          or (s.subject_type = 'agent'  and s.subject_id = v_d.assigned_agent_id) )
  ) into v_settled;

  if v_auto then
    perform public._apply_delivery_zone(
      p_delivery_id, p_location_id,
      'agent_location_change:applied'
        || case when v_settled then ' [settled-day drift]' else '' end
        || ' -- ' || btrim(p_reason));
    v_state := 'applied';
  else
    v_state := 'pending';   -- delivery left untouched until a manager approves
  end if;

  insert into public.delivery_location_changes (
    client_uuid, delivery_id, requested_by_agent_id,
    from_location_id, to_location_id, from_charged, from_agent_payment,
    to_charged, to_agent_payment, reason, state
  ) values (
    p_client_uuid, p_delivery_id, v_actor,
    v_d.location_id, p_location_id, v_d.charged_snapshot, v_d.agent_payment_snapshot,
    v_to_charged, v_to_agent, btrim(p_reason), v_state
  ) returning id into v_change_id;

  -- Notify managers when held for approval, OR when an auto-apply lands on an
  -- already-settled day (the only auto-apply case that pushes).
  if v_state = 'pending' or v_settled then
    perform public.send_edge_notification(jsonb_build_object(
      'audience', 'managers',
      'title',    case when v_state = 'pending'
                       then 'Zone change needs approval'
                       else 'Zone changed on a settled day' end,
      'body',     coalesce(v_d.customer_name, 'A delivery')
                    || case when v_state = 'pending'
                            then ' — agent zone change raises pay; approve to apply'
                            else ' — agent auto-changed zone on a settled day' end,
      'data',     jsonb_build_object('delivery_id', p_delivery_id,
                                     'change_id', v_change_id,
                                     'route', 'location_approvals')
    ));
  end if;

  return jsonb_build_object('outcome', v_state, 'change_id', v_change_id, 'settled', v_settled);

exception
  when unique_violation then
    -- Two unique constraints collapse here: (a) idempotent replay of the SAME
    -- client_uuid, or (b) a concurrent SECOND pending request for this delivery
    -- hitting dlc_one_open_per_delivery. The implicit savepoint already rolled
    -- back any apply done in this block. If our client_uuid row exists it's (a)
    -- -> return its outcome; otherwise it's (b) -> a clean "already pending" error
    -- (NOT a bogus silent success that drops the agent's queued job).
    select * into v_existing from public.delivery_location_changes where client_uuid = p_client_uuid limit 1;
    if found then
      return jsonb_build_object('outcome', v_existing.state,
                                'change_id', v_existing.id, 'idempotent', true);
    end if;
    raise exception 'a zone change for this order is already awaiting approval'
      using errcode = '22023';
end;
$fn$;

grant execute on function public.agent_change_delivery_location(text, uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- A4. Manager actions (direct/online): approve / reject / revert.
-- ----------------------------------------------------------------------------
create or replace function public.approve_location_change(
  p_change_id uuid,
  p_reason    text default null
)
returns void
language plpgsql security definer set search_path to 'public', 'auth'
as $fn$
declare
  v_actor      uuid := auth.uid();
  v_c          public.delivery_location_changes%rowtype;
  v_d          public.deliveries%rowtype;
  v_ineligible boolean;
begin
  if not public.is_manager() then
    raise exception 'permission denied: approving a zone change requires admin or dispatcher'
      using errcode = '42501';
  end if;

  select * into v_c from public.delivery_location_changes where id = p_change_id for update;
  if not found then raise exception 'change not found: %', p_change_id using errcode = 'P0002'; end if;
  if v_c.state <> 'pending' then
    raise exception 'this change is already % and cannot be approved', v_c.state using errcode = '22023';
  end if;

  select * into v_d from public.deliveries where id = v_c.delivery_id for update;

  -- The delivery may have moved on while the request was pending.
  select (sd.category = 'terminal' and v_d.current_status <> 'delivered')
    into v_ineligible
    from public.delivery_status_defs sd where sd.status = v_d.current_status;
  v_ineligible := coalesce(v_ineligible, false) or (v_d.deleted_at is not null);

  if v_ineligible then
    update public.delivery_location_changes
       set state = 'rejected', decided_by_user_id = v_actor, decided_at = now(),
           reason = reason || ' | auto-rejected on approval: delivery no longer eligible ('
                            || v_d.current_status || ')'
     where id = p_change_id;
    perform public.send_edge_notification(jsonb_build_object(
      'audience', 'user', 'user_id', v_c.requested_by_agent_id::text,
      'title', 'Zone change not applied',
      'body',  'The order changed status before approval, so the zone change was not applied.',
      'data',  jsonb_build_object('delivery_id', v_c.delivery_id)));
    return;
  end if;

  -- Recompute at approval time (client/agent may have changed) and apply.
  perform public._apply_delivery_zone(
    v_c.delivery_id, v_c.to_location_id,
    'agent_location_change:approved -- ' || coalesce(btrim(p_reason), ''));

  update public.delivery_location_changes
     set state = 'approved', decided_by_user_id = v_actor, decided_at = now()
   where id = p_change_id;

  perform public.send_edge_notification(jsonb_build_object(
    'audience', 'user', 'user_id', v_c.requested_by_agent_id::text,
    'title', 'Zone change approved',
    'body',  'Your delivery zone change was approved.',
    'data',  jsonb_build_object('delivery_id', v_c.delivery_id)));
end;
$fn$;

create or replace function public.reject_location_change(
  p_change_id uuid,
  p_reason    text
)
returns void
language plpgsql security definer set search_path to 'public', 'auth'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_c     public.delivery_location_changes%rowtype;
begin
  if not public.is_manager() then
    raise exception 'permission denied: rejecting a zone change requires admin or dispatcher'
      using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required to reject' using errcode = '22023';
  end if;

  select * into v_c from public.delivery_location_changes where id = p_change_id for update;
  if not found then raise exception 'change not found: %', p_change_id using errcode = 'P0002'; end if;
  if v_c.state <> 'pending' then
    raise exception 'this change is already % and cannot be rejected', v_c.state using errcode = '22023';
  end if;

  update public.delivery_location_changes
     set state = 'rejected', decided_by_user_id = v_actor, decided_at = now(),
         reason = reason || ' | rejected: ' || btrim(p_reason)
   where id = p_change_id;

  perform public.send_edge_notification(jsonb_build_object(
    'audience', 'user', 'user_id', v_c.requested_by_agent_id::text,
    'title', 'Zone change rejected',
    'body',  'Your delivery zone change was not approved.',
    'data',  jsonb_build_object('delivery_id', v_c.delivery_id)));
end;
$fn$;

create or replace function public.revert_location_change(
  p_change_id uuid,
  p_reason    text
)
returns void
language plpgsql security definer set search_path to 'public', 'auth'
as $fn$
declare
  v_actor uuid := auth.uid();
  v_c     public.delivery_location_changes%rowtype;
  v_d     public.deliveries%rowtype;
begin
  if not public.is_manager() then
    raise exception 'permission denied: reverting a zone change requires admin or dispatcher'
      using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required to revert' using errcode = '22023';
  end if;

  select * into v_c from public.delivery_location_changes where id = p_change_id for update;
  if not found then raise exception 'change not found: %', p_change_id using errcode = 'P0002'; end if;
  if v_c.state not in ('applied', 'approved') then
    raise exception 'only an applied or approved change can be reverted (state=%)', v_c.state
      using errcode = '22023';
  end if;
  if v_c.from_location_id is null then
    raise exception 'cannot revert to an unset zone on this order; use admin location correction instead'
      using errcode = '22023';
  end if;

  select * into v_d from public.deliveries where id = v_c.delivery_id for update;
  if not found then raise exception 'delivery not found' using errcode = 'P0002'; end if;

  -- Don't clobber a newer change: only revert when the delivery is STILL on the
  -- zone this change applied. If a later change/correction moved it on, reverting
  -- to from_* would silently overwrite that newer state.
  if v_d.location_id is distinct from v_c.to_location_id then
    raise exception
      'this delivery has since moved to a different zone; revert no longer applies'
      using errcode = '22023';
  end if;

  -- True undo: write the stored from_* values exactly (no recompute), so it
  -- restores the original even if the rate card changed meanwhile.
  update public.deliveries
     set location_id            = v_c.from_location_id,
         charged_snapshot       = v_c.from_charged,
         agent_payment_snapshot = v_c.from_agent_payment,
         updated_at             = now()
   where id = v_c.delivery_id;

  perform public.write_audit(
    p_entity_type := 'delivery',
    p_entity_id   := v_c.delivery_id,
    p_old := jsonb_build_object(
      'location_id',            v_d.location_id,
      'charged_snapshot',       v_d.charged_snapshot,
      'agent_payment_snapshot', v_d.agent_payment_snapshot
    ),
    p_new := jsonb_build_object(
      'location_id',            v_c.from_location_id,
      'charged_snapshot',       v_c.from_charged,
      'agent_payment_snapshot', v_c.from_agent_payment
    ),
    p_reason   := 'agent_location_change:reverted -- ' || btrim(p_reason),
    p_actor_id := v_actor
  );

  update public.delivery_location_changes
     set state = 'reverted', decided_by_user_id = v_actor, decided_at = now()
   where id = p_change_id;

  perform public.send_edge_notification(jsonb_build_object(
    'audience', 'user', 'user_id', v_c.requested_by_agent_id::text,
    'title', 'Zone change reverted',
    'body',  'A manager reverted your delivery zone change.',
    'data',  jsonb_build_object('delivery_id', v_c.delivery_id)));
end;
$fn$;

grant execute on function public.approve_location_change(uuid, text) to authenticated;
grant execute on function public.reject_location_change(uuid, text)  to authenticated;
grant execute on function public.revert_location_change(uuid, text)  to authenticated;

-- ----------------------------------------------------------------------------
-- A5. Manager read: list zone changes (joined for the approvals screen + badge).
--     Returns rows only to managers (mirrors list_settlements_for_date's
--     `where is_admin_or_dispatcher()` self-gating pattern). p_states null = all.
-- ----------------------------------------------------------------------------
create or replace function public.list_location_changes(p_states text[] default null)
returns table(
  change_id          uuid,
  delivery_id        uuid,
  state              text,
  customer_name      text,
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
language sql security definer set search_path to 'public', 'auth' stable
as $fn$
  select c.id, c.delivery_id, c.state,
         d.customer_name, d.current_status, d.scheduled_date,
         c.requested_by_agent_id, u.display_name,
         c.from_location_id, fl.name, c.to_location_id, tl.name,
         c.from_charged, c.to_charged, c.from_agent_payment, c.to_agent_payment,
         c.reason, c.created_at, c.decided_at
    from public.delivery_location_changes c
    join public.deliveries d  on d.id  = c.delivery_id
    left join public.users u  on u.id  = c.requested_by_agent_id
    left join public.locations fl on fl.id = c.from_location_id
    left join public.locations tl on tl.id = c.to_location_id
   where public.is_manager()
     and (p_states is null or c.state = any(p_states))
   order by c.created_at desc
   limit 200;
$fn$;

grant execute on function public.list_location_changes(text[]) to authenticated;
