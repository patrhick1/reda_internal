-- resolve_inbound_to_delivery as live on the box, captured 2026-09-09 BEFORE it learned to copy
-- the WhatsApp message onto the delivery (supabase/migrations/20260909223000_review_fix_keeps_message.sql).

CREATE OR REPLACE FUNCTION public.resolve_inbound_to_delivery(p_inbound_id uuid, p_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$

begin

  if not public.is_manager() then

    raise exception 'permission denied' using errcode = '42501';

  end if;

  perform public._assert_holds_lock('bot_inbound', p_inbound_id);



  update public.bot_inbound_messages

     set status = 'created_delivery',

         delivery_id = p_delivery_id,

         processed_at = now()

   where id = p_inbound_id;

  if not found then

    raise exception 'inbound not found' using errcode = 'P0002';

  end if;



  -- Defence in depth: drop the lock here too (client also releases).

  delete from public.edit_locks

   where entity_type='bot_inbound' and entity_id=p_inbound_id;

end $function$

