-- unassign_delivery as live on the box, captured 2026-09-04 before bulk_unassign_deliveries
-- was layered on top of it (supabase/migrations/20260904003000_bulk_unassign_deliveries.sql).
-- This function itself is NOT changed by that migration; captured for the record.

CREATE OR REPLACE FUNCTION public.unassign_delivery(p_delivery_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$

declare

  v_actor       uuid := auth.uid();

  v_row         public.deliveries%rowtype;

  v_is_terminal boolean;

begin

  if not public.is_manager() then

    raise exception 'unassign requires admin or dispatcher role'

      using errcode = '42501';

  end if;



  if p_reason is null or btrim(p_reason) = '' then

    raise exception 'reason required for unassign' using errcode = '22023';

  end if;



  select * into v_row from public.deliveries where id = p_delivery_id for update;

  if not found then

    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';

  end if;

  if v_row.deleted_at is not null then

    raise exception 'cannot unassign a deleted delivery' using errcode = '22023';

  end if;



  select category = 'terminal' into v_is_terminal

    from public.delivery_status_defs

   where status = v_row.current_status;

  if v_is_terminal is true then

    raise exception 'cannot unassign a terminal delivery (status=%)', v_row.current_status

      using errcode = '22023',

            hint   = 'reopen via the state machine first if this row must be reassigned';

  end if;



  if v_row.assigned_agent_id is null then

    raise exception 'delivery is already unassigned' using errcode = '22023';

  end if;



  update public.deliveries

     set assigned_agent_id = null,

         updated_at        = now()

   where id = p_delivery_id;



  perform public.write_audit(

    p_actor_id    := v_actor,

    p_entity_type := 'delivery',

    p_entity_id   := p_delivery_id,

    p_old         := jsonb_build_object('assigned_agent_id', v_row.assigned_agent_id),

    p_new         := jsonb_build_object('assigned_agent_id', null),

    p_reason      := 'unassign: ' || btrim(p_reason)

  );

end;

$function$

