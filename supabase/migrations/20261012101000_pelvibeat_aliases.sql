begin;
-- Preserve the existing product ID, inventory/history and all existing aliases.
update public.product_catalog p set aliases=(select array_agg(distinct a order by a)
 from unnest(coalesce(p.aliases,'{}'::text[]) || array['PelviPulse','PelviPulse/NGN','PelviBeat','PelviBeat/NGN']) a)
where p.id='77ebcee5-198e-475e-8588-31571e028964'
 and p.client_id='179f4fb9-d513-4007-979b-d4271f815edd' and p.is_active;
-- A fresh empty test catalog is allowed; a conflicting identity is not.
do $$ begin
 if exists(select 1 from public.product_catalog where id='77ebcee5-198e-475e-8588-31571e028964'
  and (client_id<>'179f4fb9-d513-4007-979b-d4271f815edd' or not is_active)) then
  raise exception 'PelviBeat product identity/active state changed; review catalog before applying aliases';
 end if;
end $$;
commit;
