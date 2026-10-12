begin;

-- Event-specific classification. Never infer an internal cause from the current
-- client policy or a free-text mention of "duplicate" alone.
create or replace function public.delivery_closure_kind(p_status text, p_reason text, p_key text)
returns text language sql immutable parallel safe set search_path=pg_catalog as $$
 select case
 when p_status='cancelled' and (
  (p_reason ~ '^maintenance:(manual_)?(dedup_same_agent|dedup_cross_agent|sibling_resolved|dedup_postponed)(; canonical=[0-9a-f-]+)?$'
    and p_key ~ '^maintenance(-release)?:')
  or (p_reason='race lost, deduped on rollover' and p_key like 'rollover-dedup-cross-agent:%')
  or (p_reason ~ '^duplicate not completed, (same-agent|cross-agent) deduped on rollover$' and p_key ~ '^rollover-dedup-(same|cross)-agent:')
  or (p_reason ~ '^.+ handled the same order \([^)]+\)\. Closed as duplicate\.$' and p_key like 'sibling-cancel:%')
  or (p_reason ~ '^Another agent already handled this order \([^)]+\)\. Closed as duplicate\.$' and p_key like 'rollover-sibling-resolved:%')
  or (p_reason ~ '^Duplicate postponed copy consolidated into order [0-9a-f-]+ for [0-9-]+\.$' and p_key like 'postpone-consolidate:%')
  or (p_reason ~ '^incident_eod_recovery:dedup_(same|cross)_agent$' and p_key like 'incident-eod-%')
 ) then 'duplicate'
 when p_status='failed_delivery' and (
  (p_reason='eod_auto_cancel:client_policy' and (p_key like 'eod-auto-cancel:%' or p_key like 'eod-autocancel-postponed:%'))
  or (p_reason ~ '^maintenance:(manual_)?close_policy(; canonical=[0-9a-f-]+)?$' and p_key ~ '^maintenance(-release)?:')
 ) then 'client_policy'
 else null end
$$;

create or replace function public.delivery_notification_required(p_status text,p_reason text,p_key text)
returns boolean language sql immutable parallel safe set search_path=pg_catalog,public as $$
 select coalesce(p_status <> all(array['pending','delivered','rolled_over','agent_cancelled',
  'deferred_to_client','unserious','picked_up','waybilled','replacement_completed'])
  and public.delivery_closure_kind(p_status,p_reason,p_key) is null,false)
$$;

-- Preserve all existing view columns, grants and security filters. Append fields
-- and reuse the existing indexed latest-event join. Fail closed on schema drift.
do $migration$
declare v_name text; v_sql text; v_before text;
begin
 foreach v_name in array array['deliveries_admin','deliveries_safe'] loop
  v_sql:=pg_get_viewdef(('public.'||v_name)::regclass,true);
  if position('AS notification_required' in v_sql)>0 then continue; end if;
  v_before:=v_sql;
  v_sql:=regexp_replace(v_sql,'SELECT h.id,\s*h.changed_at','SELECT h.id, h.reason, h.client_uuid, h.to_status, h.changed_at');
  if v_sql=v_before then raise exception 'Unexpected latest-history projection in %',v_name; end if;
  v_sql:=replace(v_sql,'ORDER BY h.changed_at DESC','ORDER BY h.changed_at DESC, h.id DESC');
  v_before:=v_sql;
  v_sql:=regexp_replace(v_sql,'\s+FROM deliveries d\s+',
   ', public.delivery_notification_required(d.current_status, case when lh.to_status=d.current_status then lh.reason end, case when lh.to_status=d.current_status then lh.client_uuid end) AS notification_required, public.delivery_closure_kind(d.current_status, case when lh.to_status=d.current_status then lh.reason end, case when lh.to_status=d.current_status then lh.client_uuid end) AS closure_kind FROM deliveries d ');
  if v_sql=v_before then raise exception 'Unexpected delivery projection in %',v_name; end if;
  -- Searchable views wrap the base projection; forward the appended fields
  -- through that outer SELECT as well (without changing old column order).
  v_sql:=regexp_replace(v_sql,'\s+FROM \( SELECT',', notification_required, closure_kind FROM ( SELECT');
  execute format('create or replace view public.%I as %s',v_name,v_sql);
 end loop;
end $migration$;

