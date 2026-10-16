-- The runner supplies the established synthetic payment fixture and rolls back.
create temporary table notification_requests(payload jsonb);
create or replace function public.send_edge_notification(p_body jsonb)
returns void language plpgsql as $$ begin
  insert into pg_temp.notification_requests values(p_body);
end $$;

-- Real delivery workflow: complete two orders through the same RPC used by the app.
update public.same_customer_pay_policy set active_from=(now() at time zone 'Africa/Lagos')::date,inactive_from=null;
select public.change_delivery_status(p_client_uuid:='notification-complete-'||n,
  p_delivery_id:=md5('same-customer-order-'||n)::uuid,p_to_status:='delivered',
  p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=now())
from generate_series(1,2) n;
select pg_temp.check_ok((select count(*)=2 and bool_and(current_status='delivered' and paid=10000 and quantity_delivered=1)
  from deliveries where id in(md5('same-customer-order-1')::uuid,md5('same-customer-order-2')::uuid)),
  'completion and collected amounts persist');
select pg_temp.check_ok((select count(*)=2 from delivery_status_history where client_uuid like 'notification-complete-%'),
  'completion history is recorded');
select pg_temp.check_ok((select sum(final_amount)=4500 and bool_and(final_state='ready') from same_customer_earnings where active),
  'established full/half rider earnings remain unchanged');
select pg_temp.check_ok(not exists(select 1 from notification_requests where payload->>'audience'='status_change' and payload->>'new_status'='delivered'),
  'completing an order sends no Delivered notification');
select public.change_delivery_status(p_client_uuid:='notification-complete-1',
  p_delivery_id:=md5('same-customer-order-1')::uuid,p_to_status:='delivered',
  p_quantity_delivered:=1,p_paid:=10000,p_payment_method:='transfer',p_effective_at:=now());
select pg_temp.check_ok((select count(*)=2 from delivery_status_history where client_uuid like 'notification-complete-%'),
  'retry does not duplicate completion');

-- Isolate the actual trigger for the INSERT/UPDATE/status matrix. Other business
-- triggers are already exercised above; this table deliberately has none of them.
create temporary table notification_delivery(id uuid primary key,current_status text,order_type text,paid numeric);
create trigger notify_delivery_status_change after insert or update on notification_delivery
for each row execute function public.tg_notify_delivery_status_change();
truncate notification_requests;
do $$ declare state text; n integer; row_id uuid; begin
  foreach state in array array['delivered','cancelled','failed_delivery','unserious','no_product','pending'] loop
    n:=case when state in('cancelled','failed_delivery','unserious','no_product') then 1 else 0 end;
    row_id:=gen_random_uuid();
    insert into notification_delivery values(row_id,state,'normal',0);
    perform pg_temp.check_ok((select count(*)=n from notification_requests),'INSERT alert policy: '||state);
    if n=1 then
      perform pg_temp.check_ok((select payload=jsonb_build_object('audience','status_change','delivery_id',row_id,'new_status',state) from notification_requests), 'original notification payload: '||state);
    end if;
    truncate notification_requests;
    update notification_delivery set paid=100 where id=row_id;
    perform pg_temp.check_ok(not exists(select 1 from notification_requests),'unrelated edits do not re-notify: '||state);
    delete from notification_delivery where id=row_id;
    insert into notification_delivery values(row_id,'available','normal',0);
    update notification_delivery set current_status=state where id=row_id;
    perform pg_temp.check_ok((select count(*)=n from notification_requests),'UPDATE alert policy: '||state);
    truncate notification_requests;
    insert into notification_delivery values(gen_random_uuid(),state,'waybill',0);
    row_id:=gen_random_uuid();
    insert into notification_delivery values(row_id,'available','waybill',0);
    update notification_delivery set current_status=state where id=row_id;
    perform pg_temp.check_ok(not exists(select 1 from notification_requests),'waybill remains silent: '||state);
  end loop;
end $$;
rollback;
