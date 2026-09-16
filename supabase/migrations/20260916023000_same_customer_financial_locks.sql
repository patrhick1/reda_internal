-- Shared coordination for completion, correction and settlement. This does not
-- enable discounted payouts or change settlement formulas.
begin;

create or replace function public._same_customer_financial_keys(p_ids uuid[],p_extra_agents uuid[] default '{}')
returns text[] language sql stable security definer set search_path=public as $$
  select coalesce(array_agg(distinct k order by k) filter(where k is not null),'{}'::text[]) from (
    select 'agent:'||assigned_agent_id::text k from public.deliveries where id=any(p_ids)
    union all select 'agent:'||rider_id::text from public.same_customer_earnings where delivery_id=any(p_ids)
    union all select 'agent:'||x::text from unnest(p_extra_agents) x
    union all select 'client:'||client_id::text||':'||scheduled_date::text from public.deliveries where id=any(p_ids)
    union all select 'client:'||client_id::text||':'||(clock_timestamp() at time zone 'Africa/Lagos')::date::text
      from public.deliveries where id=any(p_ids)
    union all select 'agent:'||a.assigned_agent_id::text from public.replacement_attempts a where a.delivery_id=any(p_ids)
    union all select 'client:'||d.client_id::text||':'||(a.attempted_at at time zone 'Africa/Lagos')::date::text
      from public.replacement_attempts a join public.deliveries d on d.id=a.delivery_id where a.delivery_id=any(p_ids)
  ) keys
$$;

create or replace function public._same_customer_lock_financial_keys(p_keys text[],p_wait boolean default true)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_key text; v_nested boolean;
begin
  -- A nested operation may discover another subject after taking row/group locks.
  -- Never wait for a new outer lock in that case: roll back with a retryable error.
  select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory' and granted) into v_nested;
  for v_key in select distinct k from unnest(p_keys) k where k is not null order by k loop
    if p_wait and not v_nested then
      perform pg_advisory_xact_lock(hashtextextended('same-customer-finance:v1:'||v_key,0));
    elsif not pg_try_advisory_xact_lock(hashtextextended('same-customer-finance:v1:'||v_key,0)) then
      raise exception 'financial records changed concurrently; retry this operation' using errcode='40001';
    end if;
  end loop;
end $$;

create or replace function public._same_customer_lock_orders(p_ids uuid[],p_extra_agents uuid[] default '{}',p_wait boolean default true)
returns void language plpgsql security definer set search_path=public as $$ begin
  perform public._same_customer_lock_financial_keys(public._same_customer_financial_keys(p_ids,p_extra_agents),p_wait);
end $$;

-- Fallback for direct and older write paths. It runs after PostgreSQL may have
-- locked the row, so it can only TRY outer locks, never wait while holding rows.
create or replace function public._same_customer_delivery_financial_lock()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_keys text[]; v_ids uuid[];
begin
  if TG_OP='INSERT' then
    v_ids:=array[new.id];
    v_keys:=array['agent:'||new.assigned_agent_id::text,'client:'||new.client_id::text||':'||new.scheduled_date::text];
  elsif TG_OP='DELETE' then
    v_ids:=array[old.id];
    v_keys:=array['agent:'||old.assigned_agent_id::text,'client:'||old.client_id::text||':'||old.scheduled_date::text];
  else
    if (new.assigned_agent_id,new.client_id,new.scheduled_date,new.current_status,new.deleted_at,new.paid,
        new.agent_payment_snapshot,new.charged_snapshot,new.cash_pos_fee_snapshot,new.customer_phone,
        new.same_customer_key_override,new.agent_payment_base_snapshot,new.agent_payment_base_captured_at)
      is not distinct from
       (old.assigned_agent_id,old.client_id,old.scheduled_date,old.current_status,old.deleted_at,old.paid,
        old.agent_payment_snapshot,old.charged_snapshot,old.cash_pos_fee_snapshot,old.customer_phone,
        old.same_customer_key_override,old.agent_payment_base_snapshot,old.agent_payment_base_captured_at) then return new; end if;
    v_ids:=array[new.id];
    v_keys:=array['agent:'||old.assigned_agent_id::text,'agent:'||new.assigned_agent_id::text,
      'client:'||old.client_id::text||':'||old.scheduled_date::text,'client:'||new.client_id::text||':'||new.scheduled_date::text];
  end if;
  perform public._same_customer_lock_financial_keys(v_keys||public._same_customer_financial_keys(v_ids),false);
  if TG_OP='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists same_customer_financial_write_lock on public.deliveries;
