\ir same-customer-test-fixtures.sql

-- The existing sibling trigger attributes automatic closure to this configured
-- service user. Create a synthetic profile with that ID in the empty clone.
insert into auth.users(id,email) values('2d8d5895-d2a8-4900-b15e-7662b176a805','sibling-service@example.invalid');
insert into public.users(id,email,display_name,role) values('2d8d5895-d2a8-4900-b15e-7662b176a805','sibling-service@example.invalid','TEST sibling service','admin');

insert into public.delivery_status_transitions(from_status,to_status) values('pending','delivered');
update public.deliveries set location_id=md5('same-customer-location')::uuid;
insert into public.delivery_items(delivery_id,product_catalog_id,quantity_ordered)
  select id,product_catalog_id,1 from public.deliveries;
insert into public.stock_adjustments(agent_id,product_catalog_id,quantity_delta,reason,created_by_user_id,client_uuid)
  select md5('same-customer-user-agent')::uuid,id,20,'found',md5('same-customer-user-admin')::uuid,'shadow-stock-'||id from public.product_catalog;