create or replace function public.list_delivery_history_chain_v3(p_delivery_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,auth as $$
 select coalesce(jsonb_agg(j.value || jsonb_build_object(
  'notification_required',public.delivery_notification_required(h.to_status,h.reason,h.client_uuid),
  'closure_kind',public.delivery_closure_kind(h.to_status,h.reason,h.client_uuid)) order by j.ordinality),'[]')
 from jsonb_array_elements(public.list_delivery_history_chain_v2(p_delivery_id)) with ordinality j(value,ordinality)
 join public.delivery_status_history h on h.id=(j.value->>'id')::uuid
$$;
revoke all on function public.list_delivery_history_chain_v3(uuid) from public,anon;
grant execute on function public.list_delivery_history_chain_v3(uuid) to authenticated;

-- Guard all write paths, including older clients. Internal events must not be
-- falsely recorded as client communication. Existing historical tags stay intact.
create or replace function public.guard_internal_client_notification()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if exists(select 1 from public.delivery_status_history h where h.id=new.status_history_id
   and public.delivery_closure_kind(h.to_status,h.reason,h.client_uuid) is not null) then
  raise exception 'This order was closed internally; no client notification is required' using errcode='22023';
 end if;
 return new;
end $$;
drop trigger if exists urgent_guard_internal_notification on public.delivery_client_notifications;
create trigger urgent_guard_internal_notification before insert on public.delivery_client_notifications
for each row execute function public.guard_internal_client_notification();

-- Agent-only restriction belongs before the status RPC mutates anything.
-- Patch the existing implementation instead of copying an obsolete large body.
do $migration$
declare v_oid regprocedure; v_sql text; v_before text;
begin
 select p.oid::regprocedure into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='change_delivery_status';
 v_sql:=pg_get_functiondef(v_oid);
 if position('urgent_agent_terminal_guard' in v_sql)=0 then
  v_before:=v_sql;
  v_sql:=regexp_replace(v_sql,'\mbegin\M', E'begin\n  -- urgent_agent_terminal_guard\n  if public.current_user_role() = ''agent'' and p_to_status in (''cancelled'',''failed_delivery'') then\n    raise exception ''Ask operations to close this delivery'' using errcode=''42501'';\n  end if;', 'i');
  if v_sql=v_before then raise exception 'Status function body changed'; end if;
  execute v_sql;
 end if;
end $migration$;

create or replace function public.rep_notify_coverage(p_from timestamptz,p_to timestamptz)
returns table(notifiable_updates bigint,notified bigint,pct_notified numeric,not_notified bigint,
 median_minutes_to_notify numeric,backlog_open bigint,oldest_open_update_age_minutes numeric,last_team_notify_at timestamptz)
language plpgsql stable security definer set search_path=public,auth as $$
begin
 if not coalesce(public.is_admin(),false) then raise exception 'not authorised to view rep performance' using errcode='42501'; end if;
 return query with events as (
  select h.id,h.changed_at from public.delivery_status_history h join public.deliveries d on d.id=h.delivery_id
  where d.deleted_at is null and h.changed_at>=p_from and h.changed_at<p_to
   and public.delivery_notification_required(h.to_status,h.reason,h.client_uuid)
 ), agg as (
  select count(*) total,count(n.notified_at) done,count(*) filter(where n.notified_at is null) pending,
   percentile_cont(0.5) within group(order by extract(epoch from(n.notified_at-e.changed_at))/60)
    filter(where n.notified_at is not null) median
  from events e left join public.delivery_client_notifications n on n.status_history_id=e.id
 ), backlog as (
  select count(*) total,extract(epoch from(now()-min(h.changed_at)))/60 age
  from public.deliveries d join lateral (
   select h.* from public.delivery_status_history h where h.delivery_id=d.id order by h.changed_at desc,h.id desc limit 1
  )h on true left join public.delivery_client_notifications n on n.status_history_id=h.id
  where d.deleted_at is null and n.status_history_id is null
   and public.delivery_notification_required(d.current_status,
    case when h.to_status=d.current_status then h.reason end,case when h.to_status=d.current_status then h.client_uuid end)
 )select agg.total,agg.done,case when agg.total=0 then 0::numeric else round(100.0*agg.done/agg.total,1) end,
 agg.pending,round(agg.median::numeric,1),backlog.total,round(backlog.age::numeric,1),
 (select max(n.notified_at) from public.delivery_client_notifications n) from agg,backlog;
end $$;
notify pgrst,'reload schema';
commit;
