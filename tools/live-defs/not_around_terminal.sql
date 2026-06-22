-- Reclassify `not_around` as a TERMINAL status (Uzo, 2026-06-22).
--
-- Rationale: saying "not around" reliably means the customer does NOT want the
-- product, not "try again later" — a customer who still wants it postpones. So
-- `not_around` should close the order outright instead of soft-failing and
-- rolling over.
--
-- This is a one-row data change. Every dependent behavior keys off the
-- `category` column, so nothing else has to change:
--   * Sibling cascade — tg_handle_sibling_coordination Stage 2 already
--     cancels open siblings on entry to ANY terminal status (except rolled_over /
--     agent_cancelled). So an agent marking `not_around` now closes the order for
--     every other agent racing the same customer. (Free; no trigger edit.)
--   * EOD rollover — run_eod_rollover's `eligible` CTE filters `category <>
--     'terminal'`, so `not_around` rows are no longer rolled. The old
--     disinterest branch that closed not_around -> unserious is now unreachable
--     for not_around (it still handles not_available). Harmless dead arm.
--   * EOD resolved-sibling backstop — a still-open sibling whose canonical row is
--     `not_around` is now cancelled as "another agent already handled this order".
--   * App — mobile mirrors this in STATUS_GROUPS (moved soft -> closed).
--
-- Reversible: set category back to 'soft_failure', needs_followup back to true.

begin;

update public.delivery_status_defs
   set category       = 'terminal',
       needs_followup = false
 where status = 'not_around';

-- Sanity check: exactly one row, now terminal.
do $$
declare v_cat text; v_followup boolean;
begin
  select category, needs_followup into v_cat, v_followup
    from public.delivery_status_defs where status = 'not_around';
  if v_cat is distinct from 'terminal' or v_followup is distinct from false then
    raise exception 'not_around reclassify failed: category=%, needs_followup=%', v_cat, v_followup;
  end if;
  raise notice 'not_around is now terminal (needs_followup=false).';
end $$;

commit;
