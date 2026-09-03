-- requeue_failed_inbound as live on the box after the customer blacklist change (2026-09-03).
-- Diff vs the pre-change capture (commit cfcb15e) is the blacklist assert only;
-- see supabase/migrations/20260903231500_customer_blacklist.sql.

CREATE OR REPLACE FUNCTION public.requeue_failed_inbound(p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id    uuid;
  v_count int := 0;
begin
  if not public.is_admin_or_dispatcher() then
    raise exception 'permission denied: admin or dispatcher only' using errcode = '42501';
  end if;

  for v_id in
    select id from public.bot_inbound_messages
    where id = any(p_ids) and status in ('error', 'blocked')
  loop
    -- Reset to the pre-parse state so the idempotency guard (status='queued')
    -- lets bot-parse-message process it again.
    update public.bot_inbound_messages
       set status       = 'queued',
           error_text   = null,
           parse_result = null,
           processed_at = null,
           delivery_id  = null
     where id = v_id;

    -- Re-fire the parser, mirroring the bot_parse_on_insert trigger.
    perform net.http_post(
      url     := 'http://kong:8000/functions/v1/bot-parse-message',
      headers := jsonb_build_object(
        'Content-type',      'application/json',
        'x-internal-secret', '49a5d28607c3554a3d5bb7763e686195fddca3e04cf69717541dafc554bf26bb'
      ),
      body    := jsonb_build_object('inbound_message_id', v_id)
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$

