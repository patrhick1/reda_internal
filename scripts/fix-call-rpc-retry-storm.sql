-- Fix: the call RPCs raised PERMANENT business rejections with SQLSTATE 40001.
--
-- 40001 is serialization_failure -- the standard "two transactions collided,
-- nothing is wrong, just try again" code. PostgREST honours that contract and
-- retries. But these conditions are permanent (the call already ended), so the
-- retry failed identically and looped FOREVER.
--
-- Measured on the live box 2026-07-30, via tcpdump of the PostgREST<->Postgres
-- wire protocol -- a 3 second capture held 7,300 copies of:
--
--   ERROR  SQLSTATE 40001
--   "call not available to cancel (wrong caller, wrong state, or already ended)."
--   PL/pgSQL function cancel_call(uuid) line 19 at RAISE
--
-- Blast radius at the time of the fix:
--   * 2,745 rollbacks/sec against 14 commits/sec -- 99.5% of ALL transactions
--     on this database were failures. Lifetime: 782M rollbacks vs 7.8M commits.
--   * 5 distinct call_ids each looping; the oldest had been retrying for
--     3 days 5 hours -- exactly as long as its connection had been open.
--   * 5-6 of PostgREST's 10 pool connections permanently pinned, so the whole
--     app ran on half a pool and every request queued behind the loops.
--   * ~14 MB/s of pointless traffic (each retry ships the full JWT claims
--     JSON to Postgres and gets it echoed back).
--
-- It stayed invisible because log_min_messages=fatal suppressed every ERROR.
--
-- TWO changes per function:
--
-- 1. Permanent rejections now raise 55000 (object_not_in_prerequisite_state),
--    which nothing retries. This alone makes the infinite loop impossible.
-- 2. The terminal-state operations became IDEMPOTENT. Cancelling/ending/
--    declining a call that is already over is what a user does by reflex
--    (hanging up twice); it should be a silent no-op returning the row, not an
--    error. accept_call is only idempotent for the SAME user on the SAME
--    device -- a second ops user grabbing a taken team call must still be told.
--
-- Message wording is preserved verbatim where the client matches on it:
-- app/(call)/team.tsx keys on msg.includes('ringing call').
--
-- Apply on the LIVE box:
--   docker exec -i supabase-db psql -U postgres -d postgres < fix-call-rpc-retry-storm.sql

BEGIN;

-- ── cancel_call ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_call(p_call_id uuid)
 RETURNS calls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user uuid := auth.uid();
  v_row  public.calls%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  update public.calls
     set status   = 'cancelled',
         ended_at = now()
   where id        = p_call_id
     and caller_id = v_user
     and status    = 'ringing'
   returning * into v_row;

  if found then
    perform public.write_audit(
      'call', v_row.id,
      jsonb_build_object('status', 'ringing'),
      jsonb_build_object('status', 'cancelled', 'ended_at', v_row.ended_at),
      'cancelled by caller',
      v_user
    );
    return v_row;
  end if;

  select * into v_row from public.calls where id = p_call_id;
  if not found then
    raise exception 'call not found' using errcode = 'P0002';
  end if;

  -- Already over, and it was this user's call to cancel -> no-op success.
  if v_row.caller_id = v_user
     and v_row.status in ('cancelled','declined','missed','completed','failed') then
    return v_row;
  end if;

  raise exception 'call not available to cancel (wrong caller, or call already in progress)'
    using errcode = '55000';
end $function$;

-- ── end_call ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.end_call(p_call_id uuid)
 RETURNS calls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user uuid := auth.uid();
  v_row  public.calls%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  update public.calls
     set status           = 'completed',
         ended_at         = now(),
         duration_seconds = greatest(0,
           extract(epoch from (now() - started_at))::int
         )
   where id      = p_call_id
     and status  = 'accepted'
     and (caller_id = v_user or callee_id = v_user)
   returning * into v_row;

  if found then
    perform public.write_audit(
      'call', v_row.id,
      jsonb_build_object('status', 'accepted'),
      jsonb_build_object(
        'status',           'completed',
        'ended_at',         v_row.ended_at,
        'duration_seconds', v_row.duration_seconds
      ),
      'ended by ' || (case when v_row.caller_id = v_user then 'caller' else 'callee' end),
      v_user
    );
    return v_row;
  end if;

  select * into v_row from public.calls where id = p_call_id;
  if not found then
    raise exception 'call not found' using errcode = 'P0002';
  end if;

  -- Participant hanging up a call that already ended -> no-op success.
  if (v_row.caller_id = v_user or v_row.callee_id = v_user)
     and v_row.status in ('cancelled','declined','missed','completed','failed') then
    return v_row;
  end if;

  raise exception 'call not available to end (not a participant, or call is not in progress)'
    using errcode = '55000';
