-- Smoke test for "review-fixed orders keep their WhatsApp message". Run AFTER
-- applying supabase/migrations/20260909223000_review_fix_keeps_message.sql.
-- Acts as the first active admin, creates throwaway inbound rows + deliveries,
-- asserts, and rolls everything back.
\set ON_ERROR_STOP on

begin;

select id as mgr_id from public.users
 where role = 'admin' and is_active order by created_at limit 1 \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'mgr_id', 'role', 'authenticated')::text, true);

do $$
declare
  v_actor    uuid := auth.uid();
  v_client   uuid;
  v_product  uuid;
  v_location uuid;
  v_text     text := 'SMOKE Name: Test Customer Phone: 08030000901 Address: 1 Smoke Street Product: Thing x1 Total: N5000';
  v_inbound  uuid;
  v_delivery uuid;
  v_row      public.deliveries%rowtype;
  v_n        integer;
begin
  select pc.client_id, pc.id into v_client, v_product
    from public.product_catalog pc join public.clients c on c.id = pc.client_id
   where pc.is_active and c.is_active order by pc.created_at limit 1;
  select id into v_location from public.locations where is_active order by name limit 1;

  -- 1. The backstop: a fix that did NOT pass the message (older bundle) still ends
  --    with the message on the delivery, plus the fingerprint, plus an audit row.
  insert into public.bot_inbound_messages(wasender_message_id, remote_jid, raw_payload, raw_text, status)
    values ('smoke:' || gen_random_uuid()::text, 'smoke', '{}'::jsonb, v_text, 'needs_review')
    returning id into v_inbound;
  insert into public.edit_locks(entity_type, entity_id, user_id, acquired_at)
    values ('bot_inbound', v_inbound, v_actor, now());
  v_delivery := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
    'Smoke Customer', '0803 000 0901', '1 Smoke Street, Lagos', 1, 5000, v_location);
  if (select bot_raw_message from public.deliveries where id = v_delivery) is not null then
    raise exception 'fixture: delivery should start without a message';
  end if;
  perform public.resolve_inbound_to_delivery(v_inbound, v_delivery);
  select * into v_row from public.deliveries where id = v_delivery;
  if v_row.bot_raw_message is distinct from v_text then
    raise exception 'backstop: message not copied (got %)', v_row.bot_raw_message;
  end if;
  if v_row.text_fingerprint is distinct from public._text_fingerprint(v_text) then
    raise exception 'backstop: fingerprint not derived';
  end if;
  if (select status from public.bot_inbound_messages where id = v_inbound) <> 'created_delivery'
     or (select delivery_id from public.bot_inbound_messages where id = v_inbound) <> v_delivery then
    raise exception 'backstop: inbound row not linked';
  end if;
  if exists (select 1 from public.edit_locks where entity_type = 'bot_inbound' and entity_id = v_inbound) then
    raise exception 'backstop: lock not released';
  end if;
  select count(*) into v_n from public.audit_log
   where entity_type = 'delivery' and entity_id = v_delivery and field_name = 'bot_raw_message'
     and reason like 'review fix:%';
  if v_n <> 1 then raise exception 'backstop: expected 1 audit row, got %', v_n; end if;
  raise notice 'PASS: a fix without the message still ends with it on the delivery (+ fingerprint, audited)';

  -- 2. The current app path passes the message at creation; the backstop must
  --    not overwrite it or audit anything.
  insert into public.bot_inbound_messages(wasender_message_id, remote_jid, raw_payload, raw_text, status)
    values ('smoke:' || gen_random_uuid()::text, 'smoke', '{}'::jsonb, v_text, 'needs_review')
    returning id into v_inbound;
  insert into public.edit_locks(entity_type, entity_id, user_id, acquired_at)
    values ('bot_inbound', v_inbound, v_actor, now());
  v_delivery := public.create_delivery('smoke:' || gen_random_uuid()::text, v_client, v_product,
    'Smoke Customer Two', '0803 000 0902', '2 Smoke Street, Lagos', 1, 5000, v_location,
    current_date, null, 'manual', v_text);
  perform public.resolve_inbound_to_delivery(v_inbound, v_delivery);
  select * into v_row from public.deliveries where id = v_delivery;
  if v_row.bot_raw_message is distinct from v_text or v_row.text_fingerprint is null then
    raise exception 'app path: message or fingerprint missing';
  end if;
  select count(*) into v_n from public.audit_log
   where entity_type = 'delivery' and entity_id = v_delivery and reason like 'review fix:%';
  if v_n <> 0 then raise exception 'app path: backstop audited although nothing changed'; end if;
  raise notice 'PASS: when the app passes the message, the backstop stays quiet';

  -- 3. Nothing is left behind by the backfill: every linked, review-fixed
  --    delivery now carries its message.
  select count(*) into v_n
    from public.bot_inbound_messages m join public.deliveries d on d.id = m.delivery_id
   where m.status = 'created_delivery' and m.raw_text is not null and d.bot_raw_message is null;
  if v_n <> 0 then raise exception 'backfill: % linked deliveries still lack the message', v_n; end if;
  raise notice 'PASS: no linked delivery is missing its message';

  -- 4. Guard: a manager without the edit lock is refused (unchanged behaviour).
  insert into public.bot_inbound_messages(wasender_message_id, remote_jid, raw_payload, raw_text, status)
    values ('smoke:' || gen_random_uuid()::text, 'smoke', '{}'::jsonb, v_text, 'needs_review')
    returning id into v_inbound;
  begin
    perform public.resolve_inbound_to_delivery(v_inbound, v_delivery);
    raise exception 'guard: resolved without holding the lock';
  exception when others then
    if sqlstate <> '55P03' then raise; end if;
  end;
  raise notice 'PASS: resolving without the edit lock is still refused';
end $$;

rollback;
