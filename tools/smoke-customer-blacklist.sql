-- Smoke test for the customer blacklist. Run AFTER applying
-- supabase/migrations/20260903231500_customer_blacklist.sql. Acts as the first
-- active admin, uses one real client/product/location, writes only rows that
-- the final rollback discards, and asserts every invariant with a PASS notice.
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
  v_r1       jsonb;
  v_r2       jsonb;
  v_hit      jsonb;
  v_hint     text;
  v_state    text;
  v_id       uuid;
  v_inbound  uuid;
  v_n        integer;
begin
  select pc.client_id, pc.id into v_client, v_product
    from public.product_catalog pc join public.clients c on c.id = pc.client_id
   where pc.is_active and c.is_active order by pc.created_at limit 1;
  select id into v_location from public.locations where is_active order by name limit 1;
  if v_client is null or v_location is null then
    raise exception 'fixture: need an active client/product and location';
  end if;

  -- 1. Add in one format; the entry stores the normalized key.
  v_r1 := public.add_customer_blacklist('+234 803 000 0001', 'smoke: fake orders across vendors');
  if v_r1->>'phone_normalized' <> '8030000001' or (v_r1->>'already_listed')::boolean then
    raise exception 'add: unexpected %', v_r1;
  end if;
  raise notice 'PASS: add stores normalized key % (open orders now: %)', v_r1->>'phone_normalized', v_r1->>'open_orders';

  -- 2. Re-adding the same number in another format is idempotent.
  v_r2 := public.add_customer_blacklist('08030000001', 'smoke: second attempt');
  if v_r2->>'id' <> v_r1->>'id' or not (v_r2->>'already_listed')::boolean then
    raise exception 'add: expected already_listed on same entry, got %', v_r2;
  end if;
  raise notice 'PASS: re-add returns the existing entry (already_listed)';

  -- 3. Every format matches; a different number does not.
  foreach v_hint in array array['+2348030000001', '2348030000001', '08030000001', '8030000001', '0803-000-0001'] loop
    v_hit := public.check_customer_blacklist(v_hint);
    if v_hit is null or v_hit->>'id' <> v_r1->>'id' or v_hit->>'matched_on' <> 'phone' then
      raise exception 'check: % should match, got %', v_hint, v_hit;
    end if;
  end loop;
  if public.check_customer_blacklist('08030000002') is not null then
    raise exception 'check: clean number matched';
  end if;
  v_hit := public.check_customer_blacklist('08030000002', '0803 000 0001');
  if v_hit is null or v_hit->>'matched_on' <> 'alt' then
    raise exception 'check: alt phone should match, got %', v_hit;
  end if;
  raise notice 'PASS: check matches +234 / 234 / 0 / bare / punctuated forms, and the alternate phone';

  -- 4. create_delivery refuses with the structured hint.
  begin
    perform public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
      'Smoke Customer', '0803 000 0001', '1 Smoke Street, Lagos', 1, 1000, v_location);
    raise exception 'create_delivery: expected refusal';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state <> 'P0001' or (v_hint::jsonb)->>'kind' <> 'blacklisted' then
      raise exception 'create_delivery: wrong refusal % %', v_state, v_hint;
    end if;
  end;
  raise notice 'PASS: create_delivery refuses a listed primary number (P0001 kind=blacklisted)';

  -- 5. bot_create_delivery refuses on the ALTERNATE number too, before dedupe.
  begin
    perform public.bot_create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
      'Smoke Customer', '0803 111 1111', '1 Smoke Street, Lagos', 1, 1000, v_location,
      current_date, 'smoke raw', null, '+234 803 000 0001');
    raise exception 'bot_create_delivery: expected refusal';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
    if v_state <> 'P0001' or (v_hint::jsonb)->>'kind' <> 'blacklisted'
       or (v_hint::jsonb)->>'matched_on' <> 'alt' then
      raise exception 'bot_create_delivery: wrong refusal % %', v_state, v_hint;
    end if;
  end;
  raise notice 'PASS: bot_create_delivery refuses a listed alternate number';

  -- 6. The list carries names and a zero block count for a fresh entry.
  select count(*) into v_n from public.list_customer_blacklist()
   where id = (v_r1->>'id')::uuid and added_by_name is not null and blocked_count = 0;
  if v_n <> 1 then raise exception 'list: entry missing or wrong shape'; end if;
  raise notice 'PASS: list shows the entry with the adder''s name';

  -- 7. A blocked bot row counts against its entry and can be re-queued.
  insert into public.bot_inbound_messages(wasender_message_id, remote_jid, raw_payload, raw_text, status, parse_result, error_text)
    values ('smoke:' || gen_random_uuid()::text, 'smoke', '{}'::jsonb, 'smoke', 'blocked',
            jsonb_build_object('blacklist', jsonb_build_object('entry_id', v_r1->>'id')), 'Blocked: smoke')
    returning id into v_inbound;
  select blocked_count into v_n from public.list_customer_blacklist() where id = (v_r1->>'id')::uuid;
  if v_n <> 1 then raise exception 'list: blocked_count should be 1, got %', v_n; end if;
  if public.requeue_failed_inbound(array[v_inbound]) <> 1 then
    raise exception 'requeue: blocked row not accepted';
  end if;
  if (select status from public.bot_inbound_messages where id = v_inbound) <> 'queued' then
    raise exception 'requeue: row not reset to queued';
  end if;
  raise notice 'PASS: blocked rows count on the entry and re-queue after removal';

  -- 8. Remove, then the same order goes through.
  perform public.remove_customer_blacklist((v_r1->>'id')::uuid, 'smoke: lifted');
  if public.check_customer_blacklist('08030000001') is not null then
    raise exception 'remove: entry still active';
  end if;
  perform public.remove_customer_blacklist((v_r1->>'id')::uuid, 'again');  -- idempotent
  v_id := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
      'Smoke Customer', '0803 000 0001', '1 Smoke Street, Lagos', 1, 1000, v_location);
  if v_id is null then raise exception 'create_delivery after removal returned null'; end if;
  raise notice 'PASS: after removal the number orders normally (delivery %, rolled back)', v_id;

  -- 9. Both directions audited. write_audit writes one row per changed field:
  --    the add logs phone_normalized (+ phone_display, reason); the remove
  --    logs removed_at (+ removal_note). Nothing else may appear as "changed".
  select count(*) into v_n from public.audit_log
   where entity_type = 'customer_blacklist' and entity_id = (v_r1->>'id')::uuid
     and field_name in ('phone_normalized', 'removed_at');
  if v_n <> 2 then raise exception 'audit: expected add + remove rows, got %', v_n; end if;
  select count(*) into v_n from public.audit_log
   where entity_type = 'customer_blacklist' and entity_id = (v_r1->>'id')::uuid
     and field_name not in ('phone_normalized', 'phone_display', 'reason', 'source_delivery_id',
                            'removed_at', 'removal_note');
  if v_n <> 0 then raise exception 'audit: unexpected field rows (%)', v_n; end if;
  raise notice 'PASS: add and remove both audited, per field';

  -- 10. Internal helpers are not callable by app roles.
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_customer_blacklist_hit', '_assert_customer_not_blacklisted')
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('service_role', p.oid, 'execute'));
  if v_n <> 0 then raise exception 'grants: internal helpers exposed to app roles'; end if;
  raise notice 'PASS: internal helpers are postgres-only';
end $$;

rollback;
