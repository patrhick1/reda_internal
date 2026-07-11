-- run_eod_rollover — executes the end-of-day verdicts for one date.
--
-- The DECISION for each still-open row (roll / dedup-cancel / close-followup /
-- close-disinterest / close-policy / cap) now lives in ONE place: _eod_classify
-- (see tools/live-defs/eod_classify.sql). This function no longer re-derives the
-- rules — it loops over the classifier's verdicts and performs the side effects.
-- preview_eod_rollover reads the same classifier, so the EOD screen can never
-- disagree with what the nightly job actually does (the drift that showed
-- follow_up orders as "roll forward" — Uzo, 2026-07-10 — is now structurally
-- impossible).
--
-- 'roll' and 'cap_unserious' share the executor branch: both call
-- rollover_delivery, which authoritatively applies the carry cap (returns null →
-- capped to unserious). The classifier's cap prediction is display-only.
CREATE OR REPLACE FUNCTION public.run_eod_rollover(p_for_date date DEFAULT CURRENT_DATE, p_reason text DEFAULT 'eod_rollover'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_system_id constant uuid := '2d8d5895-d2a8-4900-b15e-7662b176a805';
  v_capped_ids_limit constant int := 100;
  v_row record;
  v_count integer := 0;
  v_same_agent_cancels       integer := 0;
  v_cross_agent_cancels      integer := 0;
  v_cap_hits                 integer := 0;
  v_capped_overflow          integer := 0;
  v_policy_cancels           integer := 0;
  v_sibling_resolved_cancels integer := 0;
  v_followup_closes          integer := 0;   -- follow_up closed to deferred_to_client
  v_disinterest_closes       integer := 0;   -- not_around/not_available closed to unserious
  v_capped_ids               uuid[]  := array[]::uuid[];
  v_new_child_id             uuid;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'eod rollover requires admin or dispatcher role' using errcode = '42501';
  end if;

  perform set_config('reda.in_eod_rollover', 'true', true);

  -- The classifier is the single source of truth for what happens to each row.
  -- This loop only executes its verdicts (same side effects as before, one per
  -- action) — no rule lives here anymore.
  for v_row in
    select * from public._eod_classify(p_for_date)
  loop
    if v_row.action = 'sibling_resolved' then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.delivery_id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-sibling-resolved:' || p_for_date::text || ':' || v_row.delivery_id::text,
         'Another agent already handled this order ('
           || coalesce(v_row.resolved_sibling_label, v_row.resolved_sibling_status)
           || '). Closed as duplicate.', now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.delivery_id;
      v_sibling_resolved_cancels := v_sibling_resolved_cancels + 1;

    elsif v_row.action = 'dedup_same_agent' then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.delivery_id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-same-agent:' || p_for_date::text || ':' || v_row.delivery_id::text,
         'duplicate not completed, same-agent deduped on rollover', now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.delivery_id;
      v_same_agent_cancels := v_same_agent_cancels + 1;

    elsif v_row.action = 'dedup_cross_agent' then
      insert into public.delivery_status_history
        (delivery_id, from_status, to_status, changed_by_user_id, client_uuid, reason, effective_at)
      values (v_row.delivery_id, v_row.current_status, 'cancelled', v_system_id,
         'rollover-dedup-cross-agent:' || p_for_date::text || ':' || v_row.delivery_id::text,
         case when v_row.group_max_sort > 1 then 'race lost, deduped on rollover'
              else 'duplicate not completed, cross-agent deduped on rollover' end, now());
      update public.deliveries set current_status = 'cancelled', updated_at = now() where id = v_row.delivery_id;
      v_cross_agent_cancels := v_cross_agent_cancels + 1;

    -- not_around / not_available are disinterest signals (customer not interested,
    -- no money, or playing with the order form) — closed to unserious, not rolled.
    elsif v_row.action = 'close_disinterest' then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-disinterest-close:' || v_row.delivery_id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.delivery_id, p_to_status => 'unserious',
        p_reason => 'eod_disinterest_close:not_interested');
      v_disinterest_closes := v_disinterest_closes + 1;

    elsif v_row.action = 'close_policy' then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-auto-cancel:' || v_row.delivery_id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.delivery_id, p_to_status => 'failed_delivery',
        p_reason => 'eod_auto_cancel:client_policy');
      v_policy_cancels := v_policy_cancels + 1;

    -- follow_up is handed back to the client (deferred_to_client), never rolled.
    elsif v_row.action = 'close_followup' then
      perform public.change_delivery_status(
        p_client_uuid => 'eod-followup-close:' || v_row.delivery_id::text || ':' || p_for_date::text,
        p_delivery_id => v_row.delivery_id, p_to_status => 'deferred_to_client',
        p_reason => 'eod_followup_close:excluded_from_rollover');
      v_followup_closes := v_followup_closes + 1;

    else
      -- 'roll' or 'cap_unserious': rollover_delivery rolls the row forward, or
      -- (when the carry cap is reached) closes it to unserious and returns null.
      v_new_child_id := public.rollover_delivery(
        p_client_uuid := 'eod:' || p_for_date::text || ':' || v_row.delivery_id::text,
        p_delivery_id := v_row.delivery_id,
        p_new_scheduled_date := (p_for_date + interval '1 day')::date,
        p_reason := p_reason, p_notify := false);

      if v_new_child_id is null then
        v_cap_hits := v_cap_hits + 1;
        if cardinality(v_capped_ids) < v_capped_ids_limit then
          v_capped_ids := array_append(v_capped_ids, v_row.delivery_id);
        else
          v_capped_overflow := v_capped_overflow + 1;
        end if;
      else
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  perform public._notify_admins_eod_summary(
    p_for_date := p_for_date, p_cap_hit_count := v_cap_hits,
    p_same_agent_count := v_same_agent_cancels, p_race_lost_count := v_cross_agent_cancels,
    p_capped_ids := v_capped_ids, p_policy_cancel_count := v_policy_cancels,
    p_sibling_resolved_count := v_sibling_resolved_cancels);

  if v_sibling_resolved_cancels > 0 then raise notice 'rollover: % cancelled because a sibling already settled the order', v_sibling_resolved_cancels; end if;
  if v_same_agent_cancels > 0 then raise notice 'rollover: % same-agent duplicates cancelled', v_same_agent_cancels; end if;
  if v_cross_agent_cancels > 0 then raise notice 'rollover: % cross-agent duplicates cancelled (race-lost or all-pending collapse)', v_cross_agent_cancels; end if;
  if v_cap_hits > 0 then raise notice 'rollover: % deliveries hit the carry cap and were marked unserious (% truncated)', v_cap_hits, v_capped_overflow; end if;
  if v_policy_cancels > 0 then raise notice 'rollover: % deliveries auto-cancelled by client policy (failed_delivery)', v_policy_cancels; end if;
  if v_followup_closes > 0 then raise notice 'rollover: % follow_up deliveries closed out to deferred_to_client (excluded from rollover)', v_followup_closes; end if;
  if v_disinterest_closes > 0 then raise notice 'rollover: % not_around/not_available deliveries closed to unserious (disinterest, excluded from rollover)', v_disinterest_closes; end if;

  return v_count;
end;
$function$
