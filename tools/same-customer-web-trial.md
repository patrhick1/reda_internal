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


## Production result

Published successfully from commit `8f49512edb41b765af24cd862c263958804a912a`.
Vercel deployment `2LKzzE8itB7ENd4fhdrb8jrqUuBC` succeeded; GitHub security,
TypeScript, lint and formatting checks all passed. The production domain
`https://app.redalogisticss.com` returns HTTP 200 and serves the discovery-only
bundle `entry-82aba019d3a2e5914cb6f559c482aee5.js`. The sign-in screen loaded in
the browser. `tools/check-same-customer-web.mjs` verifies the live bundle includes
discovery and excludes the unfinished financial RPCs.

Final database check: discovery enabled, payout policy and earning tables absent,
zero identity decisions and zero assignment requests from testing. Temporary Test
Agent/Dispatcher sessions were revoked (HTTP 204), their local token file removed,
and test servers stopped. The isolated PostgreSQL database has zero users,
deliveries and earnings. No native update was published.

For Uzo: refresh the web app, open Deliveries → Same customer, and select a day.
14 September 2026 has two existing matching groups for inspection. Assignments
and customer-match corrections are real operational writes; the new full/half
pay rule is not active yet.


### Checkbox follow-up

Published checkbox selection in commit `e6d24c9`, Vercel deployment
`H2rCRVaTqD9pn6woskTZTTnN71TM`. Production serves
`entry-cdc22dbcf11690c9a22b358282cfd0f8.js`. Empty/checked squares retain checkbox
accessibility and a 44 px minimum tap target. Synthetic browser checks verified
selection/deselection and 390 px layout; TypeScript, lint, format, CI and deployment
passed. No database or payout changes accompanied this update.

## Web attention improvements — 16 September 2026

The Same customer chip shows the full filtered group count and turns amber when a
group has an open delivery and either multiple riders or an unassigned member.
Group cards use the same indicator. Admin Home adds a Today shortcut under Needs
attention; it opens today's group list and resets stale vendor/rider/search
filters. Fully completed groups do not trigger assignment attention. Separate
riders may be intentional, so the wording asks for review.

Known primary/linked groups no longer show the redundant Same customer action.
Alternate-phone candidates show Confirm customer match, retaining reasoned audit.

This release uses the existing discovery RPC and deliveries_safe read view;
no production database migration is required or included. Status and assignment
are read in batches of up to 200 IDs. Summary counts traverse every group page,
deduplicate groups, and reject incomplete/changing results instead of showing a
partial count. Queries refresh after assignment/correction, on focus, and every
30 seconds. A server aggregate is a future optimization for much larger volume.

The prepared attention SQL migration remains local and is excluded from this web
release. Automatic approval review rejected its production rehearsal; no rejected
command ran. The web-only implementation removes that dependency.

Validation: TypeScript and ESLint; isolated JavaScript checks for multiple pages,
same rider, completed deliveries, missing rows, changing totals and duplicate
pages. Previous UI validation covered primary/alternate correction labels,
assignment refresh and 390 px layout. No automatic assignments, payout activation,
production order edits or native OTA publication are included.

Published web-only as `77dd85e` on 16 September 2026. Vercel deployment
`GkW8ykRr99UKWQKbpUK1hJeAjaDa` and both CI jobs succeeded. Public page and bundle
returned HTTP 200; bundle `entry-cff39f9c2aa1ab1f3ffc958b09819476.js` includes
the updated match action and assignment review UI, uses the live API, and excludes
the payout engine. Production login rendered. Local browser checked the existing
API response shape, Home shortcut, group count, and selected primary-match actions.
Local fixture server stopped and test tabs closed.