end $function$;

-- ── decline_call ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decline_call(p_call_id uuid, p_reason text)
 RETURNS calls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user uuid := auth.uid();
  v_row  public.calls%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  update public.calls
     set status   = 'declined',
         ended_at = now()
   where id              = p_call_id
     and callee_id       = v_user
     and status          = 'ringing'
     and callee_audience = 'user'
   returning * into v_row;

  if found then
    perform public.write_audit(
      'call', v_row.id,
      jsonb_build_object('status', 'ringing'),
      jsonb_build_object('status', 'declined', 'ended_at', v_row.ended_at),
      coalesce(nullif(trim(coalesce(p_reason,'')), ''), 'declined by callee'),
      v_user
    );
    return v_row;
  end if;

  select * into v_row from public.calls where id = p_call_id;
  if not found then
    raise exception 'call not found' using errcode = 'P0002';
  end if;

  -- Callee dismissing a call that already ended (caller gave up first,
  -- ring-timeout fired, double-tap on Decline) -> no-op success.
  if v_row.callee_id = v_user
     and v_row.status in ('cancelled','declined','missed','completed','failed') then
    return v_row;
  end if;

  raise exception 'call not available to decline (wrong callee, wrong audience, or call already answered)'
    using errcode = '55000';
end $function$;

-- ── accept_call ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.accept_call(p_call_id uuid, p_device_uuid uuid)
 RETURNS calls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_user uuid := auth.uid();
  v_aud  text;
  v_row  public.calls%rowtype;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_device_uuid is null then
    raise exception 'p_device_uuid is required' using errcode = '22023';
  end if;

  -- Lockless read just to pick the right gate. The UPDATE below is the
  -- actual race guard.
  select callee_audience into v_aud
    from public.calls where id = p_call_id;
  if v_aud is null then
    raise exception 'call not found' using errcode = 'P0002';
  end if;

  if v_aud = 'user' then
    -- 1:1 path. Only the named callee can flip ringing → accepted.
    update public.calls
       set status               = 'accepted',
           accepted_device_uuid = p_device_uuid,
           started_at           = now()
     where id              = p_call_id
       and callee_id       = v_user
       and status          = 'ringing'
       and callee_audience = 'user'
     returning * into v_row;
  else
    -- ops_team path. Any ops user races to grab the row; whoever's UPDATE
    -- wins atomically assigns callee_id=themselves and normalizes
    -- callee_audience to 'user' so the invariant continues to hold and
    -- the rest of the call lifecycle treats this row identically to a 1:1.
    update public.calls
       set status               = 'accepted',
           accepted_device_uuid = p_device_uuid,
           started_at           = now(),
           callee_id            = v_user,
           callee_audience      = 'user'
     where id              = p_call_id
       and status          = 'ringing'
       and callee_id is null
       and callee_audience = 'ops_team'
       and public.is_admin_or_dispatcher()
     returning * into v_row;
  end if;

  if found then
    perform public.write_audit(
      'call', v_row.id,
      jsonb_build_object('status', 'ringing'),
      jsonb_build_object(
        'status',               'accepted',
        'accepted_device_uuid', p_device_uuid,
        'callee_id',            v_row.callee_id,
        'started_at',           v_row.started_at
      ),
      case when v_aud = 'ops_team' then 'team call accepted by ops user' else 'accepted by callee' end,
      v_user
    );
    return v_row;
  end if;

  -- Deliberately NARROW idempotency: only the same user re-accepting on the
  -- same device (a retried request). A different ops user arriving late at a
  -- team call that someone else grabbed must still be told it is taken.
  select * into v_row from public.calls where id = p_call_id;
  if v_row.status = 'accepted'
     and v_row.callee_id = v_user
     and v_row.accepted_device_uuid = p_device_uuid then
    return v_row;
  end if;

  raise exception 'call not available to accept (wrong callee, wrong role, wrong state, or already accepted)'
    using errcode = '55000';
end $function$;

-- ── initiate_call ──────────────────────────────────────────────────────────
-- Only the final RAISE changes (40001 -> 55000). The "ringing call" wording is
-- load-bearing: app/(call)/team.tsx matches on it to show a friendly message.
CREATE OR REPLACE FUNCTION public.initiate_call(p_callee_id uuid, p_caller_device_uuid uuid, p_related_delivery_id uuid, p_client_uuid uuid, p_callee_audience text DEFAULT 'user'::text)
 RETURNS calls
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_caller   uuid := auth.uid();
  v_role     text;
  v_active   boolean;
  v_existing public.calls%rowtype;
  v_new      public.calls%rowtype;
