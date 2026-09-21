BEGIN;
CREATE OR REPLACE FUNCTION reda_maintenance.classify(p_for_date date, p_ids uuid[] DEFAULT NULL)
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
CREATE OR REPLACE FUNCTION reda_maintenance.release_actions(p_due_date date,p_ids uuid[] DEFAULT NULL)
RETURNS TABLE(delivery_id uuid,action text,canonical_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance AS $$
 WITH eligible AS (
  SELECT d.*,coalesce(d.items_fingerprint,d.product_catalog_id::text) item_key,
   public._norm_address(d.raw_address) norm_addr,c.auto_cancel_soft_fails,
   EXISTS(SELECT 1 FROM public._find_sibling_deliveries(d.id) sibling JOIN public.delivery_status_defs sd ON sd.status=sibling.current_status
    WHERE sd.category='terminal' AND sibling.current_status NOT IN('agent_cancelled','rolled_over')
     AND NOT reda_maintenance.is_held(sibling.id,sibling.updated_at)) resolved
  FROM public.deliveries d JOIN public.clients c ON c.id=d.client_id
  WHERE d.current_status='postponed' AND d.order_type='delivery' AND d.deleted_at IS NULL
   AND d.scheduled_date<=p_due_date AND (p_ids IS NULL OR d.id=ANY(p_ids))
   AND NOT reda_maintenance.is_held(d.id,d.updated_at)
 ), clustered AS (
  SELECT e.*,coalesce((SELECT min(e2.id::text) FROM eligible e2
   WHERE e2.client_id=e.client_id AND e2.customer_phone_normalized=e.customer_phone_normalized
    AND e2.item_key=e.item_key AND e2.scheduled_date=e.scheduled_date
    AND (e2.id=e.id OR (e2.text_fingerprint IS NOT NULL AND e2.text_fingerprint=e.text_fingerprint)
      OR (e2.norm_addr IS NOT NULL AND e2.norm_addr=e.norm_addr))),e.id::text) cluster
  FROM eligible e
 ), ranked AS (
  SELECT c.*,row_number() OVER(PARTITION BY client_id,customer_phone_normalized,item_key,scheduled_date,cluster
    ORDER BY updated_at DESC,created_at,id) rank,
   first_value(id) OVER(PARTITION BY client_id,customer_phone_normalized,item_key,scheduled_date,cluster
    ORDER BY updated_at DESC,created_at,id) canonical
  FROM clustered c
 ) SELECT id,CASE WHEN resolved THEN 'sibling_resolved' WHEN rank>1 THEN 'dedup_postponed'
   WHEN auto_cancel_soft_fails THEN 'close_policy' ELSE 'release' END,canonical FROM ranked
$$;

CREATE OR REPLACE FUNCTION reda_maintenance.release_group(p_due_date date,p_ids uuid[],p_target date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,auth,reda_maintenance AS $$
DECLARE a record; d public.deliveries%rowtype; v_count int:=0; v_key text; v_target date;
BEGIN
 IF public.is_admin_or_dispatcher() IS NOT TRUE THEN RAISE EXCEPTION 'Operations role required' USING ERRCODE='42501'; END IF;
 IF p_due_date>reda_maintenance.release_through() THEN RAISE EXCEPTION 'Release date not due' USING ERRCODE='22023'; END IF;
 FOR a IN SELECT * FROM reda_maintenance.release_actions(p_due_date,p_ids) LOOP
  SELECT * INTO d FROM public.deliveries WHERE id=a.delivery_id FOR UPDATE;
  IF d.current_status<>'postponed' THEN CONTINUE; END IF;
  v_key:='maintenance-release:'||d.id||':'||md5(reda_maintenance.order_snapshot(d)::text);
  IF a.action<>'release' THEN
   PERFORM public.change_delivery_status(v_key,d.id,CASE WHEN a.action='close_policy' THEN 'failed_delivery' ELSE 'cancelled' END,
    'maintenance:'||a.action||'; canonical='||a.canonical_id);
   UPDATE public.deliveries SET assigned_agent_id=NULL WHERE id=d.id;
  ELSE
   v_target:=greatest(d.scheduled_date,p_target);
   INSERT INTO public.delivery_status_history(delivery_id,from_status,to_status,changed_by_user_id,client_uuid,reason,effective_at)
   VALUES(d.id,'postponed','pending',auth.uid(),v_key,'Postponed release from promised date '||d.scheduled_date||' to '||v_target,now());
   UPDATE public.deliveries SET current_status='pending',scheduled_date=v_target,assigned_agent_id=NULL,
    rolled_from_status='postponed',rolled_from_date=d.scheduled_date,updated_at=clock_timestamp() WHERE id=d.id;
   PERFORM public.write_audit('delivery',d.id,
    jsonb_build_object('current_status','postponed','scheduled_date',d.scheduled_date,'assigned_agent_id',d.assigned_agent_id),
    jsonb_build_object('current_status','pending','scheduled_date',v_target,'assigned_agent_id',NULL),'maintenance:release',auth.uid());
   v_count:=v_count+1;
  END IF;
 END LOOP;
 RETURN v_count;
END $$;
CREATE OR REPLACE FUNCTION public._eod_classify(p_for_date date)
RETURNS TABLE(delivery_id uuid,current_status text,action text,resolved_sibling_status text,resolved_sibling_label text,group_max_sort integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,reda_maintenance AS $$
 SELECT * FROM reda_maintenance.classify(p_for_date,NULL)
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reda_maintenance FROM PUBLIC,anon,authenticated,reda_maintenance_worker;
COMMIT;
