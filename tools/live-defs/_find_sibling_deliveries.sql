CREATE OR REPLACE FUNCTION public._find_sibling_deliveries(p_delivery_id uuid)
 RETURNS SETOF deliveries
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.*
    from public.deliveries d
    join public.deliveries s on
         s.id <> d.id
     and s.deleted_at is null
     and s.customer_phone_normalized is not null
     and s.customer_phone_normalized = d.customer_phone_normalized
     and s.product_catalog_id        = d.product_catalog_id
     and s.scheduled_date            = d.scheduled_date
     and (
       -- Tier 1: both sides have a fingerprint and they agree. Fast path
       -- for the common case where Uzo's forward arrived byte-identical.
       (d.text_fingerprint is not null
        and s.text_fingerprint is not null
        and d.text_fingerprint = s.text_fingerprint)
       OR
       -- Tier 2: same normalized address + same quantity. Fires whenever
       -- fingerprints DISAGREE (mutated forward) or either side is null
       -- (manual order). Phone + product + date are already enforced by
       -- the outer joins, so this cannot bleed across customers.
       (public._norm_address(d.raw_address) = public._norm_address(s.raw_address)
        and coalesce(d.quantity_ordered, 0) = coalesce(s.quantity_ordered, 0))
     )
   where d.id = p_delivery_id
     and d.customer_phone_normalized is not null
$function$

