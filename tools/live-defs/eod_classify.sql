-- ============================================================================
-- _eod_classify + preview_eod_rollover — the SINGLE SOURCE OF TRUTH for what
-- end-of-day does to each still-open delivery.
--
-- WHY THIS EXISTS
-- run_eod_rollover used to encode the "what happens to this row" decision inline
-- in its mutation loop, and the EOD screen re-encoded a rough copy of the same
-- rules on the client. Two copies drift: the screen showed follow_up orders as
-- "Roll N forward" when the rollover actually closes them to deferred_to_client
-- (Uzo, 2026-07-10). _eod_classify is now the ONLY place the decision lives:
--   * run_eod_rollover loops over it and EXECUTES each verdict (no inline rules);
--   * preview_eod_rollover joins it to display fields for the screen.
-- Change a branch here and both the nightly job and the screen move together.
--
-- READ-ONLY & PURE: _eod_classify does not mutate. It lifts run_eod_rollover's
-- eligible → clustered → same_agent_ranked → cross_agent_ranked CTEs verbatim
-- (they were already pure reads) and adds one CASE that names the action, in the
-- exact branch-priority order the old loop used.
--
-- action values (priority order, first match wins):
--   sibling_resolved   → cancelled  (another agent already settled the order)
--   dedup_same_agent   → cancelled  (same agent holds a duplicate)
--   dedup_cross_agent  → cancelled  (cross-agent duplicate / race lost)
--   close_disinterest  → unserious  (not_around / not_available)
--   close_policy       → failed_delivery (soft-fail, client on auto-cancel)
--   close_followup     → deferred_to_client (follow_up handed back to client)
--   cap_unserious      → unserious  (carry cap reached — see note)
--   roll               → rolled_over (parent) + a new pending child tomorrow
--
-- CAP NOTE: 'cap_unserious' vs 'roll' is a DISPLAY prediction that mirrors
-- rollover_delivery's carry cap (v_carry_cap = 1: a soft-fail/never-attempted
-- order that already rolled once closes to unserious; no_product is exempt).
-- rollover_delivery remains the AUTHORITY that actually applies the cap — the
-- executor calls it for both 'roll' and 'cap_unserious', so a drift in this
-- mirror can only mislabel the preview, never mis-roll a delivery.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._eod_classify(p_for_date date)
 RETURNS TABLE(
   delivery_id             uuid,
   current_status          text,
   action                  text,
   resolved_sibling_status text,
   resolved_sibling_label  text,
   group_max_sort          int
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  with eligible as (
    select d.id, d.client_id, d.assigned_agent_id, d.current_status,
           d.customer_phone_normalized,
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
           and sib.current_status not in ('agent_cancelled', 'rolled_over')
         order by sib.created_at desc, sib.id limit 1
      ) as resolved on true
     where d.scheduled_date = p_for_date
       and d.deleted_at is null
       and d.order_type = 'delivery'   -- waybills/pickups are money-only & terminal; they never roll
       and sd.category <> 'terminal'
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
      when current_status in ('not_answering','not_connecting','number_busy','switched_off')
           and auto_cancel_soft_fails then 'close_policy'
      when current_status = 'follow_up' then 'close_followup'
      when status_category in ('initial','soft_failure')
           and current_status <> 'no_product'
           and rollover_count >= 1 then 'cap_unserious'
      else 'roll'
    end           as action,
    resolved_sibling_status,
    resolved_sibling_label,
    group_max_sort::int
  from cross_agent_ranked
  order by customer_phone_normalized, item_key, sib_cluster, same_agent_rn, cross_agent_rn;
$function$;

grant execute on function public._eod_classify(date) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- preview_eod_rollover — what the EOD screen renders. Same verdicts as the
-- nightly run (via _eod_classify) plus the display columns, so the screen shows
-- exactly what end-of-day will do to each order. Admin/dispatcher only (returns
-- empty for anyone else, mirroring the reconcile RPCs).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_eod_rollover(
  p_for_date date DEFAULT (now() at time zone 'Africa/Lagos')::date
)
 RETURNS TABLE(
   delivery_id         uuid,
   customer_name       text,
   product_name        text,
   quantity_ordered    numeric,
   customer_price      numeric,
   current_status      text,
   assigned_agent_name text,
   action              text,
   to_status           text
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  select
    c.delivery_id,
    d.customer_name,
    p.product_name,
    d.quantity_ordered,
    d.customer_price,
    c.current_status,
    u.display_name as assigned_agent_name,
    c.action,
    case c.action
      when 'sibling_resolved'  then 'cancelled'
      when 'dedup_same_agent'  then 'cancelled'
      when 'dedup_cross_agent' then 'cancelled'
      when 'close_disinterest' then 'unserious'
      when 'close_policy'      then 'failed_delivery'
      when 'close_followup'    then 'deferred_to_client'
      when 'cap_unserious'     then 'unserious'
      else 'rolled_over'
    end as to_status
  from public._eod_classify(p_for_date) c
  join public.deliveries d on d.id = c.delivery_id
  left join public.product_catalog p on p.id = d.product_catalog_id
  left join public.users u on u.id = d.assigned_agent_id
  where public.is_admin_or_dispatcher()
  order by c.action, d.customer_name;
$function$;

grant execute on function public.preview_eod_rollover(date) to authenticated, service_role;
