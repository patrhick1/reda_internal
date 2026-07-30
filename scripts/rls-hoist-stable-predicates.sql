-- RLS performance fix: hoist per-row helper calls into scalar subqueries.
--
-- PROBLEM
-- Policies call is_admin_or_dispatcher() / auth.uid() bare. Postgres cannot
-- hoist a STABLE function that reads a table, so it is re-evaluated ONCE PER
-- ROW. is_admin_or_dispatcher() is SECURITY DEFINER and queries public.users,
-- so a scan of deliveries (8,611 rows) fires 8,611 sub-queries.
--
-- Measured on the live box 2026-07-30, as an agent JWT:
--   SELECT 1 FROM deliveries WHERE (is_admin_or_dispatcher() OR assigned_agent_id = auth.uid());
--     -> Seq Scan, Execution Time: 4743.255 ms
--   SELECT 1 FROM deliveries WHERE ((SELECT is_admin_or_dispatcher()) OR assigned_agent_id = (SELECT auth.uid()));
--     -> Seq Scan + InitPlan, Execution Time: 27.220 ms      (175x faster)
--
-- Knock-on effect: the agent unread-badge query
-- (GET /delivery_messages?...&deliveries.scheduled_date=eq.<today>) averaged
-- 5,923 ms and was hitting the 8s statement_timeout, returning HTTP 500 to the
-- Expo app. It accounted for 41% of all database time over 54 days and 63% of
-- active-backend samples.
--
-- SEMANTICS: unchanged. Wrapping a zero-argument STABLE function or auth.uid()
-- in (SELECT ...) is logically identical -- it only tells the planner the value
-- is constant for the statement, so it becomes an InitPlan instead of a filter
-- expression. No policy is loosened or tightened; roles and commands are
-- preserved exactly as captured from pg_policies.
--
-- SCOPE: the five tables on the delivery hot path (list + detail screens). The
-- same anti-pattern exists in ~46 policies across 30 tables (see the audit
-- query at the bottom) -- worth sweeping once this is confirmed good.
--
-- Apply on the LIVE box:
--   ssh root@178.104.73.186
--   docker exec -i supabase-db psql -U postgres -d postgres < rls-hoist-stable-predicates.sql

BEGIN;

-- Fail fast rather than piling up behind the saturated box's in-flight queries.
-- ALTER POLICY needs a brief exclusive lock on the table; if it can't get one
-- quickly, abort and retry rather than blocking every reader behind us.
SET LOCAL lock_timeout = '5s';

-- ── public.deliveries ──────────────────────────────────────────────────────
-- The hot one: this policy is what makes the agent unread query seq-scan with
-- 8,611 SECURITY DEFINER calls.
ALTER POLICY deliveries_select_role_scoped ON public.deliveries
  USING (
    (SELECT public.is_admin_or_dispatcher())
    OR assigned_agent_id = (SELECT auth.uid())
  );

ALTER POLICY deliveries_delete_admin ON public.deliveries
  USING ((SELECT public.is_admin()));

ALTER POLICY deliveries_insert_admin_dispatcher ON public.deliveries
  WITH CHECK ((SELECT public.is_manager()));

ALTER POLICY deliveries_update_admin_dispatcher ON public.deliveries
  USING ((SELECT public.is_manager()))
  WITH CHECK ((SELECT public.is_manager()));

-- ── public.delivery_messages ───────────────────────────────────────────────
-- auth.uid() is hoisted in all three branches, including inside the EXISTS.
ALTER POLICY delivery_messages_select_participants ON public.delivery_messages
  USING (
    (SELECT public.is_admin_or_dispatcher())
    OR author_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_messages.delivery_id
        AND d.assigned_agent_id = (SELECT auth.uid())
    )
  );

-- ── Detail-screen tables ───────────────────────────────────────────────────
-- Same shape as delivery_messages: ops short-circuits on the first branch, an
-- agent falls through to the EXISTS. Opening one delivery reads all three.
ALTER POLICY delivery_items_select_role_scoped ON public.delivery_items
  USING (
    (SELECT public.is_admin_or_dispatcher())
    OR EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_items.delivery_id
        AND d.assigned_agent_id = (SELECT auth.uid())
    )
  );

ALTER POLICY dcn_select_ops_or_self_agent ON public.delivery_client_notifications
  USING (
    (SELECT public.is_admin_or_dispatcher())
    OR EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_client_notifications.delivery_id
        AND d.assigned_agent_id = (SELECT auth.uid())
    )
  );

ALTER POLICY delivery_followups_select_admin_dispatcher ON public.delivery_followups
  USING ((SELECT public.is_admin_or_dispatcher()));

COMMIT;

-- ── Verification ───────────────────────────────────────────────────────────
-- 1. Confirm the plan now uses InitPlan and runs in tens of ms.
--    Expect "Filter: ((InitPlan 1).col1 OR ...)" and no per-row function call.
--
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims',
--     '{"sub":"267187e9-ac48-4807-a083-74a708bba00c","role":"authenticated"}', true);
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT delivery_messages.delivery_id, row_to_json(d1.*)::jsonb
--   FROM delivery_messages
--   INNER JOIN LATERAL (
--     SELECT deliveries_1.scheduled_date, deliveries_1.current_status
--     FROM deliveries AS deliveries_1
--     WHERE deliveries_1.scheduled_date = (now() AT TIME ZONE 'Africa/Lagos')::date
--       AND deliveries_1.id = delivery_messages.delivery_id
--     LIMIT 1
--   ) AS d1 ON true
--   WHERE delivery_messages.author_role <> 'agent' AND delivery_messages.read_at IS NULL
--   LIMIT 1000;
-- ROLLBACK;
--
-- 2. Permission parity -- an agent must still see ONLY their own rows.
--    Run per role (agent / rep / dispatcher / admin) and compare counts to the
--    pre-change values before trusting this in the app.
--
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims', '{"sub":"<user-uuid>","role":"authenticated"}', true);
--   SELECT count(*) AS visible_deliveries FROM deliveries;
--   SELECT count(*) AS visible_messages   FROM delivery_messages;
-- ROLLBACK;
--
-- 3. Reset the stats window so the improvement is measurable from here.
--    SELECT pg_stat_statements_reset();

-- ── Audit: every remaining policy with the same anti-pattern ───────────────
-- SELECT c.relname AS table_name, p.polname,
--        pg_get_expr(p.polqual, p.polrelid) AS using_expr,
--        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
-- FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
-- WHERE pg_get_expr(p.polqual, p.polrelid)     ~ '(?<!select )(auth\.uid\(\)|is_admin\(\)|is_admin_or_dispatcher\(\)|is_manager\(\)|is_agent\(\))'
--    OR pg_get_expr(p.polwithcheck, p.polrelid) ~ '(?<!select )(auth\.uid\(\)|is_admin\(\)|is_admin_or_dispatcher\(\)|is_manager\(\)|is_agent\(\))'
-- ORDER BY 1, 2;
