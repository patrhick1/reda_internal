-- Smoke test for the stock-history product filter + running balance. Run AFTER
-- applying supabase/migrations/20260909120000_stock_history_product_filter.sql.
-- Read-only against real ledger rows, acting as the busiest active agent; still
-- wrapped in a transaction that rolls back, per the house rule.
\set ON_ERROR_STOP on

begin;

select sa.agent_id as agent_id
  from public.stock_adjustments sa join public.users u on u.id = sa.agent_id
 where u.role = 'agent' and u.is_active
 group by sa.agent_id order by count(*) desc limit 1 \gset
select set_config('request.jwt.claims',
  json_build_object('sub', :'agent_id', 'role', 'authenticated')::text, true);

do $$
declare
  v_agent     uuid := auth.uid();
  v_product   uuid;
  v_name      text;
  v_match     integer;
  v_other     integer;
  v_top       integer;
  v_ledger    integer;
  v_n         integer;
  v_p1_last   record;
  v_p2_first  record;
  v_state     text;
  v_other_agent uuid;
begin
  select sa.product_catalog_id, p.product_name into v_product, v_name
    from public.stock_adjustments sa join public.product_catalog p on p.id = sa.product_catalog_id
   where sa.agent_id = v_agent group by 1, 2 order by count(*) desc limit 1;

  -- 1. The product filter returns only that product.
  select count(*) filter (where m.product_catalog_id = v_product),
         count(*) filter (where m.product_catalog_id <> v_product)
    into v_match, v_other
    from public.list_stock_movements(v_agent, null, null, 50, null, null, null, v_product) m;
  if v_other <> 0 or v_match = 0 then
    raise exception 'product filter: % matching, % other rows', v_match, v_other;
  end if;
  raise notice 'PASS: product filter returns only "%" (% rows on the first page)', v_name, v_match;

  -- 2. The newest row's balance equals the ledger sum, i.e. current_stock.
  select m.balance_after into v_top
    from public.list_stock_movements(v_agent, null, null, 1, null, null, null, v_product) m;
  select coalesce(sum(quantity_delta), 0) into v_ledger
    from public.stock_adjustments where agent_id = v_agent and product_catalog_id = v_product;
  if v_top is distinct from v_ledger then
    raise exception 'balance: newest row says % but the ledger sums to %', v_top, v_ledger;
  end if;
  if v_ledger <> 0 and v_ledger <> (select quantity_on_hand from public.current_stock
                                     where agent_id = v_agent and product_catalog_id = v_product) then
    raise exception 'balance: ledger sum % disagrees with current_stock', v_ledger;
  end if;
  raise notice 'PASS: newest balance_after (%) equals current_stock', v_top;

  -- 3. Balances chain across a page boundary: older balance = newer balance − newer delta.
  select m.event_at, m.event_id, m.quantity_delta, m.balance_after into v_p1_last
    from public.list_stock_movements(v_agent, null, null, 5, null, null, null, v_product) m
   order by m.event_at asc, m.event_id asc limit 1;
  select m.event_at, m.event_id, m.quantity_delta, m.balance_after into v_p2_first
    from public.list_stock_movements(v_agent, v_p1_last.event_at, v_p1_last.event_id, 5, null, null, null, v_product) m
   order by m.event_at desc, m.event_id desc limit 1;
  if v_p2_first.event_id is null then
    raise notice 'SKIP: fewer than 6 movements for "%", page-boundary chain not testable', v_name;
  else
    if v_p2_first.balance_after <> v_p1_last.balance_after - v_p1_last.quantity_delta then
      raise exception 'balance chain broken across pages: % vs % - %',
        v_p2_first.balance_after, v_p1_last.balance_after, v_p1_last.quantity_delta;
    end if;
    if (v_p2_first.event_at, v_p2_first.event_id) >= (v_p1_last.event_at, v_p1_last.event_id) then
      raise exception 'paging: page 2 is not strictly older than page 1';
    end if;
    raise notice 'PASS: balances chain across the page boundary and paging stays strictly older';
  end if;

  -- 4. Without a product, balance_after is null on every row (nothing is computed).
  select count(*) into v_n
    from public.list_stock_movements(v_agent, null, null, 50) m where m.balance_after is not null;
  if v_n <> 0 then raise exception 'balance leaked without a product filter (% rows)', v_n; end if;
  raise notice 'PASS: no balance computed when not tracing a product';

  -- 5. Product + type filters compose.
  select count(*) filter (where m.product_catalog_id <> v_product or m.event_kind <> 'delivered')
    into v_n
    from public.list_stock_movements(v_agent, null, null, 50, null, array['delivered'], null, v_product) m;
  if v_n <> 0 then raise exception 'product + kinds: % rows escaped the filters', v_n; end if;
  raise notice 'PASS: product filter composes with the type filter';

  -- 6. The picker lists this product with the right count and on-hand.
  select count(*) into v_n from public.list_movement_products(v_agent) lp
   where lp.product_catalog_id = v_product
     and lp.movement_count = (select count(*) from public.stock_adjustments
                               where agent_id = v_agent and product_catalog_id = v_product)
     and lp.on_hand = v_ledger and lp.product_name = v_name;
  if v_n <> 1 then raise exception 'picker: product row missing or wrong'; end if;
  select count(*) into v_n from public.list_movement_products(v_agent) lp
   where not exists (select 1 from public.stock_adjustments sa
                      where sa.agent_id = v_agent and sa.product_catalog_id = lp.product_catalog_id);
  if v_n <> 0 then raise exception 'picker: % products that never moved on this holder', v_n; end if;
  raise notice 'PASS: picker lists the holder''s own moved products with counts and on-hand';

  -- 7. The seven-argument call shape older app bundles use still works.
  select count(*) into v_n from public.list_stock_movements(v_agent, null, null, 5, null, null, null) m;
  if v_n = 0 then raise exception 'legacy call shape returned nothing'; end if;
  raise notice 'PASS: legacy seven-argument call still works';

  -- 8. Another agent is refused, on both RPCs.
  select id into v_other_agent from public.users
   where role = 'agent' and is_active and id <> v_agent order by created_at limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other_agent, 'role', 'authenticated')::text, true);
  begin
    perform public.list_stock_movements(v_agent, null, null, 5, null, null, null, v_product);
    raise exception 'auth: another agent could read this history';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42501' then raise; end if;
  end;
  begin
    perform public.list_movement_products(v_agent);
    raise exception 'auth: another agent could list these products';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42501' then raise; end if;
  end;
  raise notice 'PASS: another agent is refused on both RPCs';
end $$;

rollback;
