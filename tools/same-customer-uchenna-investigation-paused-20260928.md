# Uchenna Perpetual: same-customer investigation (paused)

Paused at the user's request on 28 September 2026. The user will ask Uzo about
the order history before deciding how to proceed. Do not change matching rules
or production records based on this investigation alone.

## Report and evidence

Screenshots from 18 September show NewLyfHerbs / Uchenna Perpetual / Arbutin
Cream / Festac / ₦19,500 on two riders' Available lists, without a Same customer
badge. One has a previous-postponement label.

Read-only production queries identified:

- `af8e79b4-edf2-46fb-a54b-cdd1a1b685ea`: created 15 September 22:31 UTC,
  assigned to Oluwaseun in the screenshot, scheduled for 18 September.
- `081f3364-852a-47da-bcff-3739c8445d1c`: created 18 September 08:28 UTC,
  assigned to Olawale, also scheduled for 18 September.
- Earlier chain record `65f7b461-d905-40be-8979-c1c44b45070c`: created
  15 September 09:19 UTC, scheduled for 15 September, now rolled_over.

The two screenshot records have equal normalized primary phone, deduplication
phone, items fingerprint, and normalized address. Their forwarded-text
fingerprints differ. Both use automatic matching, without a manual override.
Full contact details were not included in this report.

The deployed `_same_customer_day_orders(date)` matches the repository's
`supabase/migrations/20260915223000_same_customer_discovery.sql`: it first
collapses same-phone + same-items + (same-address OR same-forwarded-text)
copies into one logical order, then `_same_customer_day_groups(date)` looks
for multiple separate orders. This explains the absent group when both were
Available. Different riders do not prevent matching. Neither old creation dates
nor a previous postponement disqualifies an otherwise eligible order.

Status history (UTC):

- Older copy postponed 16 September 07:19, released 17 September 19:44,
  Available 18 September 07:03.
- Newer copy Available 18 September 08:39.
- Older copy changed to follow_up 18 September 09:57 with reason
  **“Duplicate order”**, then deferred_to_client at 19:45.
- Newer copy changed to follow_up at 15:51, tomorrow at 16:03, and cancelled
  at 19:45 with reason **“race lost, deduped on rollover”**.

These are current/historical database findings, not claims that we reproduced
the original screenshot session. No code or production records were changed.

## Questions and possible next step

The user answered “I'm not sure” when asked whether these were separate
purchases or a re-entered/forwarded copy of the postponed order. Live data
subsequently confirmed equal phones, so asking for the phone again is unnecessary.

Ask Uzo whether both records represented separate purchases needing separate
delivery, or whether the original order was sent again; and what warning he
expects when duplicate copies are assigned to different riders. The historical
“Duplicate order” note supports the latter classification but does not replace
his business confirmation.

A possible improvement discussed (not approved or implemented) is a distinct
duplicate-order / also-assigned-to-another-rider warning, preserving the
difference between duplicate copies and genuine separate same-customer orders.
