-- Approved #308: operational carryovers do not consume failed attempts.
-- Definition-only migration: no historical rows or counters are rewritten.
-- Business functions captured from the live database on 2026-10-16; preserve
-- financial locks, sibling handling, client policies, audit and the cap of one.
BEGIN;
CREATE OR REPLACE FUNCTION public._rollover_is_strike(p_status text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog
AS $$ SELECT coalesce(p_status IN (
  'not_answering','not_around','not_available',
  'not_connecting','number_busy','switched_off'
),false) $$;
REVOKE ALL ON FUNCTION public._rollover_is_strike(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rollover_delivery(p_client_uuid text, p_delivery_id uuid, p_new_scheduled_date date DEFAULT NULL::date, p_reason text DEFAULT 'eod_rollover'::text, p_notify boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  -- Failed-attempt cap: one qualifying failed attempt may roll, then the
  -- second closes to unserious. Untouched/operational days do not count.
  -- The existing cap of one rollover (two failures) is unchanged. The
  -- comparison and reason string below both derive from this constant.
  v_carry_cap constant int := 1;
  v_actor uuid := auth.uid();
  v_old   public.deliveries%rowtype;
  v_new_id uuid;
  v_new_date date;
  v_rate_charged numeric;
  v_rate_agent_payment numeric;
  v_charged numeric;
  v_agent_payment numeric;
  v_existing_new uuid;
  v_is_strike boolean;
  v_new_rollover_count int;
  v_rolled_from_status text;
  v_rolled_from_date   date;
begin
  -- same_customer_financial_outer_lock
  perform public._same_customer_lock_orders(array[p_delivery_id],'{}'::uuid[]);
  if not public.is_admin_or_dispatcher() then
    raise exception 'rollover requires admin or dispatcher role'
      using errcode = '42501';
  end if;

  if p_client_uuid is null or btrim(p_client_uuid) = '' then
    raise exception 'client_uuid required for idempotency' using errcode = '22023';
  end if;

  select id into v_existing_new
  from public.deliveries
  where parent_delivery_id = p_delivery_id
    and created_via = 'rollover'
  limit 1;
  if v_existing_new is not null then
    return v_existing_new;
  end if;

  select * into v_old from public.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'delivery not found: %', p_delivery_id using errcode = 'P0002';
  end if;

  if v_old.deleted_at is not null then
    raise exception 'cannot roll a deleted delivery' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.delivery_status_defs
    where status = v_old.current_status and category = 'terminal'
  ) then
    raise exception 'delivery already terminal (status=%) — nothing to roll', v_old.current_status
      using errcode = '22023';
  end if;

  -- Waybills/pickups are money-only records (no product, phone, or address) and
  -- are terminal by construction. They must never roll: the forward INSERT below
  -- defaults order_type to 'delivery' and would trip deliveries_delivery_requires_fields.
  -- run_eod_rollover already filters these out; this is the lowest-level backstop
  -- for any direct/manual call.
  if v_old.order_type is distinct from 'delivery' then
    raise exception 'only deliveries can be rolled (order_type=%) — waybills never roll', v_old.order_type
      using errcode = '22023';
  end if;

  -- Use the same rule for counting, enforcement, classification and audit.
  v_is_strike := public._rollover_is_strike(v_old.current_status);

  if v_is_strike and v_old.rollover_count >= v_carry_cap then
    perform public.change_delivery_status(
      p_client_uuid     := p_client_uuid || ':cap-unserious',
      p_delivery_id     := v_old.id,
      p_to_status       := 'unserious',
      p_reason          := 'carry-cap reached (' || v_carry_cap || ' rollover)',
      p_notes           := null,
      p_paid            := null,
      p_quantity_delivered := null,
      p_payment_method  := null,
      p_effective_at    := now()
    );
    if p_notify then
      perform public._notify_admins_carry_cap(v_old.id);
    end if;
    return null;
  end if;

  v_new_date := public._ensure_workday(
    coalesce(p_new_scheduled_date, (v_old.scheduled_date + interval '1 day')::date)
  );

  if v_old.location_id is not null then
    -- Re-price the new day through the same client-aware source of truth used by
    -- create/edit/location-correction. Calling current_rate_for_location here
    -- used to bypass clients.max_charge_per_delivery on rollover children.
    -- The child is intentionally unassigned, so pass NULL for the agent: any
    -- future rider bonus is applied when an agent/location edit re-snapshots it.
    select er.charged, er.agent_payment
      into v_rate_charged, v_rate_agent_payment
      from public.effective_rate(v_old.location_id, v_old.client_id, null) er;
  end if;
  v_charged       := coalesce(v_rate_charged,       v_old.charged_snapshot);
  v_agent_payment := coalesce(v_rate_agent_payment, public._same_customer_normal_fee(v_old));

  v_new_rollover_count := case when v_is_strike then v_old.rollover_count + 1
                               else v_old.rollover_count end;

  -- Carry the last MEANINGFUL status forward: the parent's status if it was
  -- attempted (not 'pending'), else inherit whatever the parent was already
  -- carrying. 'pending' means "never attempted that day", so it isn't worth
  -- surfacing and shouldn't clobber an earlier real attempt.
  if v_old.current_status <> 'pending' then
    v_rolled_from_status := v_old.current_status;
    v_rolled_from_date   := v_old.scheduled_date;
  else
    v_rolled_from_status := v_old.rolled_from_status;
    v_rolled_from_date   := v_old.rolled_from_date;
  end if;

  v_new_id := gen_random_uuid();
  insert into public.deliveries (
    id, client_id, product_catalog_id, customer_name, customer_phone, customer_phone_alt,
    customer_price, raw_address, location_id, assigned_agent_id,
    quantity_ordered, scheduled_date, created_via, parent_delivery_id,
    charged_snapshot, agent_payment_snapshot, current_status,
    created_by_user_id, bot_raw_message, text_fingerprint, rollover_count,
    rolled_from_status, rolled_from_date, delivery_instructions, client_rep, same_customer_key_override, same_customer_match_mode
  )
  values (
    v_new_id, v_old.client_id, v_old.product_catalog_id, v_old.customer_name, v_old.customer_phone, v_old.customer_phone_alt,
    v_old.customer_price, v_old.raw_address, v_old.location_id,
    null,                                          -- assigned_agent_id intentionally NULL
    v_old.quantity_ordered, v_new_date, 'rollover', v_old.id,
    v_charged, v_agent_payment, 'pending',
    v_actor, v_old.bot_raw_message, v_old.text_fingerprint, v_new_rollover_count,
    v_rolled_from_status, v_rolled_from_date, v_old.delivery_instructions, v_old.client_rep, v_old.same_customer_key_override, v_old.same_customer_match_mode
  );

  insert into public.delivery_status_history
    (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
  values
    (v_new_id, null, 'pending', v_actor, p_client_uuid, p_reason, now());

  perform public.change_delivery_status(
    p_client_uuid     := p_client_uuid || ':parent',
    p_delivery_id     := v_old.id,
    p_to_status       := 'rolled_over',
    p_reason          := p_reason,
    p_notes           := null,
    p_paid            := null,
    p_quantity_delivered := null,
    p_payment_method  := null,
    p_effective_at    := now()
  );

  perform public.write_audit(
    p_actor_id    := v_actor,
    p_entity_type := 'delivery',
    p_entity_id   := v_new_id,
    p_old         := jsonb_build_object(
      'parent_delivery_id', v_old.id,
      'old_scheduled_date', v_old.scheduled_date,
      'old_status', v_old.current_status,
      'old_charged_snapshot', v_old.charged_snapshot,
      'old_agent_payment_snapshot', v_old.agent_payment_snapshot,
      'old_rollover_count', v_old.rollover_count,
      'old_assigned_agent_id', v_old.assigned_agent_id
    ),
    p_new         := jsonb_build_object(
      'new_delivery_id', v_new_id,
      'new_scheduled_date', v_new_date,
      'charged_snapshot', v_charged,
      'agent_payment_snapshot', v_agent_payment,
      'new_rollover_count', v_new_rollover_count,
      'is_strike_rollover', v_is_strike,
      'new_assigned_agent_id', null,
      'normal_agent_payment', v_agent_payment,
      'inherited_customer_key_override', v_old.same_customer_key_override,
      'inherited_customer_match_mode', v_old.same_customer_match_mode,
      'rolled_from_status', v_rolled_from_status,
      'rolled_from_date', v_rolled_from_date
    ),
    p_reason      := p_reason
  );

  return v_new_id;
end;
$function$;

CREATE OR REPLACE FUNCTION reda_maintenance.classify(p_for_date date, p_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(delivery_id uuid, current_status text, action text, resolved_sibling_status text, resolved_sibling_label text, group_max_sort integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  with eligible as (
    select d.id, d.client_id, d.assigned_agent_id, d.current_status,
           coalesce(d.customer_phone_normalized, d.id::text) as customer_phone_normalized,
           coalesce(d.items_fingerprint, d.product_catalog_id::text) as item_key,  -- [Feature A]
           d.scheduled_date,
           d.text_fingerprint,
           public._norm_address(d.raw_address) as norm_addr,
           d.created_at, d.updated_at, d.rollover_count,
           sd.sort_order as status_sort,
           sd.category   as status_category,
           cl.auto_cancel_soft_fails,
           resolved.sibling_status as resolved_sibling_status,
           resolved.sibling_label  as resolved_sibling_label,
           (resolved.sibling_status is not null) as has_resolved_sibling
      from public.deliveries d
      join public.delivery_status_defs sd on sd.status = d.current_status
      join public.clients cl on cl.id = d.client_id
      left join lateral (
        select sib.current_status as sibling_status, sib_def.label as sibling_label
          from public._find_sibling_deliveries(d.id) sib
          join public.delivery_status_defs sib_def on sib_def.status = sib.current_status
         where sib_def.category = 'terminal'
           and not reda_maintenance.is_held(sib.id,sib.updated_at)
           and sib.current_status not in ('agent_cancelled', 'rolled_over')
         order by sib.created_at desc, sib.id limit 1
      ) as resolved on true
     where (d.scheduled_date = p_for_date
            -- Client policy (auto_cancel_soft_fails): a postponed order is dead the
            -- night it was postponed -- sweep it into TONIGHT's classification even
            -- though its scheduled_date was snapped forward to the requested day.
            or (d.current_status = 'postponed' and cl.auto_cancel_soft_fails and d.updated_at < ((p_for_date+1)::timestamp at time zone 'Africa/Lagos')))
       and d.deleted_at is null and (p_ids is null or d.id = any(p_ids)) and not reda_maintenance.is_held(d.id,d.updated_at)
       and d.order_type = 'delivery'   -- waybills/pickups are money-only & terminal; they never roll
       and sd.category <> 'terminal'
       and (d.current_status <> 'postponed' or cl.auto_cancel_soft_fails)
       and not exists (
         select 1 from public.deliveries c
          where c.parent_delivery_id = d.id and c.created_via = 'rollover')
  ),
  clustered as (
    -- Sibling clustering for dedup (identical to _find_sibling_deliveries):
    -- same customer + items + day, matched on raw-message text_fingerprint OR
    -- normalized address. sib_cluster = min id over a row's siblings.
    select e.*,
           (select min(e2.id::text)
              from eligible e2
             where e2.customer_phone_normalized = e.customer_phone_normalized
               and e2.item_key       = e.item_key
               and e2.scheduled_date = e.scheduled_date
               and (
                 e2.id = e.id
                 or (e2.text_fingerprint is not null and e2.text_fingerprint = e.text_fingerprint)
                 or (e2.norm_addr       is not null and e2.norm_addr       = e.norm_addr)
               )
           ) as sib_cluster
      from eligible e
  ),
  same_agent_ranked as (
    select c.*,
           row_number() over (
             partition by c.customer_phone_normalized, c.item_key,
                          c.scheduled_date, c.sib_cluster,
                          coalesce(c.assigned_agent_id::text, '!unassigned:' || c.id::text)
             order by c.status_sort desc, c.updated_at desc, c.created_at asc, c.id asc
           ) as same_agent_rn
      from clustered c
  ),
  cross_agent_ranked as (
    select s.*,
           count(*) filter (where s.same_agent_rn = 1)
             over (partition by s.customer_phone_normalized, s.item_key,
                                s.scheduled_date, s.sib_cluster) as group_canonical_count,
           max(s.status_sort) filter (where s.same_agent_rn = 1)
             over (partition by s.customer_phone_normalized, s.item_key,
                                s.scheduled_date, s.sib_cluster) as group_max_sort,
           row_number() over (
             partition by s.customer_phone_normalized, s.item_key,
                          s.scheduled_date, s.sib_cluster
             order by s.status_sort desc, s.updated_at desc, s.created_at asc, s.id asc
           ) as cross_agent_rn
      from same_agent_ranked s
  )
  select
    id            as delivery_id,
    current_status,
    case
      when has_resolved_sibling then 'sibling_resolved'
      when same_agent_rn > 1 then 'dedup_same_agent'
      when group_canonical_count > 1 and cross_agent_rn > 1 then 'dedup_cross_agent'
      when current_status in ('not_around','not_available') then 'close_disinterest'
      when current_status in ('not_answering','not_connecting','number_busy','switched_off','tomorrow','postponed')
           and auto_cancel_soft_fails then 'close_policy'
      when current_status = 'follow_up' then 'close_followup'
      when public._rollover_is_strike(current_status)
           and rollover_count >= 1 then 'cap_unserious'
      else 'roll'
    end           as action,
    resolved_sibling_status,
    resolved_sibling_label,
    group_max_sort::int
  from cross_agent_ranked
  order by customer_phone_normalized, item_key, sib_cluster, same_agent_rn, cross_agent_rn;
$function$;
COMMIT;
