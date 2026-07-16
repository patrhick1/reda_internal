-- Managers (admin + dispatcher) may correct Reda's fee snapshot on one delivery
-- without changing the rider's payout or the underlying rate card.

begin;

create or replace function public.get_delivery_reda_charge(p_delivery_id uuid)
returns table (
  charged_snapshot numeric,
  recommended_charge numeric,
  client_day_settled boolean
)
language plpgsql security definer set search_path = public, auth
as $function$
declare
  v_row public.deliveries%rowtype;
begin
  if not public.is_manager() then
    raise exception 'viewing a delivery charge requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id;
  if not found or v_row.deleted_at is not null then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;

  return query
  select
    v_row.charged_snapshot,
    (
      select er.charged
        from public.effective_rate(
          v_row.location_id, v_row.client_id, v_row.assigned_agent_id
        ) er
       limit 1
    ),
    exists (
      select 1 from public.settlements s
       where s.subject_type = 'client'
         and s.subject_id = v_row.client_id
         and s.period_date = v_row.scheduled_date
         and s.voided_at is null
    );
end;
$function$;

create or replace function public.correct_delivery_reda_charge(
  p_delivery_id uuid,
  p_charged numeric,
  p_reason text
) returns void
language plpgsql security definer set search_path = public, auth
as $function$
declare
  v_actor uuid := auth.uid();
  v_row public.deliveries%rowtype;
begin
  if not public.is_manager() then
    raise exception 'correcting a Reda charge requires admin or dispatcher role'
      using errcode = '42501';
  end if;
  if p_charged is null or p_charged < 0 then
    raise exception 'Reda charge must be a non-negative number' using errcode = '23514';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required for a Reda charge correction' using errcode = '22023';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'cannot correct a deleted delivery' using errcode = '22023';
  end if;
  if p_charged is not distinct from v_row.charged_snapshot then
    raise exception 'Reda charge is unchanged' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.settlements s
     where s.subject_type = 'client'
       and s.subject_id = v_row.client_id
       and s.period_date = v_row.scheduled_date
       and s.voided_at is null
  ) then
    raise exception 'cannot change the Reda charge: the client is already settled for %',
      v_row.scheduled_date
      using errcode = '23505',
            hint = 'void the client settlement for this day, then correct and re-settle';
  end if;

  update public.deliveries
     set charged_snapshot = p_charged,
         updated_at = now()
   where id = p_delivery_id;

  perform public.write_audit(
    p_actor_id := v_actor,
    p_entity_type := 'delivery',
    p_entity_id := p_delivery_id,
    p_old := jsonb_build_object('charged_snapshot', v_row.charged_snapshot),
    p_new := jsonb_build_object('charged_snapshot', p_charged),
    p_reason := 'reda_charge_correction: ' || btrim(p_reason)
  );
end;
$function$;

revoke all on function public.get_delivery_reda_charge(uuid) from public, anon;
revoke all on function public.correct_delivery_reda_charge(uuid, numeric, text) from public, anon;
grant execute on function public.get_delivery_reda_charge(uuid) to authenticated;
grant execute on function public.correct_delivery_reda_charge(uuid, numeric, text) to authenticated;

commit;
