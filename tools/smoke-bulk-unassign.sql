-- Smoke test for bulk_unassign_deliveries. Run AFTER applying
-- supabase/migrations/20260904003000_bulk_unassign_deliveries.sql. Acts as the
-- first active admin, creates three throwaway deliveries assigned to two real
-- agents, exercises the batch, and rolls everything back.
\set ON_ERROR_STOP on

begin;

select id as mgr_id from public.users
 where role = 'admin' and is_active order by created_at limit 1 \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'mgr_id', 'role', 'authenticated')::text, true);

do $$
declare
  v_client   uuid;
  v_product  uuid;
  v_location uuid;
  v_agent_a  uuid;
  v_agent_b  uuid;
  v_d1       uuid;
  v_d2       uuid;
  v_d3       uuid;
  v_closed   uuid;
  v_batch    text := gen_random_uuid()::text;
  v_mark     bigint;
  v_res      jsonb;
  v_n        integer;
  v_why      text;
begin
  select pc.client_id, pc.id into v_client, v_product
    from public.product_catalog pc join public.clients c on c.id = pc.client_id
   where pc.is_active and c.is_active order by pc.created_at limit 1;
  select id into v_location from public.locations where is_active order by name limit 1;
  select id into v_agent_a from public.users
   where role = 'agent' and is_active and parent_agent_id is null order by created_at limit 1;
  select id into v_agent_b from public.users
   where role = 'agent' and is_active and parent_agent_id is null and id <> v_agent_a
   order by created_at limit 1;
  select d.id into v_closed from public.deliveries d
    join public.delivery_status_defs sd on sd.status = d.current_status
   where sd.category = 'terminal' and d.deleted_at is null order by d.created_at desc limit 1;
  if v_client is null or v_location is null or v_agent_b is null or v_closed is null then
    raise exception 'fixture: need an active client/product/location, two agents and a closed delivery';
  end if;

  -- Fixtures: two rows on agent A, one on agent B (then taken back by the single path).
  v_d1 := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
    'Smoke One', '0803 000 0101', '1 Smoke Street, Lagos', 1, 1000, v_location, current_date, v_agent_a);
  v_d2 := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
    'Smoke Two', '0803 000 0102', '2 Smoke Street, Lagos', 1, 1000, v_location, current_date, v_agent_a);
  v_d3 := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
    'Smoke Three', '0803 000 0103', '3 Smoke Street, Lagos', 1, 1000, v_location, current_date, v_agent_b);

  -- 1. The single path still pushes per row (the flag is off outside a batch).
  select coalesce(max(id), 0) into v_mark from net.http_request_queue;
  perform public.unassign_delivery(v_d3, 'smoke single');
  select count(*) into v_n from net.http_request_queue q
   where q.id > v_mark and convert_from(q.body, 'utf8')::jsonb->>'title' = 'Order moved to the queue'
     and convert_from(q.body, 'utf8')::jsonb->>'user_id' = v_agent_b::text;
  if v_n <> 1 then raise exception 'single unassign: expected 1 per-row push, got %', v_n; end if;
  raise notice 'PASS: single unassign still sends its per-row push';

  -- 2. The batch: two live rows, one already queued, one closed, one unknown id.
  select coalesce(max(id), 0) into v_mark from net.http_request_queue;
  v_res := public.bulk_unassign_deliveries(v_batch,
    array[v_d1, v_d2, v_d3, v_closed, gen_random_uuid()], 'Wrong agent');
  if (v_res->>'unassigned_count')::integer <> 2 or (v_res->>'skipped_count')::integer <> 3 then
    raise exception 'batch: expected 2 unassigned / 3 skipped, got %', v_res;
  end if;
  raise notice 'PASS: batch unassigned 2 and skipped 3 (%)',
    (select string_agg(s->>'why', ' | ') from jsonb_array_elements(v_res->'skipped') s);
  if not exists (select 1 from jsonb_array_elements(v_res->'skipped') s where s->>'why' = 'already in the queue')
     or not exists (select 1 from jsonb_array_elements(v_res->'skipped') s where s->>'why' like 'closed (%')
     or not exists (select 1 from jsonb_array_elements(v_res->'skipped') s where s->>'why' = 'not found') then
    raise exception 'batch: skip reasons wrong: %', v_res->'skipped';
  end if;
  raise notice 'PASS: every skip carries a plain-language reason';
  if (select count(*) from public.deliveries where id in (v_d1, v_d2) and assigned_agent_id is null) <> 2 then
    raise exception 'batch: rows still assigned';
  end if;
  if jsonb_array_length(v_res->'agents') <> 1
     or (v_res->'agents'->0->>'agent_id')::uuid <> v_agent_a
     or (v_res->'agents'->0->>'count')::integer <> 2
     or v_res->'agents'->0->>'agent_name' is null then
    raise exception 'batch: agents summary wrong: %', v_res->'agents';
  end if;
  raise notice 'PASS: summary names the rider and how many rows left their list';

  -- 3. Exactly one summary push for agent A, and no per-row pushes.
  select count(*) into v_n from net.http_request_queue q
   where q.id > v_mark and convert_from(q.body, 'utf8')::jsonb->>'title' = 'Order moved to the queue';
  if v_n <> 0 then raise exception 'batch: % per-row pushes leaked', v_n; end if;
  select count(*) into v_n from net.http_request_queue q
   where q.id > v_mark
     and convert_from(q.body, 'utf8')::jsonb->'data'->>'kind' = 'bulk_unassign'
     and convert_from(q.body, 'utf8')::jsonb->>'user_id' = v_agent_a::text
     and (convert_from(q.body, 'utf8')::jsonb->'data'->>'count')::integer = 2;
  if v_n <> 1 then raise exception 'batch: expected 1 summary push for agent A, got %', v_n; end if;
  select count(*) into v_n from net.http_request_queue q where q.id > v_mark;
  if v_n <> 1 then raise exception 'batch: expected exactly 1 push in total, got %', v_n; end if;
  raise notice 'PASS: one summary push per rider, zero per-row pushes';

  -- 4. The flag is cleared after the batch: a later single unassign pushes again.
  if coalesce(current_setting('reda.suppress_assignment_push', true), '') = 'true' then
    raise exception 'flag: still set after the batch returned';
  end if;
  raise notice 'PASS: suppression flag cleared after the batch';

  -- 5. Audit rows carry the reason and the batch tag through the single path.
  select count(*) into v_n from public.audit_log
   where entity_id in (v_d1, v_d2) and field_name = 'assigned_agent_id' and new_value is null
     and reason like 'unassign: Wrong agent (bulk ' || left(v_batch, 8) || ')';
  if v_n <> 2 then raise exception 'audit: expected 2 tagged rows, got %', v_n; end if;
  raise notice 'PASS: audit rows tagged with reason + batch id';

  -- 6. Re-running the same batch is a no-op: everything skips, nothing pushes.
  select coalesce(max(id), 0) into v_mark from net.http_request_queue;
  v_res := public.bulk_unassign_deliveries(v_batch, array[v_d1, v_d2, v_d3, v_closed], 'Wrong agent');
  if (v_res->>'unassigned_count')::integer <> 0 or (v_res->>'skipped_count')::integer <> 4 then
    raise exception 'rerun: expected 0/4, got %', v_res;
  end if;
  select count(*) into v_n from net.http_request_queue q where q.id > v_mark;
  if v_n <> 0 then raise exception 'rerun: % pushes sent for a no-op batch', v_n; end if;
  raise notice 'PASS: retrying the batch is a silent no-op';

  -- 7. Guards.
  begin
    perform public.bulk_unassign_deliveries(v_batch, array[v_d1], '   ');
    raise exception 'guard: blank reason accepted';
  exception when others then
    get stacked diagnostics v_why = returned_sqlstate;
    if v_why <> '22023' then raise; end if;
  end;
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'bulk_unassign_deliveries'
     and has_function_privilege('authenticated', p.oid, 'execute')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v_n <> 1 then raise exception 'grants: authenticated must have execute, anon must not'; end if;
  raise notice 'PASS: blank reason refused; grants correct';
end $$;

rollback;