create trigger same_customer_financial_write_lock before insert or update or delete on public.deliveries
  for each row execute function public._same_customer_delivery_financial_lock();

create or replace function public._same_customer_attempt_financial_lock()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_keys text[]:='{}'; v_id uuid; v_client uuid;
begin
  if TG_OP<>'INSERT' then
    select client_id into v_client from public.deliveries where id=old.delivery_id;
    v_keys:=v_keys||array['agent:'||old.assigned_agent_id::text,
      'client:'||v_client::text||':'||(old.attempted_at at time zone 'Africa/Lagos')::date::text];
    v_id:=old.delivery_id;
  end if;
  if TG_OP<>'DELETE' then
    select client_id into v_client from public.deliveries where id=new.delivery_id;
    v_keys:=v_keys||array['agent:'||new.assigned_agent_id::text,
      'client:'||v_client::text||':'||(new.attempted_at at time zone 'Africa/Lagos')::date::text];
    v_id:=new.delivery_id;
  end if;
  perform public._same_customer_lock_financial_keys(v_keys||public._same_customer_financial_keys(array[v_id]),false);
  if TG_OP='DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists same_customer_attempt_write_lock on public.replacement_attempts;
create trigger same_customer_attempt_write_lock before insert or update or delete on public.replacement_attempts
  for each row execute function public._same_customer_attempt_financial_lock();

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
  return new;
end $$;
drop trigger if exists same_customer_settlement_write_lock on public.settlements;
create trigger same_customer_settlement_write_lock before insert or update or delete on public.settlements
  for each row execute function public._same_customer_settlement_financial_lock();

create or replace function pg_temp.prepend_financial_lock(p_function regprocedure,p_statement text)
returns void language plpgsql as $$
declare v_definition text; v_body text; v_patched text;
begin
  select pg_get_functiondef(p_function),prosrc into v_definition,v_body from pg_proc where oid=p_function;
  if strpos(v_body,'-- same_customer_financial_outer_lock')>0 then return; end if;
  v_patched:=regexp_replace(v_body,E'(?im)^([ \\t]*)begin[ \\t]*\\r?$',
    E'begin\n  -- same_customer_financial_outer_lock\n  '||p_statement);
  if v_patched=v_body then raise exception 'Unexpected function body for financial lock: %',p_function; end if;
  execute replace(v_definition,v_body,v_patched);
end $$;

