-- Live policy before agent weekly count rollout, 2026-09-03.
drop policy if exists stock_counts_select on public.stock_counts;
create policy stock_counts_select on public.stock_counts for select to public using ((( SELECT is_admin_or_dispatcher() AS is_admin_or_dispatcher) OR ( SELECT is_warehouse() AS is_warehouse)));
