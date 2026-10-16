-- Routine completions no longer notify admins. Preserve exception alerts and waybill behavior.
begin;
CREATE OR REPLACE FUNCTION public.tg_notify_delivery_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_notify_set text[] := array['cancelled','failed_delivery','unserious','no_product'];
begin
  if new.order_type <> 'waybill'
     and new.current_status = any(v_notify_set)
     and (TG_OP = 'INSERT' or old.current_status is distinct from new.current_status)
  then
    perform public.send_edge_notification(jsonb_build_object(
      'audience',    'status_change',
      'delivery_id', new.id,
      'new_status',  new.current_status
    ));
  end if;
  return new;
end;
$function$;
commit;
