-- "Left the warehouse" — a per-agent, per-day departure signal so ops
-- (warehouse / dispatcher / rep) can see at a glance which riders are already
-- out on the road, and stop (a) asking, (b) assigning fresh orders to someone
-- who has left, or (c) relaying vendor messages to a rider who can't act on them.
--
-- Design: one row per (agent, Lagos-day). Keyed by depart_date, so it
-- self-resets every day — no cron, no mutable flag on the shared users table.
-- Writes go ONLY through set_left_warehouse() (SECURITY DEFINER); the table
-- grants direct SELECT only, and RLS gates who can read which rows. Extends
-- cleanly later (e.g. a returned_at column) without reworking callers.

create table if not exists public.agent_departures (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references public.users(id) on delete cascade,
  depart_date  date not null,                              -- Lagos day (= deliveries.scheduled_date)
  departed_at  timestamptz not null default now(),
  departed_by  uuid references public.users(id),           -- normally the agent; may be an ops user acting for them
  created_at   timestamptz not null default now(),
  unique (agent_id, depart_date)                           -- one departure per agent per day (idempotent)
);

-- Covers the ops "who left today" read (depart_date filter) and the unique key.
create index if not exists idx_agent_departures_date on public.agent_departures (depart_date, agent_id);

alter table public.agent_departures enable row level security;

-- Reads: all ops (admin+dispatcher+rep via is_admin_or_dispatcher, + warehouse)
-- see every agent's row; an agent sees only their own. No INSERT/UPDATE/DELETE
-- policy on purpose — mutations must go through set_left_warehouse().
drop policy if exists agent_departures_select on public.agent_departures;
create policy agent_departures_select on public.agent_departures
  for select
  using (public.is_admin_or_dispatcher() or public.is_warehouse() or agent_id = auth.uid());

-- Lock down direct table access: read-only for signed-in users; writes flow
-- through the SECURITY DEFINER RPC below (which runs as owner and bypasses RLS).
revoke all on public.agent_departures from anon, authenticated;
grant select on public.agent_departures to authenticated;

-- ---------------------------------------------------------------------------
-- set_left_warehouse(p_left, p_agent_id) — toggle today's departure for an agent.
--   p_left = true  -> mark departed (idempotent; keeps the first departure time)
--   p_left = false -> undo (delete today's row) — for a mistaken tap / returned
-- p_agent_id defaults to the caller. An agent may only toggle themselves; ops
-- (admin/dispatcher/warehouse) may toggle any agent on their behalf.
-- ---------------------------------------------------------------------------
create or replace function public.set_left_warehouse(
  p_left     boolean,
  p_agent_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'auth'
as $fn$
declare
  v_actor       uuid := auth.uid();
  v_role        text := public.current_user_role();
  v_target      uuid := coalesce(p_agent_id, v_actor);
  v_target_role text;
  v_date        date := (now() at time zone 'Africa/Lagos')::date;
  v_departed_at timestamptz;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select role into v_target_role from public.users where id = v_target;
  if v_target_role is null then
    raise exception 'agent not found' using errcode = 'P0002';
  end if;
  if v_target_role <> 'agent' then
    raise exception 'only agents can be marked as having left the warehouse' using errcode = '23514';
  end if;

  -- Caller must be the agent themselves, or an ops user acting on their behalf.
  if not (
    (v_actor = v_target and v_role = 'agent')
    or public.is_admin_or_dispatcher()
    or public.is_warehouse()
  ) then
    raise exception 'permission denied: cannot change this agent''s warehouse status'
      using errcode = '42501';
  end if;

  if p_left then
    insert into public.agent_departures (agent_id, depart_date, departed_at, departed_by)
    values (v_target, v_date, now(), v_actor)
    on conflict (agent_id, depart_date) do nothing;   -- keep the earliest departure time

    select departed_at into v_departed_at
      from public.agent_departures
     where agent_id = v_target and depart_date = v_date;

    perform public.write_audit(
      'agent_departure', v_target, null,
      jsonb_build_object('depart_date', v_date, 'departed_at', v_departed_at, 'departed_by', v_actor),
      'left the warehouse', v_actor
    );
    return jsonb_build_object('left', true, 'depart_date', v_date, 'departed_at', v_departed_at);
  else
    delete from public.agent_departures where agent_id = v_target and depart_date = v_date;

    perform public.write_audit(
      'agent_departure', v_target,
      jsonb_build_object('depart_date', v_date), null,
      'undo left the warehouse', v_actor
    );
    return jsonb_build_object('left', false, 'depart_date', v_date);
  end if;
end;
$fn$;

revoke all on function public.set_left_warehouse(boolean, uuid) from public;
grant execute on function public.set_left_warehouse(boolean, uuid) to authenticated;
