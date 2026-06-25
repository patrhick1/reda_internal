-- ============================================================================
-- Trigram indexes powering server-side deliveries search (Uzo, 2026-06-25).
--
-- The ops Deliveries list searches by customer name/phone. As the table grows
-- (~250-370 new rows/day), loading every row to filter client-side stops
-- scaling, so search moves server-side: `customer_name ILIKE '%q%' OR
-- customer_phone ILIKE '%q%'`, bounded by LIMIT, ignoring the date filter (you
-- search because you don't know the date).
--
-- A leading-wildcard ILIKE can't use a btree, so without these it's a seq scan
-- per keystroke. pg_trgm GIN indexes make it index-backed even through the
-- role views (deliveries_admin / deliveries_safe) — verified the planner pushes
-- the ILIKE to the base scan and uses a BitmapOr of both indexes. pg_trgm is
-- already installed (the bot's product matcher uses it).
-- ============================================================================

create index if not exists idx_deliveries_customer_name_trgm
  on public.deliveries using gin (customer_name gin_trgm_ops);

create index if not exists idx_deliveries_customer_phone_trgm
  on public.deliveries using gin (customer_phone gin_trgm_ops);
