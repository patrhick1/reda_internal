-- Enforce readiness at the table boundary as well as in the handover RPC.
-- Existing RLS still denies authenticated direct writes. This also protects
-- older SECURITY DEFINER writers/imports if they attempt an active handover.
begin;
create or replace function public._same_customer_settlement_financial_lock()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_keys text[]:='{}';
begin
  if TG_OP<>'INSERT' then
    v_keys:=v_keys||array[case when old.subject_type='agent' then 'agent:'||old.subject_id::text
      else 'client:'||old.subject_id::text||':'||old.period_date::text end];
  end if;
  if TG_OP<>'DELETE' then
    v_keys:=v_keys||array[case when new.subject_type='agent' then 'agent:'||new.subject_id::text
      else 'client:'||new.subject_id::text||':'||new.period_date::text end];
  end if;
  perform public._same_customer_lock_financial_keys(v_keys,false);
  if TG_OP='DELETE' then return old; end if;
  -- Voiding must remain possible when late activity has made pay pending.
  -- Client settlements and pre-policy/shadow periods retain their existing rules.
  if new.subject_type='agent' and new.voided_at is null and exists(
    select 1 from public.same_customer_earnings where rider_id=new.subject_id
      and accounting_date=new.period_date and policy_applied and active
  ) then
    perform public._assert_same_customer_settlement_ready(new.subject_type,new.subject_id,new.period_date);
  end if;
  return new;
end $$;
revoke all on function public._same_customer_settlement_financial_lock() from public,anon,authenticated;
commit;
