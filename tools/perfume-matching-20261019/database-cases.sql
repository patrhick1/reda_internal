-- The real matcher must choose the regular perfume, never Aswad, for old wording.
select pg_temp.ok((select id='67f486ef-d7c5-4934-8f54-4916abda42df'::uuid from public.match_products_by_text('Oud Al Layl Perfume',0.4) order by score desc limit 1), 'legacy Oud name matches regular perfume after rename');
do $$ declare label text; begin
  foreach label in array array['Arabiyat Oud Al Layl EDP','Arabiyat Oud Al Layl EDP Perfume','Arabiyat Oud Al Layl EDP 100ml Perfume For Men and Women','Oud Al Layl Brown Single With Oil'] loop
    perform pg_temp.ok((select id='67f486ef-d7c5-4934-8f54-4916abda42df'::uuid from public.match_products_by_text(label,0.4) order by score desc limit 1),'correct Oud SKU: '||label);
  end loop;
  foreach label in array array['Pacific Blue Perfume','Maison Alhambra Pacific Blue EDP'] loop
    perform pg_temp.ok((select id='d36c6537-3d12-40ac-b14d-aaf46c805932'::uuid from public.match_products_by_text(label,0.4) order by score desc limit 1),'correct Pacific SKU: '||label);
  end loop;
end $$;
select pg_temp.ok((select id='5bd093a5-fbf8-4c8c-b6ac-7b5fff32fcb5'::uuid from public.match_products_by_text('Oud Al Layl Aswad',0.4) order by score desc limit 1),'Aswad keeps its own SKU');
select pg_temp.ok((select count(*)=4 from public.product_catalog),'no new stock products');
select pg_temp.ok(not exists(select 1 from public.product_catalog p join catalog_before b using(id)
  where p.product_name<>b.product_name or p.is_active<>b.is_active or p.client_id<>b.client_id
    or not coalesce(p.aliases,'{}') @> coalesce(b.aliases,'{}')), 'catalog names, ownership, active states and prior aliases preserved');

-- Real creation RPC: the exact contract asserted by the parser acceptance test.
create function pg_temp.gift(request_key text) returns uuid language sql as $$
  select public.bot_create_delivery_with_gifts(request_key,'2740824b-4f65-4901-abd5-6635aec0f044',
    '67f486ef-d7c5-4934-8f54-4916abda42df','Test Recipient','08000000001','Test road, Lagos',1,32500,
    p_scheduled_date=>date '2030-01-02',p_customer_phone_alt=>'08000000002',
    p_items=>'[{"product_catalog_id":"67f486ef-d7c5-4934-8f54-4916abda42df","quantity_ordered":1,"customer_price":null}]',
    p_delivery_instructions=>'Included gifts: Perfume Oil ×2.')
$$;
create temporary table gift_result as select pg_temp.gift('perfume-411') id;
select pg_temp.ok((select count(*)=1 and sum(quantity_ordered)=1 from delivery_items where delivery_id=(select id from gift_result)),'one perfume unit; oils do not affect inventory');
select pg_temp.ok((select customer_price=32500 and quantity_ordered=1 and customer_phone='08000000001' and customer_phone_alt='08000000002'
  and delivery_instructions='Included gifts: Perfume Oil ×2.' and created_via='bot'
  from deliveries where id=(select id from gift_result)),'total, both contacts and packing notes persist');
select pg_temp.ok(pg_temp.gift('perfume-411')=(select id from gift_result),'exact retry returns the existing order');
do $$declare hint text;begin
  begin perform pg_temp.gift('perfume-411-forwarded-again');raise exception 'Duplicate accepted';
  exception when sqlstate 'P0001' then get stacked diagnostics hint=pg_exception_hint;
    perform pg_temp.ok(hint::jsonb->>'kind'='gift_duplicate_review','new message for same order requires review');end;
end $$;
update deliveries set current_status='cancelled' where id=(select id from gift_result);
do $$declare hint text;begin
  begin perform pg_temp.gift('perfume-411-terminal-retry');raise exception 'Terminal duplicate accepted';
  exception when sqlstate 'P0001' then get stacked diagnostics hint=pg_exception_hint;
    perform pg_temp.ok(hint::jsonb->>'kind'='gift_duplicate_review','terminal order still protected');end;
end $$;
select pg_temp.ok((select count(*)=1 from deliveries),'all retries leave one order');
rollback;
