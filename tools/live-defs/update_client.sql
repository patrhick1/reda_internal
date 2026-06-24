-- ============================================================================
-- update_client — admin edit of a client record (8-arg overload, the one the
-- app calls). Paste-and-run as ONE script in the Supabase SQL editor.
--
-- 2026-06-24: added a NEGATIVE-MARGIN GUARD on max_charge_per_delivery.
--   The per-client cap clamps Reda's CHARGE (revenue) but never the agent's
--   payout (cost) — see public.effective_rate. So a cap set below the highest
--   agent payout at ANY active location forces a guaranteed loss on every
--   delivery there (the "Mrs lawal / Aernings" case: cap 5,000 vs Badagry
--   agent payout 6,000 = margin -1,000). This guard blocks setting such a cap.
--   Floor = max(agent_payment) across active rate cards. Break-even (cap ==
--   floor) is allowed; only a strictly negative worst-case margin is blocked.
--   NOTE: floor is rate-card based; agent_payment_bonus (currently 0 for all
--   users) is not added in. If per-agent bonuses become real, revisit.
--   NOTE: the legacy 7-arg update_client(uuid,text,text,text,text,text,numeric)
--   overload is NOT called by the app and is left unpatched here.
-- ============================================================================

create or replace function public.update_client(
  p_id uuid,
  p_name text,
  p_contact_phone text,
  p_contact_email text,
  p_notes text,
  p_reason text default null,
  p_max_charge_per_delivery numeric default null,
  p_auto_cancel_soft_fails boolean default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_old                public.clients;
  v_name               text := nullif(trim(p_name), '');
  v_phone              text := nullif(trim(p_contact_phone), '');
  v_email              text := nullif(trim(p_contact_email), '');
  v_max_agent_payment  numeric;
  v_floor_location     text;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  select * into v_old from public.clients where id = p_id;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if v_name is null then
    raise exception 'name required' using errcode = '23514';
  end if;
  if p_max_charge_per_delivery is not null and p_max_charge_per_delivery < 0 then
    raise exception 'max_charge_per_delivery must be >= 0' using errcode = '23514';
  end if;

  -- NEGATIVE-MARGIN GUARD (only fires when a cap is actually being set/changed;
  -- null = "leave as-is" so unrelated edits are never blocked).
  if p_max_charge_per_delivery is not null then
    select rc.agent_payment, l.name
      into v_max_agent_payment, v_floor_location
      from public.rate_card rc
      join public.locations l on l.id = rc.location_id
     where rc.effective_until is null
     order by rc.agent_payment desc nulls last
     limit 1;

    if v_max_agent_payment is not null
       and p_max_charge_per_delivery < v_max_agent_payment then
      raise exception
        'Max Reda charge of % is below the highest agent payout (% at %). Deliveries there would lose money — set the cap to at least %, or remove the cap.',
        p_max_charge_per_delivery, v_max_agent_payment, v_floor_location, v_max_agent_payment
        using errcode = '23514';
    end if;
  end if;

  update public.clients
     set name                    = v_name,
         contact_phone           = v_phone,
         contact_email           = v_email,
         notes                   = p_notes,
         max_charge_per_delivery = coalesce(p_max_charge_per_delivery, max_charge_per_delivery),
         auto_cancel_soft_fails  = coalesce(p_auto_cancel_soft_fails, auto_cancel_soft_fails)
   where id = p_id;

  perform public.write_audit(
    'client', p_id,
    jsonb_build_object(
      'name',                    v_old.name,
      'contact_phone',           v_old.contact_phone,
      'contact_email',           v_old.contact_email,
      'notes',                   v_old.notes,
      'max_charge_per_delivery', v_old.max_charge_per_delivery,
      'auto_cancel_soft_fails',  v_old.auto_cancel_soft_fails
    ),
    jsonb_build_object(
      'name',                    v_name,
      'contact_phone',           v_phone,
      'contact_email',           v_email,
      'notes',                   p_notes,
      'max_charge_per_delivery', coalesce(p_max_charge_per_delivery, v_old.max_charge_per_delivery),
      'auto_cancel_soft_fails',  coalesce(p_auto_cancel_soft_fails,  v_old.auto_cancel_soft_fails)
    ),
    p_reason
  );
end;
$function$;
