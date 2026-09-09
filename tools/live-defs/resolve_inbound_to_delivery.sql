-- resolve_inbound_to_delivery as live on the box after the review-fix message change (2026-09-09).
-- Diff vs the pre-change capture (commit d5c578d): the copy-if-missing step + audit.
-- See supabase/migrations/20260909223000_review_fix_keeps_message.sql.

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
end $function$

