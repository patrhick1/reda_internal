-- ============================================================================
-- update_waybill — edit a waybill/pickup/failed-delivery record after creation.
--
-- Waybills are money-only rows created directly as 'delivered', so the generic
-- editors don't touch them: update_delivery_fields refuses terminal rows, and
-- revert-to-pending is blocked (it poisons the EOD rollover). Uzo still needs to
-- fix mistakes — wrong client, wrong amount, wrong type. This is that path: the
-- waybill equivalent of correct_delivery_charge.
--
-- Editable: client, charge-to-client (charged_snapshot), Reda payout
-- (agent_payment_snapshot), the Type label (customer_name), and the client-facing
-- breakdown note (the earliest delivery_messages row — the one client_remit_detail
-- reads for the reconciliation report; updated IN PLACE so the report stays in
-- sync with the amounts).
--
-- Settlement guard: a waybill's only settlement subject is the CLIENT (it has no
-- assigned agent). If the charge or the client changes and the (old) client's day
-- is already settled, or the order moves to a client already settled for that day,
-- block — editing would desync the live reconcile view from what was paid out.
-- Mirrors correct_delivery_charge's per-side settled guard.
-- ============================================================================
create or replace function public.update_waybill(
  p_delivery_id uuid,
  p_client_id   uuid,
  p_charged     numeric,
  p_paid        numeric,
  p_label       text,
  p_note        text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_actor          uuid := auth.uid();
  v_row            public.deliveries%rowtype;
  v_role           text;
  v_label          text := coalesce(nullif(btrim(p_label), ''), 'Waybill');
  v_client_changed boolean;
  v_charge_changed boolean;
begin
  if not public.is_manager() then
    raise exception 'editing a waybill requires admin or dispatcher role' using errcode = '42501';
  end if;
  if p_client_id is null then
    raise exception 'a client is required for a waybill' using errcode = '23514';
  end if;
  if p_charged is null or p_charged < 0 then
    raise exception 'charge must be a non-negative number' using errcode = '23514';
  end if;
  if p_paid is null or p_paid < 0 then
    raise exception 'paid out must be a non-negative number' using errcode = '23514';
  end if;

  select * into v_row from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;
  if v_row.deleted_at is not null then
    raise exception 'cannot edit a deleted waybill' using errcode = '22023';
  end if;
  if v_row.order_type <> 'waybill' then
    raise exception 'update_waybill only edits waybill/pickup orders (order_type=%)', v_row.order_type
      using errcode = '22023',
            hint = 'use the delivery editors / correction RPCs for normal deliveries';
  end if;

  v_client_changed := p_client_id is distinct from v_row.client_id;
  v_charge_changed := p_charged    is distinct from v_row.charged_snapshot;

  -- Settled-day guard (client side). If the charge or client changed and the
  -- current client's day is frozen, the remitted figure would desync.
  if (v_charge_changed or v_client_changed) and exists (
    select 1 from public.settlements s
     where s.subject_type = 'client'
       and s.subject_id   = v_row.client_id
       and s.period_date  = v_row.scheduled_date
       and s.voided_at is null
  ) then
    raise exception
      'cannot edit: the client is already settled for %', v_row.scheduled_date
      using errcode = '23505',
            hint   = 'void the client settlement for this day, then edit and re-settle';
  end if;

  -- Moving the charge ONTO a client already settled for that day would also desync.
  if v_client_changed and exists (
    select 1 from public.settlements s
     where s.subject_type = 'client'
       and s.subject_id   = p_client_id
       and s.period_date  = v_row.scheduled_date
       and s.voided_at is null
  ) then
    raise exception
      'cannot move to that client: they are already settled for %', v_row.scheduled_date
      using errcode = '23505',
            hint   = 'void that client''s settlement for this day first';
  end if;

  update public.deliveries
     set client_id              = p_client_id,
         charged_snapshot       = p_charged,
         agent_payment_snapshot = p_paid,
         customer_name          = v_label,
         updated_at             = now()
   where id = p_delivery_id;

  -- Keep the client-facing breakdown note in sync. client_remit_detail reads the
  -- EARLIEST non-empty delivery_message for waybill rows, so update that row in
  -- place; insert one only if (unexpectedly) none exists.
  if nullif(btrim(p_note), '') is not null then
    select role into v_role from public.users where id = v_actor;
    v_role := case when v_role in ('admin','dispatcher') then v_role else 'admin' end;

    update public.delivery_messages dm
       set note = btrim(p_note)
      from (
        select id from public.delivery_messages
         where delivery_id = p_delivery_id
           and nullif(btrim(note), '') is not null
         order by created_at asc
         limit 1
      ) fn
     where dm.id = fn.id;

    if not found then
      insert into public.delivery_messages (delivery_id, author_id, author_role, note)
        values (p_delivery_id, v_actor, v_role, btrim(p_note));
    end if;
  end if;

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := p_delivery_id,
    p_old         := jsonb_build_object(
      'client_id',              v_row.client_id,
      'charged_snapshot',       v_row.charged_snapshot,
      'agent_payment_snapshot', v_row.agent_payment_snapshot,
      'customer_name',          v_row.customer_name
    ),
    p_new         := jsonb_build_object(
      'client_id',              p_client_id,
      'charged_snapshot',       p_charged,
      'agent_payment_snapshot', p_paid,
      'customer_name',          v_label
    ),
    p_reason      := 'waybill_edit'
  );
end;
$function$;

revoke all on function public.update_waybill(uuid, uuid, numeric, numeric, text, text) from public;
grant execute on function public.update_waybill(uuid, uuid, numeric, numeric, text, text) to authenticated;
