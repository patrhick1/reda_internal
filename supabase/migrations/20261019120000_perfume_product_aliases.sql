begin;
-- Preserve the existing SKUs, stock history, display names and prior aliases.
-- Match old order wording after the catalog's October product renames.
do $$ begin
  if exists(select 1 from public.product_catalog
    where id in('67f486ef-d7c5-4934-8f54-4916abda42df','d36c6537-3d12-40ac-b14d-aaf46c805932')
      and (client_id is distinct from '2740824b-4f65-4901-abd5-6635aec0f044'::uuid or not is_active)) then
    raise exception 'Perfume product identity/active state changed; review before applying aliases';
  end if;
end $$;
update public.product_catalog p
set aliases=(select array_agg(distinct a order by a)
  from unnest(coalesce(p.aliases,'{}'::text[]) || v.names) a)
from (values
  ('67f486ef-d7c5-4934-8f54-4916abda42df'::uuid,array['Oud Al Layl Perfume','Arabiyat Oud Al Layl EDP','Arabiyat Oud Al Layl EDP Perfume','Arabiyat Oud Al Layl EDP 100ml Perfume For Men and Women']),
  ('d36c6537-3d12-40ac-b14d-aaf46c805932'::uuid,array['Pacific Blue Perfume','Maison Alhambra Pacific Blue EDP'])
) as v(id,names)
where p.id=v.id and p.client_id='2740824b-4f65-4901-abd5-6635aec0f044' and p.is_active;
commit;
