-- RLS performance sweep: the remaining policies (companion to
-- rls-hoist-stable-predicates.sql, which covered the delivery hot path).
--
-- Same fix, same reasoning: is_admin(), is_admin_or_dispatcher(), is_manager(),
-- is_warehouse() and auth.uid() were called bare in policy expressions. Postgres
-- cannot hoist a STABLE function that reads a table, so each was re-evaluated
-- ONCE PER ROW; the four is_* helpers are SECURITY DEFINER over public.users,
-- so every one of them is a sub-query per row.
--
-- Worst case on this box: audit_log has 538,642 rows and its SELECT policy is a
-- bare is_admin_or_dispatcher() -- i.e. over half a million SECURITY DEFINER
-- calls to read it once.
--
-- These statements were GENERATED from pg_policy, not hand-written: each
-- expression is its own pg_get_expr() output with the bare calls wrapped in
-- (SELECT ...) via a regex with a negative lookbehind (so already-fixed
-- policies are not double-wrapped). Nothing else about any expression changed,
-- so the semantics are identical and no policy is loosened or tightened.
--
-- ALTER POLICY leaves unspecified clauses untouched, so policies that only
-- needed USING keep their existing WITH CHECK, and vice versa.
--
-- Verified with a per-role parity harness (admin / rep / dispatcher / 2 agents)
-- counting visible rows across all 30 affected tables before and after.

BEGIN;

-- Fail fast rather than queueing behind in-flight readers.
SET LOCAL lock_timeout = '5s';

ALTER POLICY aml_all_admin ON public.address_match_log
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY aml_select_admin_dispatcher ON public.address_match_log
  USING ((SELECT is_manager()));
ALTER POLICY agent_departures_select ON public.agent_departures
  USING (((SELECT is_admin_or_dispatcher()) OR (SELECT is_warehouse()) OR (agent_id = (SELECT auth.uid()))));
ALTER POLICY alp_all_admin ON public.agent_location_preferences
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY agent_locations_admin_all ON public.agent_locations
  USING ((SELECT is_admin_or_dispatcher()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY agent_locations_self_read ON public.agent_locations
  USING ((agent_id = (SELECT auth.uid())));
ALTER POLICY agent_profiles_all_admin ON public.agent_profiles
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY ai_config_all_admin ON public.ai_config
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY ai_config_select_admin_dispatcher ON public.ai_config
  USING ((SELECT is_admin_or_dispatcher()));
ALTER POLICY audit_log_select_admin_dispatcher ON public.audit_log
  USING ((SELECT is_admin_or_dispatcher()));
ALTER POLICY bot_inbound_all_admin ON public.bot_inbound_messages
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY bot_inbound_select_admin_dispatcher ON public.bot_inbound_messages
  USING ((SELECT is_manager()));
ALTER POLICY calls_select_participants ON public.calls
  USING (((SELECT is_admin_or_dispatcher()) OR (caller_id = (SELECT auth.uid())) OR (callee_id = (SELECT auth.uid()))));
ALTER POLICY clients_all_admin ON public.clients
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY clients_select_ops_warehouse ON public.clients
  USING (((SELECT is_admin_or_dispatcher()) OR (SELECT is_warehouse())));
ALTER POLICY dlc_select_own ON public.delivery_location_changes
  USING (((requested_by_agent_id = (SELECT auth.uid())) OR (SELECT is_admin_or_dispatcher())));
ALTER POLICY delivery_status_defs_all_admin ON public.delivery_status_defs
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY dsh_insert_admin_dispatcher ON public.delivery_status_history
  WITH CHECK ((SELECT is_manager()));
ALTER POLICY delivery_status_transitions_all_admin ON public.delivery_status_transitions
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY edit_locks_select_admin_dispatcher ON public.edit_locks
  USING ((SELECT is_manager()));
ALTER POLICY feature_flags_all_admin ON public.feature_flags
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY feature_flags_select_admin_dispatcher ON public.feature_flags
  USING ((SELECT is_admin_or_dispatcher()));
ALTER POLICY locations_all_admin ON public.locations
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY mybot_inbound_select_admin ON public.mybot_inbound_messages
  USING ((SELECT is_manager()));
ALTER POLICY mybot_inbound_select_admin_dispatcher ON public.mybot_inbound_messages
  USING ((SELECT is_manager()));
ALTER POLICY products_all_admin ON public.product_catalog
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY push_tokens_self ON public.push_tokens
  USING ((user_id = (SELECT auth.uid())));
ALTER POLICY rate_card_all_admin ON public.rate_card
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY rate_card_select_admin_dispatcher ON public.rate_card
  USING ((SELECT is_admin_or_dispatcher()));
ALTER POLICY settlements_select_ops ON public.settlements
  USING ((SELECT is_admin_or_dispatcher()));
ALTER POLICY stock_adj_all_admin ON public.stock_adjustments
  USING ((SELECT is_admin()))
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY stock_adj_insert_warehouse_self ON public.stock_adjustments
  WITH CHECK (((agent_id = COALESCE(( SELECT users.warehouse_id
   FROM users
  WHERE (users.id = (SELECT auth.uid()))), (SELECT auth.uid()))) AND (( SELECT users.role
   FROM users
  WHERE (users.id = (SELECT auth.uid()))) = 'warehouse'::text)));
ALTER POLICY stock_adj_select_admin_dispatcher ON public.stock_adjustments
  USING (((( SELECT users.role
   FROM users
  WHERE (users.id = (SELECT auth.uid()))) = ANY (ARRAY['admin'::text, 'dispatcher'::text])) OR (agent_id = (SELECT auth.uid())) OR (agent_id = ( SELECT users.warehouse_id
   FROM users
  WHERE (users.id = (SELECT auth.uid()))))));
ALTER POLICY stock_counts_select ON public.stock_counts
  USING (((SELECT is_admin_or_dispatcher()) OR (SELECT is_warehouse())));
ALTER POLICY users_delete_admin ON public.users
  USING ((SELECT is_admin()));
ALTER POLICY users_insert_admin ON public.users
  WITH CHECK ((SELECT is_admin()));
ALTER POLICY users_update_admin ON public.users
  USING ((SELECT is_admin()));

COMMIT;
