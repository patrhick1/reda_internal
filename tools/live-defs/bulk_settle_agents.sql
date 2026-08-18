-- ============================================================================
-- Bulk agent handover settlements
-- ============================================================================
-- Records several rider cash handovers as one admin action. The function calls
-- settle_period for every rider inside one PostgreSQL transaction, so a stale or
-- invalid rider makes the whole batch fail instead of leaving a partial handover.
-- A caller-provided request UUID makes an ambiguous network retry idempotent.
--
-- Apply after scripts/settlement-period-lock.sql. Idempotent.
-- ============================================================================

begin;

create table if not exists public.settlement_batches (
  id                  uuid primary key,
  period_date         date not null,
  agent_ids           uuid[] not null,
  note                text,
  settled_by          uuid not null references public.users(id),
  result              jsonb not null,
  created_at          timestamptz not null default now(),
  constraint settlement_batches_agent_ids_nonempty
    check (cardinality(agent_ids) > 0)
);

comment on table public.settlement_batches is
  'Idempotency and grouping record for atomic bulk agent handover settlements.';

alter table public.settlement_batches enable row level security;
revoke all on public.settlement_batches from authenticated, anon;
-- Deliberately no direct client policy or grant. Reads and writes are RPC-only.

create or replace function public.bulk_settle_agents(
  p_request_id uuid,
  p_agent_ids uuid[],
  p_period_date date,
  p_note text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'auth'
as $function$
declare
  v_actor uuid := auth.uid();
  v_agent_ids uuid[];
  v_note text := nullif(btrim(p_note), '');
  v_batch public.settlement_batches%rowtype;
  v_inserted boolean := false;
  v_agent_id uuid;
  v_settlement_id uuid;
  v_expected numeric;
  v_total numeric := 0;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_invalid_count integer;
begin
  if not public.is_admin() then
    raise exception 'only admin can record handovers' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id required' using errcode = '23514';
  end if;
  if p_period_date is null then
    raise exception 'period_date required' using errcode = '23514';
  end if;
  if p_agent_ids is null or cardinality(p_agent_ids) = 0 then
    raise exception 'select at least one agent' using errcode = '23514';
  end if;
  if cardinality(p_agent_ids) > 100 then
    raise exception 'a handover batch can contain at most 100 agents'
      using errcode = '22023';
  end if;

  -- Canonical ordering makes retries comparable regardless of UI ordering.
  select array_agg(agent_id order by agent_id)
    into v_agent_ids
    from (
      select distinct candidate as agent_id
        from unnest(p_agent_ids) as requested(candidate)
       where candidate is not null
    ) canonical;

  if cardinality(v_agent_ids) is distinct from cardinality(p_agent_ids) then
    raise exception 'agent_ids cannot contain nulls or duplicates'
      using errcode = '23514';
  end if;

  select count(*)
    into v_invalid_count
    from unnest(v_agent_ids) requested(agent_id)
    left join public.users u
      on u.id = requested.agent_id
     and u.role = 'agent'
   where u.id is null;
  if v_invalid_count > 0 then
    raise exception 'one or more selected users are not agents'
      using errcode = '22023';
  end if;

  -- Claim this request UUID before doing money work. ON CONFLICT makes a retry
  -- wait for the first transaction, then return that transaction's saved result.
  insert into public.settlement_batches(
    id, period_date, agent_ids, note, settled_by, result
  ) values (
    p_request_id, p_period_date, v_agent_ids, v_note, v_actor, '{}'::jsonb
  )
  on conflict (id) do nothing
  returning true into v_inserted;

  if not coalesce(v_inserted, false) then
    select * into v_batch
      from public.settlement_batches
     where id = p_request_id;

    if v_batch.settled_by is distinct from v_actor
       or v_batch.period_date is distinct from p_period_date
       or v_batch.agent_ids is distinct from v_agent_ids
       or v_batch.note is distinct from v_note then
      raise exception 'request_id was already used for a different handover batch'
        using errcode = '22023';
    end if;

    return v_batch.result;
  end if;

  if exists (
    select 1
      from public.settlements s
     where s.subject_type = 'agent'
       and s.subject_id = any(v_agent_ids)
       and s.period_date = p_period_date
       and s.voided_at is null
  ) then
    raise exception 'one or more selected agents are already handed over; refresh and try again'
      using errcode = '23505';
  end if;

  foreach v_agent_id in array v_agent_ids loop
    -- settle_period remains the single source of truth for delivery and
    -- replacement accounting, snapshots, permissions and per-settlement audit.
    v_settlement_id := public.settle_period('agent', v_agent_id, p_period_date, v_note);

    select expected_amount
      into v_expected
      from public.settlements
     where id = v_settlement_id;

    if v_expected is null or v_expected <= 0 then
      raise exception 'agent % has no positive amount to hand over for %',
        v_agent_id, p_period_date
        using errcode = '22023';
    end if;

    v_total := v_total + v_expected;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'agent_id', v_agent_id,
      'settlement_id', v_settlement_id,
      'expected_amount', v_expected
    ));
  end loop;

  v_result := jsonb_build_object(
    'batch_id', p_request_id,
    'settled_count', cardinality(v_agent_ids),
    'expected_amount', v_total,
    'settlements', v_results
  );

  update public.settlement_batches
     set result = v_result
   where id = p_request_id;

  perform public.write_audit(
    'settlement_batch', p_request_id, null,
    jsonb_build_object(
      'period_date', p_period_date,
      'agent_ids', to_jsonb(v_agent_ids),
      'settled_count', cardinality(v_agent_ids),
      'expected_amount', v_total,
      'note', v_note
    ),
    'bulk_settle_agents'
  );

  return v_result;
end;
$function$;

-- Self-hosted Supabase grants new functions to anon through default
-- privileges, so revoke both the implicit PUBLIC grant and anon explicitly.
revoke all on function public.bulk_settle_agents(uuid, uuid[], date, text) from public, anon;
grant execute on function public.bulk_settle_agents(uuid, uuid[], date, text) to authenticated;

commit;
