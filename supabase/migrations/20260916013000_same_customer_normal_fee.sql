-- Preserve normal fees independently of payable amounts. No payout activation.
begin;
alter table public.deliveries
  add column if not exists agent_payment_base_snapshot numeric(10,2),
  add column if not exists agent_payment_base_captured_at timestamptz;

create or replace function public._same_customer_normal_fee(d public.deliveries)
returns numeric language sql stable set search_path=public as $$
  select case when d.agent_payment_base_captured_at is not null then d.agent_payment_base_snapshot
    when e.delivery_id is not null then e.base_fee else d.agent_payment_snapshot end
  from (select 1) anchor left join public.same_customer_earnings e on e.delivery_id=d.id
$$;

create or replace function public._guard_same_customer_normal_fee()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_explicit boolean; v_enrolled boolean;
begin
  if TG_OP='INSERT' then
    v_explicit:=new.agent_payment_base_snapshot is not null or new.agent_payment_base_captured_at is not null;
  else
    v_explicit:=(new.agent_payment_base_snapshot,new.agent_payment_base_captured_at)
      is distinct from (old.agent_payment_base_snapshot,old.agent_payment_base_captured_at);
  end if;
  if v_explicit and current_user<>(select pg_get_userbyid(relowner) from pg_class where oid=TG_RELID) then
    raise exception 'normal rider fee must be changed through an authorized correction' using errcode='42501';
  end if;
  if new.order_type<>'delivery' then return new; end if;
  -- Existing unenrolled orders keep legacy rate behavior. Once an earning exists,
  -- payout-only updates cannot overwrite its normal baseline. Explicit normal-rate
  -- writers below set both fields atomically, including a deliberately NULL rate.
  if not v_explicit then
    if TG_OP='INSERT' then
      new.agent_payment_base_snapshot:=new.agent_payment_snapshot;
      new.agent_payment_base_captured_at:=clock_timestamp();
    elsif new.agent_payment_snapshot is distinct from old.agent_payment_snapshot then
      -- Invoker cannot read the private earning table. Use the private definer
      -- adapter to get the baseline without exposing financial records to callers.
      v_enrolled:=public._same_customer_has_earning(new.id);
      if not v_enrolled then
        new.agent_payment_base_snapshot:=new.agent_payment_snapshot;
        new.agent_payment_base_captured_at:=clock_timestamp();
      end if;
    end if;
  end if;
  return new;
end $$;

create or replace function public._same_customer_has_earning(p_id uuid)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
  if pg_trigger_depth()=0 then raise exception 'trigger-only helper' using errcode='42501'; end if;
  return exists(select 1 from public.same_customer_earnings where delivery_id=p_id);
end
$$;
-- This boolean is only used by the trigger and reveals no monetary amounts.
revoke all on function public._same_customer_has_earning(uuid) from public,anon;
grant execute on function public._same_customer_has_earning(uuid) to authenticated;
revoke all on function public._same_customer_normal_fee(public.deliveries),public._guard_same_customer_normal_fee() from public,anon,authenticated;
drop trigger if exists guard_same_customer_normal_fee on public.deliveries;
create trigger guard_same_customer_normal_fee before insert or update on public.deliveries
  for each row execute function public._guard_same_customer_normal_fee();

-- Temporary migration helper: exact, bounded source edits preserve all unrelated
-- deployed behavior, dependencies, owner and grants. Source drift aborts migration.
create or replace function pg_temp.patch_normal_fee(p_function regprocedure,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;
begin
  select pg_get_functiondef(p_function) into v_definition;
  if strpos(v_definition,p_new)>0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,p_old,'')))/length(p_old)<>1 then
    raise exception 'Unexpected source in %; inspect normal-fee integration',p_function;
  end if;
  execute replace(v_definition,p_old,p_new);
end $$;

select pg_temp.patch_normal_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'd.agent_payment_snapshot,', 'public._same_customer_normal_fee(d),');

-- A payout-only projection produces no shadow input change; avoid recalculating
-- unchanged groups (and future projection recursion) in that case.
select pg_temp.patch_normal_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'h public.delivery_status_history%rowtype; v_exists boolean;',
  'h public.delivery_status_history%rowtype; v_exists boolean; v_changed integer;');
select pg_temp.patch_normal_fee('public._sync_same_customer_shadow(uuid,uuid)',
  'perform public._recalculate_customer_day_pay(v_old_group);',
  E'get diagnostics v_changed = row_count;\n  if v_changed=0 then return; end if;\n  perform public._recalculate_customer_day_pay(v_old_group);');

