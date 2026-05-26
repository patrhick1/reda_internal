-- Seed data for local/dev. Re-runnable: deletes existing seed rows before inserting.
-- Filled in once schema is pulled and we know exact column names.
-- Plan target: 1 admin, 1 dispatcher, 2 agents, 1 warehouse user, 3 clients, 6 products, 5 locations, a rate card.
--
-- Auth users must be created via `supabase.auth.admin.createUser()` (REST/Edge function or psql via auth schema —
-- see https://supabase.com/docs/guides/auth/server-side/local-development for the local-dev pattern).
-- For local-only seeding we insert directly into auth.users + public.users with a known UUID.

-- TODO: fill in once schema is pulled. Tracked: supabase/migrations/<timestamp>_init.sql.
select 'seed.sql is a stub — fill in after schema pull' as note;
