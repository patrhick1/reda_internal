# Same-customer web trial

## Scope

This first release adds same-day customer matching to the web operations screens.
Open **Deliveries → Same customer**, select a scheduled day, and open a group to
compare its vendor orders, addresses, product/instruction details and riders.
Exact normalized primary phones are matches; alternate-phone links are labelled
possible matches. Admins and dispatchers explicitly select orders and a rider.
Representatives can inspect groups but cannot assign or correct identities.

Assignments and reasoned customer-match corrections affect real orders. There is
no automatic dispatch. Rider pay continues through the existing production rules.
The full-and-half payout engine, its financial readers, completion-day reviews,
and mobile OTA updates are excluded from this release.

## Database and rollout

Only `20260915223000_same_customer_discovery.sql` is applied. The discovery flag
defaults off. A server-local database backup and a rolled-back migration rehearsal
precede installation. The production preflight had 19,875 deliveries (22 MB), with
a largest day of 419 ordinary deliveries. A busiest-day group read took 42.814 ms
in that rehearsal. These timings are observations, not a throughput guarantee.

The source is isolated from the unfinished financial implementation. Deployment
uses the existing Vercel project and web domain. Enable `same_customer_discovery`
after migration and verified client deployment. No payout policy is installed.

Rollback: disable `same_customer_discovery` to hide discovery after refresh, and
restore the preceding Vercel deployment if needed. Keep the additive schema and
audit records; do not drop customer decisions or undo real assignments automatically.
The prior web revision was `ecb6569`.

## Validation and remaining work

The exact discovery-only schema must pass the isolated SQL suite; synthetic
fixtures are rolled back and the previous empty test database is restored. Check
the web build through authenticated read-only calls to the real API, without
creating production test orders or changing production assignments.

Before automatic payouts: finish old-client compatibility, remaining financial
correction races, historical backtesting, realistic load/migration rehearsal,
native/offline tests, and audited activation with a Lagos business-day boundary.
Before broader discovery UX: unrelated-phone manual search/linking, clearer
duplicate-copy visibility and unusually large contact-group handling remain.


## Release validation, 16 September 2026

- Exact discovery-only schema suite passed; 2,500 synthetic orders, recorded p95
  119.017 ms over ten local calls. All fixtures rolled back; original empty test
  database restored.
- Full TypeScript, ESLint, formatting checks and production web export passed.
- Production installation verified a fingerprint of every existing delivery's
  original fields before/after DDL; no original values changed.
- Real PostgREST checks passed for configuration, group listing, detail and badges
  on 14 September (two groups), dispatcher fee redaction and agent rejection.
- Local production web build using the real API rendered those groups, cross-vendor
  product/address/rider details and the trial notice. At 390 px, document width
  remained 390 px. No production assignment or customer correction was submitted.
- Payout migrations and native OTA publication are excluded.