-- Main entry points wait for all known subjects before existing row locks.
do $$ declare r record; begin
  for r in select * from (values
    ('public.change_delivery_status(text,uuid,text,text,text,integer,numeric,text,timestamptz,date,jsonb)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.revert_delivery_to_pending(uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.correct_delivery_charge(uuid,numeric,numeric,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.correct_delivery_location(uuid,uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.correct_delivery_reda_charge(uuid,numeric,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.agent_change_delivery_location(text,uuid,uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.clear_delivery_location(uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.delete_delivery(uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.unassign_delivery(uuid,text)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.reassign_to_sub_agent(text,uuid,uuid)','array[p_delivery_id]','array[p_sub_agent_id]'),
    ('public.update_delivery_fields(uuid,text,text,text,uuid,uuid,uuid,integer,numeric,uuid,text,jsonb,text)','array[p_delivery_id]','array[p_assigned_agent_id]'),
    ('public.rollover_delivery(text,uuid,date,text,boolean)','array[p_delivery_id]','''{}''::uuid[]'),
    ('public.bulk_assign_deliveries(uuid[],uuid)','p_delivery_ids','array[p_agent_id]'),
    ('public.bulk_unassign_deliveries(text,uuid[],text)','p_delivery_ids','''{}''::uuid[]'),
    ('public.bulk_delete_deliveries(uuid[],text)','p_delivery_ids','''{}''::uuid[]'),
    ('public.bulk_change_delivery_status(text,uuid[],text,text)','p_delivery_ids','''{}''::uuid[]'),
    ('public.approve_location_change(uuid,text)','array(select delivery_id from public.delivery_location_changes where id=p_change_id)','''{}''::uuid[]'),
    ('public.revert_location_change(uuid,text)','array(select delivery_id from public.delivery_location_changes where id=p_change_id)','''{}''::uuid[]'),
    ('public.assign_same_customer_orders(uuid,uuid[],uuid)','p_delivery_ids','array[p_agent_id]'),
    ('public.review_same_customer_completion_day(uuid,uuid,bigint,date,text)','array[p_delivery_id]','''{}''::uuid[]')
  ) x(signature,ids,agents) loop
    perform pg_temp.prepend_financial_lock(r.signature::regprocedure,
      'perform public._same_customer_lock_orders('||r.ids||','||r.agents||');');
  end loop;
end $$;

-- Validate the customer-match payload first, then lock its subjects before the
-- request lock and delivery rows. Preserve the existing input error contract.
do $$ declare v_definition text; v_old text; begin
  select pg_get_functiondef('public.correct_delivery_customer_match(uuid,text,jsonb,text)'::regprocedure) into v_definition;
  v_old:='perform pg_advisory_xact_lock(hashtextextended(''same-customer-request:'' || p_request_id::text,0));';
  if strpos(v_definition,'perform public._same_customer_lock_orders(v_ids)')=0 then
    if strpos(v_definition,v_old)=0 then raise exception 'Unexpected identity correction lock source'; end if;
    execute replace(v_definition,v_old,'perform public._same_customer_lock_orders(v_ids); '||v_old);
  end if;
end $$;

select pg_temp.prepend_financial_lock('public.settle_period(text,uuid,date,text)',
  'perform public._same_customer_lock_financial_keys(array[case when p_subject_type=''agent'' then ''agent:''||p_subject_id::text when p_subject_type=''client'' then ''client:''||p_subject_id::text||'':''||p_period_date::text end]);');
select pg_temp.prepend_financial_lock('public.bulk_settle_agents(uuid,uuid[],date,text)',
  'perform public._same_customer_lock_financial_keys(array(select ''agent:''||id::text from unnest(p_agent_ids) id));');
select pg_temp.prepend_financial_lock('public.void_settlement(uuid,text)',
  'perform public._same_customer_lock_financial_keys(array(select case when subject_type=''agent'' then ''agent:''||subject_id::text else ''client:''||subject_id::text||'':''||period_date::text end from public.settlements where id=p_settlement_id));');

-- History can be inserted before the delivery UPDATE. Protect that early earning
-- mutation too, including nested stock/sibling workflows that hold row locks.
select pg_temp.prepend_financial_lock('public._sync_same_customer_shadow(uuid,uuid)',
  'perform public._same_customer_lock_orders(array[p_delivery_id],''{}''::uuid[],false);');

revoke all on function public._same_customer_financial_keys(uuid[],uuid[]),
  public._same_customer_lock_financial_keys(text[],boolean),public._same_customer_lock_orders(uuid[],uuid[],boolean),
  public._same_customer_delivery_financial_lock(),public._same_customer_attempt_financial_lock(),public._same_customer_settlement_financial_lock()
  from public,anon,authenticated;
commit;
