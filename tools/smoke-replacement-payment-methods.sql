-- Smoke test: replacement payments use the delivery vocabulary and cash rule.
-- Run AFTER supabase/migrations/20260909233000_replacement_payment_aligns_with_delivery.sql.
-- Creates one throwaway replacement off a real delivery, records payments in
-- every allowed shape, checks the client-side figures carry the ₦500 POS fee
-- on cash and nothing else, and rolls everything back.
\set ON_ERROR_STOP on

begin;

select id as mgr_id from public.users
 where role = 'admin' and is_active order by created_at limit 1 \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'mgr_id', 'role', 'authenticated')::text, true);

do $$
declare
  v_seed     public.deliveries%rowtype;
  v_rider    uuid;
  v_id       uuid;
  v_item     uuid;
  v_attempt  uuid;
  v_token    text := gen_random_uuid()::text;
  v_outcomes jsonb;
  v_day      date := (now() at time zone 'Africa/Lagos')::date;
  v_state    text;
  v_settle   uuid;
  v_amount   numeric;
begin
  select d.* into v_seed from public.deliveries d
    join public.current_stock st on st.agent_id = d.assigned_agent_id
     and st.product_catalog_id = d.product_catalog_id and st.quantity_on_hand >= 1
    join public.product_catalog p on p.id = d.product_catalog_id and p.is_active
   where d.order_type = 'delivery' and d.deleted_at is null and d.location_id is not null
     and not exists (select 1 from public.settlements s where s.voided_at is null and s.period_date = v_day
                       and ((s.subject_type = 'client' and s.subject_id = d.client_id)
                         or (s.subject_type = 'agent' and s.subject_id = d.assigned_agent_id)))
   limit 1;
  if v_seed.id is null then raise exception 'fixture: no delivery with rider stock today'; end if;
  v_rider := v_seed.assigned_agent_id;
  v_id := public.create_replacement(v_token || ':create', v_seed.client_id, 'Payment method rollback test',
    v_seed.customer_phone, null, v_seed.raw_address, v_seed.location_id, v_day, v_rider,
    jsonb_build_array(jsonb_build_object('product_catalog_id', v_seed.product_catalog_id, 'quantity', 1)),
    jsonb_build_array(jsonb_build_object('product_catalog_id', v_seed.product_catalog_id, 'quantity', 1, 'vendor_instruction', 'ask_if_damaged')),
    'other', 'Rollback', 3000, 1500);
  select id into v_item from public.replacement_return_items where delivery_id = v_id;
  v_outcomes := jsonb_build_array(jsonb_build_object('return_item_id', v_item, 'outcome', 'left_with_customer', 'quantity', 0));

  -- 1. "pos" is no longer a method; cash with no amount and to-vendor with an amount are refused.
  foreach v_state in array array['pos'] loop
    begin
      perform public.complete_replacement(v_token, v_id, v_outcomes, null, 1800, v_state, 'rider');
      raise exception 'method % accepted', v_state;
    exception when check_violation then null; end;
  end loop;
  begin
    perform public.complete_replacement(v_token, v_id, v_outcomes, null, 0, 'cash', null);
    raise exception 'cash with no amount accepted';
  exception when check_violation then null; end;
  begin
    perform public.complete_replacement(v_token, v_id, v_outcomes, null, 1800, 'vendor_direct', 'reda');
    raise exception 'to-vendor with an amount accepted';
  exception when check_violation then null; end;
  raise notice 'PASS: pos rejected; cash needs an amount; to-vendor means zero';

  -- 2. Cash: the attempt carries the ₦500 fee and every client-side figure subtracts it.
  perform public.complete_replacement(v_token, v_id, v_outcomes, null, 1800, 'cash', 'rider');
  select id into v_attempt from public.replacement_attempts where delivery_id = v_id;
  if (select cash_pos_fee from public.replacement_attempts where id = v_attempt) <> 500 then
    raise exception 'cash: fee not recorded on the attempt';
  end if;
  select amount into v_amount from public.client_financial_activity where entry_id = v_attempt;
  if v_amount <> 1800 - 3000 - 500 then raise exception 'cash: client activity % (expected -1700)', v_amount; end if;
  if not exists (select 1 from public.list_replacement_financials_rep_v2(v_day, v_day)
                  where attempt_id = v_attempt and remit = -1700 and cash_pos_fee = 500) then
    raise exception 'cash: rep report wrong';
  end if;
  if not exists (select 1 from public.list_replacement_financials_v2(v_day, v_day)
                  where attempt_id = v_attempt and cash_pos_fee = 500 and payment_method = 'cash') then
    raise exception 'cash: admin report wrong';
  end if;
  if (public.get_replacement_details(v_id)->'attempts'->0->>'cash_pos_fee')::numeric <> 500 then
    raise exception 'cash: detail payload missing the fee';
  end if;
  raise notice 'PASS: cash carries the 500 POS fee into the ledger, both reports and the detail';

  -- 3. Settlement: client side subtracts the fee; the rider side does not.
  v_settle := public.settle_period('client', v_seed.client_id, v_day, 'rollback');
  if not exists (select 1 from public.settlements s, jsonb_array_elements(s.snapshot->'by_delivery') x
                  where s.id = v_settle and x->>'attempt_id' = v_attempt::text
                    and (x->>'remit')::numeric = -1700 and (x->>'cash_pos_fee')::numeric = 500) then
    raise exception 'settle: client snapshot wrong';
  end if;
  update public.settlements set voided_at = now() where id = v_settle;
  v_settle := public.settle_period('agent', v_rider, v_day, 'rollback');
  if not exists (select 1 from public.settlements s, jsonb_array_elements(s.snapshot->'by_delivery') x
                  where s.id = v_settle and x->>'attempt_id' = v_attempt::text and (x->>'to_remit')::numeric = 300) then
    raise exception 'settle: rider should owe 1800 - 1500 = 300, fee is not theirs';
  end if;
  update public.settlements set voided_at = now() where id = v_settle;
  raise notice 'PASS: settlement charges the fee to the client, never the rider';

  -- 4. Correction to transfer drops the fee; to vendor zeroes everything.
  perform public.correct_replacement_payment(v_attempt, 3000, 1500, 'transfer instead', 1800, 'transfer', 'reda');
  if (select cash_pos_fee from public.replacement_attempts where id = v_attempt) <> 0
     or (select amount from public.client_financial_activity where entry_id = v_attempt) <> -1200 then
    raise exception 'correction to transfer: fee should drop to 0 and activity to -1200';
  end if;
  perform public.correct_replacement_payment(v_attempt, 3000, 1500, 'customer paid the vendor', 0, 'vendor_direct', null);
  if not exists (select 1 from public.replacement_attempts where id = v_attempt
                  and customer_paid = 0 and payment_method = 'vendor_direct'
                  and payment_received_by is null and cash_pos_fee = 0)
     or (select amount from public.client_financial_activity where entry_id = v_attempt) <> -3000 then
    raise exception 'correction to vendor: wrong row or activity';
  end if;
  begin
    perform public.correct_replacement_payment(v_attempt, 3000, 1500, 'bad', 1800, 'pos', 'rider');
    raise exception 'correction accepted pos';
  exception when check_violation then null; end;
  if (select count(*) from public.audit_log where entity_type = 'replacement_attempt' and entity_id = v_attempt
        and field_name = 'cash_pos_fee') < 1 then
    raise exception 'correction: fee change not audited';
  end if;
  raise notice 'PASS: corrections re-derive the fee and are audited; pos still refused';

  -- 5. The shared rule is not callable by app roles.
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname = '_validate_replacement_payment'
              and (has_function_privilege('authenticated', p.oid, 'execute')
                   or has_function_privilege('anon', p.oid, 'execute'))) then
    raise exception 'grants: validation helper exposed';
  end if;
  raise notice 'PASS: validation helper is internal';
end $$;

rollback;
