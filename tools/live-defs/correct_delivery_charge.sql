-- ============================================================================
-- correct_delivery_charge — admin manual override of a delivery's snapshotted
-- Reda charge and/or agent payout. Paste-and-run as ONE script in the Supabase
-- SQL editor.
--
-- Why: snapshots are frozen from the rate card (with the client ceiling) at
-- create time and are only ever recomputed by a location/rate change. When a
-- client charge cap is set below a location's agent payout, the cap clamps the
-- charge but never the agent fee, so the row lands with a NEGATIVE margin
-- (charged_snapshot < agent_payment_snapshot). Those rows surface in the
-- admin "Negative margin" review list (deliveries_admin.margin < 0); this RPC
-- is how Uzo corrects the numbers during review.
--
-- Self-healing: the review list is a pure `margin < 0` filter, so once the
-- corrected snapshots make margin >= 0 the row simply drops off the list —
-- there is no separate "resolved" flag to clear.
--
-- Allowed on any status EXCEPT where it would desync a frozen settlement: a
-- settlement (settle_period) freezes the figures for a (subject, scheduled_date)
-- into settlements.snapshot and that money is remitted. Editing a snapshot whose
-- side is already settled would make the live reconcile view diverge from what
-- was paid. So we block, per side, exactly what's frozen:
--   * changing charged_snapshot       -> blocked if the CLIENT day is settled
--   * changing agent_payment_snapshot -> blocked if the AGENT day is settled
-- (mirrors settle_period's own "void the existing settlement first" contract).
-- An unsettled side is freely correctable.
-- ============================================================================

create or replace function public.correct_delivery_charge(
  p_delivery_id   uuid,
  p_charged       numeric,
  p_agent_payment numeric,
  p_reason        text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_actor          uuid := auth.uid();
  v_row            public.deliveries%rowtype;
  v_charge_changed boolean;
  v_agent_changed  boolean;
begin
  if not public.is_admin() then
    raise exception 'correcting delivery charges requires admin role'
      using errcode = '42501';
  end if;

  if p_charged is null or p_agent_payment is null then
    raise exception 'both charge and agent payment are required' using errcode = '22023';
  end if;
  if p_charged < 0 or p_agent_payment < 0 then
    raise exception 'charge and agent payment must be >= 0' using errcode = '23514';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required for a charge correction' using errcode = '22023';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'cannot correct a deleted delivery' using errcode = '22023';
  end if;

  v_charge_changed := p_charged       is distinct from v_row.charged_snapshot;
  v_agent_changed  := p_agent_payment is distinct from v_row.agent_payment_snapshot;

  -- No-op guard: nothing to change.
  if not v_charge_changed and not v_agent_changed then
    raise exception 'charges are unchanged' using errcode = '22023';
  end if;

  -- Settled-side guard: refuse to edit a snapshot whose settlement is frozen.
  -- The figures were remitted from the old value; correcting them here would
  -- desync the live reconcile view from what was actually settled/paid.
  if v_charge_changed and exists (
    select 1 from public.settlements s
     where s.subject_type = 'client'
       and s.subject_id   = v_row.client_id
       and s.period_date  = v_row.scheduled_date
       and s.voided_at is null
  ) then
    raise exception
      'cannot change the Reda charge: the client is already settled for %', v_row.scheduled_date
      using errcode = '23505',
            hint   = 'void the client settlement for this day, then correct and re-settle';
  end if;

  if v_agent_changed and exists (
    select 1 from public.settlements s
     where s.subject_type = 'agent'
       and s.subject_id   = v_row.assigned_agent_id
       and s.period_date  = v_row.scheduled_date
       and s.voided_at is null
  ) then
    raise exception
      'cannot change the agent payout: the agent is already settled for %', v_row.scheduled_date
      using errcode = '23505',
            hint   = 'void the agent settlement for this day, then correct and re-settle';
  end if;

  update public.deliveries
     set charged_snapshot       = p_charged,
         agent_payment_snapshot = p_agent_payment,
         updated_at             = now()
   where id = p_delivery_id;

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := p_delivery_id,
    p_old         := jsonb_build_object(
      'charged_snapshot',       v_row.charged_snapshot,
      'agent_payment_snapshot', v_row.agent_payment_snapshot
    ),
    p_new         := jsonb_build_object(
      'charged_snapshot',       p_charged,
      'agent_payment_snapshot', p_agent_payment
    ),
    p_reason      := 'charge_correction: ' || btrim(p_reason)
  );
end;
$function$;

grant execute on function public.correct_delivery_charge(uuid, numeric, numeric, text) to authenticated;