begin
  if v_caller is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if p_caller_device_uuid is null then
    raise exception 'p_caller_device_uuid is required' using errcode = '22023';
  end if;
  if p_callee_audience not in ('user','ops_team') then
    raise exception 'invalid p_callee_audience: %', p_callee_audience using errcode = '22023';
  end if;

  -- Audience-specific input shape.
  if p_callee_audience = 'user' then
    if p_callee_id is null then
      raise exception 'p_callee_id is required for user audience' using errcode = '22023';
    end if;
    if v_caller = p_callee_id then
      raise exception 'cannot call yourself' using errcode = '22023';
    end if;
  else
    if p_callee_id is not null then
      raise exception 'p_callee_id must be null for ops_team audience' using errcode = '22023';
    end if;
  end if;

  -- Caller must be active. Role gate: agents may only call the team.
  select role, is_active into v_role, v_active
    from public.users where id = v_caller;
  if not coalesce(v_active, false) then
    raise exception 'caller is not an active user' using errcode = '42501';
  end if;
  if v_role = 'agent' and p_callee_audience <> 'ops_team' then
    raise exception 'agents may only place team calls' using errcode = '42501';
  end if;

  -- Idempotency: same client_uuid → return prior row.
  if p_client_uuid is not null then
    select * into v_existing from public.calls where client_uuid = p_client_uuid;
    if found then return v_existing; end if;
  end if;

  -- For user audience, callee must exist and be active.
  if p_callee_audience = 'user' then
    select is_active into v_active from public.users where id = p_callee_id;
    if not coalesce(v_active, false) then
      raise exception 'callee is not an active user' using errcode = '42501';
    end if;
  end if;

  -- Optional delivery FK must resolve to a real, non-deleted row.
  if p_related_delivery_id is not null then
    if not exists (
      select 1 from public.deliveries
       where id = p_related_delivery_id and deleted_at is null
    ) then
      raise exception 'related delivery not found' using errcode = 'P0002';
    end if;
  end if;

  begin
    insert into public.calls (
      caller_id, callee_id, callee_audience, caller_device_uuid,
      status, related_delivery_id, client_uuid, ringing_until
    ) values (
      v_caller, p_callee_id, p_callee_audience, p_caller_device_uuid,
      'ringing', p_related_delivery_id, p_client_uuid,
      now() + interval '45 seconds'
    ) returning * into v_new;
  exception when unique_violation then
    -- calls_one_ringing_per_caller or _per_callee partial unique index.
    raise exception 'caller or callee already has a ringing call'
      using errcode = '55000';
  end;

  perform public.write_audit(
    'call', v_new.id,
    null,
    jsonb_build_object(
      'status',              'ringing',
      'caller_id',           v_caller,
      'callee_id',           p_callee_id,
      'callee_audience',     p_callee_audience,
      'related_delivery_id', p_related_delivery_id
    ),
    case when p_callee_audience = 'ops_team' then 'team-call initiated' else 'initiated by caller' end,
    v_caller
  );

  return v_new;
end $function$;

COMMIT;

-- ── Turn the alarm back on (run as supabase_admin, NOT postgres) ───────────
-- log_min_messages was 'fatal', set on the postgres COMMAND LINE in
-- docker-compose. That suppressed every ERROR on this box -- which is why a
-- runaway throwing 2,400 errors/sec left a completely clean log for weeks.
--
-- ALTER SYSTEM cannot fix it (command line outranks postgresql.auto.conf), and
-- the `postgres` role is not a superuser on self-hosted Supabase. A per-database
-- setting IS applied at connection time and does outrank the command line:
--
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     -c "ALTER DATABASE postgres SET log_min_messages = 'warning';"
--
-- Applied 2026-07-30. Takes effect for NEW sessions; persists across restarts
-- (it lives in pg_db_role_setting, not a config file). Only covers the
-- `postgres` database -- `_supabase` is still at fatal, which is fine, nothing
-- application-facing runs there.

-- ── Verification ───────────────────────────────────────────────────────────
-- No function should raise a retryable SQLSTATE for a permanent condition:
--   SELECT proname FROM pg_proc
--   WHERE pronamespace='public'::regnamespace AND prokind='f'
--     AND pg_get_functiondef(oid) ~ $q$errcode\s*=\s*'40001'$q$;
--   -- expect 0 rows
--
-- Commit/rollback ratio should invert (was 14 commits/s vs 2,745 rollbacks/s):
--   SELECT sum(xact_commit), sum(xact_rollback) FROM pg_stat_database;