select pg_temp.patch_normal_fee('public._apply_delivery_zone(uuid,uuid,text)',
  'agent_payment_snapshot = v_agent_payment,',
  E'agent_payment_snapshot = v_agent_payment,\n         agent_payment_base_snapshot = v_agent_payment,\n         agent_payment_base_captured_at = clock_timestamp(),');
select pg_temp.patch_normal_fee('public.correct_delivery_location(uuid,uuid,text)',
  'agent_payment_snapshot = v_agent_payment,',
  E'agent_payment_snapshot = v_agent_payment,\n         agent_payment_base_snapshot = v_agent_payment,\n         agent_payment_base_captured_at = clock_timestamp(),');
select pg_temp.patch_normal_fee('public.revert_location_change(uuid,text)',
  'agent_payment_snapshot = v_c.from_agent_payment,',
  E'agent_payment_snapshot = v_c.from_agent_payment,\n         agent_payment_base_snapshot = v_c.from_agent_payment,\n         agent_payment_base_captured_at = clock_timestamp(),');
select pg_temp.patch_normal_fee('public.update_delivery_fields(uuid,text,text,text,uuid,uuid,uuid,integer,numeric,uuid,text,jsonb,text)',
  'agent_payment_snapshot = case when v_rate_changed then v_agent_payment else agent_payment_snapshot end,',
  E'agent_payment_snapshot = case when v_rate_changed then v_agent_payment else agent_payment_snapshot end,\n    agent_payment_base_snapshot = case when v_rate_changed then v_agent_payment else agent_payment_base_snapshot end,\n    agent_payment_base_captured_at = case when v_rate_changed then clock_timestamp() else agent_payment_base_captured_at end,');

-- In this function every reference to the old payout is a normal-rate decision
-- or the fee stored for exact zone reversion. Keep the stored previous normal fee.
do $$ declare v_definition text; begin
  select pg_get_functiondef('public.agent_change_delivery_location(text,uuid,uuid,text)'::regprocedure) into v_definition;
  if strpos(v_definition,'public._same_customer_normal_fee(v_d)')=0 then
    if (length(v_definition)-length(replace(v_definition,'v_d.agent_payment_snapshot','')))/length('v_d.agent_payment_snapshot')<>3 then
      raise exception 'Unexpected agent zone change source; review normal fee references';
    end if;
    execute replace(v_definition,'v_d.agent_payment_snapshot','public._same_customer_normal_fee(v_d)');
  end if;
end $$;

select pg_temp.patch_normal_fee('public.rollover_delivery(text,uuid,date,text,boolean)',
  'coalesce(v_rate_agent_payment, v_old.agent_payment_snapshot)',
  'coalesce(v_rate_agent_payment, public._same_customer_normal_fee(v_old))');
select pg_temp.patch_normal_fee('public.rollover_delivery(text,uuid,date,text,boolean)',
  'rolled_from_status, rolled_from_date, delivery_instructions, client_rep',
  'rolled_from_status, rolled_from_date, delivery_instructions, client_rep, same_customer_key_override, same_customer_match_mode');
select pg_temp.patch_normal_fee('public.rollover_delivery(text,uuid,date,text,boolean)',
  'v_rolled_from_status, v_rolled_from_date, v_old.delivery_instructions, v_old.client_rep',
  'v_rolled_from_status, v_rolled_from_date, v_old.delivery_instructions, v_old.client_rep, v_old.same_customer_key_override, v_old.same_customer_match_mode');
select pg_temp.patch_normal_fee('public.rollover_delivery(text,uuid,date,text,boolean)',
  '''new_assigned_agent_id'', null,',
  E'''new_assigned_agent_id'', null,\n      ''normal_agent_payment'', v_agent_payment,\n      ''inherited_customer_key_override'', v_old.same_customer_key_override,\n      ''inherited_customer_match_mode'', v_old.same_customer_match_mode,');

drop trigger if exists same_customer_shadow_delivery on public.deliveries;
create trigger same_customer_shadow_delivery after update of current_status,deleted_at,customer_phone,
  same_customer_key_override,agent_payment_snapshot,agent_payment_base_snapshot,agent_payment_base_captured_at
  on public.deliveries for each row
  when ((old.current_status,old.deleted_at,old.customer_phone,old.same_customer_key_override,old.agent_payment_snapshot,
    old.agent_payment_base_snapshot,old.agent_payment_base_captured_at)
    is distinct from (new.current_status,new.deleted_at,new.customer_phone,new.same_customer_key_override,new.agent_payment_snapshot,
    new.agent_payment_base_snapshot,new.agent_payment_base_captured_at))
  execute function public._same_customer_shadow_delivery();
commit;
