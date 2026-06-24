-- ============================================================================
-- Retire the 'abandoned' delivery status (Uzo, 2026-06-24): agents found it
-- confusing and over-used it as a catch-all "give up" terminal. Going forward
-- they use `follow_up` + a free-text note instead.
--
-- We RETIRE, we do NOT delete. The status def can't be dropped — 12 live
-- deliveries + 20 delivery_status_history rows reference it and every FK is
-- ON DELETE RESTRICT; forcing it would mean rewriting audit history (destroying
-- the record that those orders were abandoned). Instead we remove every
-- transition INTO 'abandoned', so change_delivery_status rejects it
-- ('invalid transition: x -> abandoned') for agents AND admins.
--
-- Kept on purpose:
--   * the 'abandoned' -> * transitions  -> the 12 existing abandoned orders can
--     still be moved out / reopened (e.g. to follow_up).
--   * the status def + STATUS_META label -> historical rows still render.
--
-- Behavioural note: 'abandoned' was TERMINAL (closed); 'follow_up' is SOFT-FAIL
-- (stays open, rolls at EOD). Orders previously closed-as-abandoned now stay
-- open as follow_up and roll — but the soft-fail carry-cap auto-flips them to
-- 'unserious' after 2 carries, so they self-close. No code change needed (the
-- status picker reads delivery_status_transitions).
-- Reversible: re-insert the rows to restore the status.
-- ============================================================================

begin;
delete from public.delivery_status_transitions where to_status = 'abandoned';
commit;
