-- Review-fixed orders keep their WhatsApp message.
--
-- Greg's card (2026-09-09): warehouse assistants pack from the original
-- WhatsApp message. When the bot could not place an order it went to Needs
-- Review, and the fix there created the delivery through the same call as a
-- hand-typed order — without the message. The inbound row was linked to the
-- delivery afterwards, but only its status changed. Every review-fixed order
-- therefore showed as "added manually" on the packing screen: 291 of 291 in
-- the last 30 days, 578 all time, and the assistants went to find Miss Mary.
--
-- Three parts:
--   1. The app now passes the message at creation (create_delivery already
--      stores it and derives the sibling fingerprint from it).
--   2. This RPC, which links the inbound row to the delivery, copies the
--      message onto the delivery when it is still missing — a backstop for
--      phones on older bundles and for any future path that forgets.
--   3. A one-off backfill of the 578 existing rows, audited per row.
-- Deliveries stay created_via = 'manual': a person confirmed them. Only the
-- message travels.
begin;

-- Identical to tools/live-defs/resolve_inbound_to_delivery.sql (captured
-- 2026-09-09) plus the copy-if-missing step. Privileges are retained by
-- CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.resolve_inbound_to_delivery(p_inbound_id uuid, p_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_text  text;
begin
  if not public.is_manager() then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  perform public._assert_holds_lock('bot_inbound', p_inbound_id);
  update public.bot_inbound_messages
     set status = 'created_delivery',
         delivery_id = p_delivery_id,
         processed_at = now()
   where id = p_inbound_id
   returning raw_text into v_text;
  if not found then
    raise exception 'inbound not found' using errcode = 'P0002';
  end if;

  -- Backstop: the delivery must carry the WhatsApp message it came from.
  -- The current app passes it at creation; older bundles did not.
  if v_text is not null then
    update public.deliveries d
       set bot_raw_message  = v_text,
           text_fingerprint = coalesce(d.text_fingerprint, public._text_fingerprint(v_text))
     where d.id = p_delivery_id
       and d.bot_raw_message is null;
    if found then
      perform public.write_audit('delivery', p_delivery_id,
        jsonb_build_object('bot_raw_message', null),
        jsonb_build_object('bot_raw_message', v_text),
        'review fix: WhatsApp message retained on the delivery', v_actor);
    end if;
  end if;

  -- Defence in depth: drop the lock here too (client also releases).
  delete from public.edit_locks
   where entity_type='bot_inbound' and entity_id=p_inbound_id;
end $function$;

-- One-off backfill. Every delivery that a review fix created without its
-- message gets it from the inbound row that was resolved into it (the
-- earliest such row when a duplicate forward was later linked as well).
-- Audited per row as the Reda System user; nothing else on the row changes.
do $$
declare
  v_system uuid;
  v_n      integer := 0;
  r        record;
begin
  select id into v_system from public.users where lower(email) = 'system@reda.local';
  if v_system is null then
    raise exception 'Reda System user not found; backfill cannot be audited';
  end if;
  for r in
    select d.id as delivery_id, m.raw_text
      from public.deliveries d
      join lateral (
        select i.raw_text
          from public.bot_inbound_messages i
         where i.delivery_id = d.id
           and i.status = 'created_delivery'
           and i.raw_text is not null
         order by i.received_at asc
         limit 1
      ) m on true
     where d.bot_raw_message is null
  loop
    update public.deliveries
       set bot_raw_message  = r.raw_text,
           text_fingerprint = coalesce(text_fingerprint, public._text_fingerprint(r.raw_text))
     where id = r.delivery_id;
    perform public.write_audit('delivery', r.delivery_id,
      jsonb_build_object('bot_raw_message', null),
      jsonb_build_object('bot_raw_message', r.raw_text),
      'backfill: review-fixed order keeps its WhatsApp message', v_system);
    v_n := v_n + 1;
  end loop;
  raise notice 'backfill: % review-fixed deliveries now carry their WhatsApp message', v_n;
end $$;

notify pgrst, 'reload schema';
commit;
