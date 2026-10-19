# Perfume matching repair — October 19, 2026

Implemented and tested locally for [#261](https://trello.com/c/f07Y46FS) and
[#292](https://trello.com/c/wcitQjac). Deployment is awaiting approval.

## Cause and scope

The October 12 gift policy (`8100613`) identified approved main perfumes by
display name. Subsequent catalog renames disabled that policy for regular Oud
Al Layl and Pacific Blue. The accessory list also did not recognize the reported
`Touch Concentrated Perfume Oil` wording. These combinations went to Review
instead of creating the intended order. A separately priced oil incorrectly
marked free could also bypass review because that longer name was unrecognized.

The real catalog matcher additionally selected Aswad for the legacy
`Oud Al Layl Perfume` wording after the regular product was renamed.

The repair:

- Keys gift eligibility to the existing 20 approved product IDs and vendor ID.
- Recognizes verified old/new names for the two renamed SKUs and the reported
  concentrated oil names, including the 5 ml alcohol-free wording.
- Adds old/new catalog aliases to those two existing SKUs, preserving existing
  aliases, names, ownership, active state, stock history and IDs.
- Retains review for wrong perfume variants, unapproved products, uncertain
  sizes, missing gift quantities, separately priced oil and unrelated vendors.

No price calculation, stock rule, duplicate rule, RPC signature or app UI changes.
The existing duplicate-aware creation RPC remains in use. There are no new
dependencies. The catalog update is idempotent and rejects changed ownership or
inactive target products. Its previous catalog values are recorded in
[`../live-defs/perfume_catalog_before_20261019.json`](../live-defs/perfume_catalog_before_20261019.json).

This repairs matching after an order reaches REDA. No inbound record was found
for the supplied #411 example; the contractor is investigating forwarding.
The already manually entered example was not replayed or changed.

## Acceptance criteria

For a received order containing one regular Oud Al Layl and two included Touch
Concentrated Perfume Oils, at a total of ₦32,500:

1. Create one order with one unit of the regular perfume, retaining both contact
   numbers and the ₦32,500 total.
2. Record `Included gifts: Perfume Oil ×2.` in delivery instructions. The oils
   must not add stock items or change the perfume quantity.
3. Retain original extracted lines and gift-policy audit data.
4. Accept verified legacy/current Oud and Pacific Blue names. Keep Aswad as a
   separate product and send uncertain variants to Review.
5. Keep separately priced oil in Review even if extraction also marks it free.
6. Retries cannot create a second order; a separate forwarding of an existing
   order is reviewed by the existing duplicate safeguards.

## Executed checks

| Check | Before repair | After repair |
| --- | --- | --- |
| Focused gift/handler tests | 16 failures, 17 passes; original 10 gift tests still passed | All 33 pass |
| Relevant parser suite, including existing Bowan/JQ/product/vendor/total tests | Not rerun in full against the old helper | 128 pass, 0 fail |
| Real SQL catalog matcher | Fails: legacy Oud selects the wrong SKU | Passes for legacy/current Oud and Pacific Blue; Aswad stays distinct |
| Real SQL order workflow | Matching assertion stopped the pre-fix run before creation | Passes: persisted quantity, total, contacts, packing notes, exact retry, forwarded duplicate and terminal duplicate |
| Catalog migration | Not applied in pre-fix run | Passes with one and two applications; inactive and wrong-vendor targets rejected; fixtures roll back |
| Parser TypeScript check and `git diff --check` | — | Pass |

There are **23 new Deno tests**: 9 gift-policy regression tests and 14 actual
parser-handler acceptance tests. The SQL checks are additional. Test fixtures
use synthetic customer data. The handler tests run the real parser and Supabase
HTTP client but substitute the model, address service, catalog and persistence
responses. SQL tests separately run the actual matcher and creation functions
against isolated PostgreSQL 17; outbound notification transport is stubbed.
These are not a live WhatsApp-to-phone test or a verification of model extraction.
Hosted CI and production acceptance have not run. CI is configured to run the
new tests on the normal repository events.

## Re-run

From the repository root, with Deno, Node and PostgreSQL available:

```sh
deno test --no-lock --node-modules-dir=none --allow-env=SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,INTERNAL_FUNCTION_SECRET,OPENROUTER_API_KEY supabase/functions/_shared/perfume-gifts.test.ts supabase/functions/_shared/perfume-gifts-regression.test.ts tools/perfume-matching-20261019/parser-acceptance.test.ts
deno check --no-lock --node-modules-dir=none supabase/functions/bot-parse-message/index.ts
```

The full 128-test command is the CI `Parser regression and acceptance` step.
Use the existing [isolated database setup](../eod-reliability-20260921/README.md)
with the empty `reda_eod_test` database and `reda_test` role on localhost:55449.
Run setup only for a fresh database, then:

```sh
node tools/perfume-matching-20261019/test-database.mjs
# Reproduces the legacy-name failure without applying the alias update:
node tools/perfume-matching-20261019/test-database.mjs --before
```

The database runner refuses other targets and rolls back fixtures and catalog
changes. It never applies this migration to production.

## Remaining integration acceptance after approval

Deploy the parser with its shared helper and apply the prepared alias update
together. Recheck the captured catalog identities and aliases first, and dry-run
the update in a transaction that rolls back before committing, following the
repository's self-hosted workflow. No mobile build or type regeneration is
needed because the API and schema signatures are unchanged.

On an approved test environment, using fresh synthetic customers and order IDs:

1. Submit the reported two product lines through the normal intake. Verify one
   created order appears in the app with one regular Oud, ₦32,500, both numbers,
   and two oils in its packing instructions. Repeat using the old Oud name and
   both Pacific Blue names.
2. Retry the same inbound event: verify one order. Forward the same order under
   a fresh message ID: verify duplicate review, with no second delivery.
3. Submit an oil with a separate price, then an uncertain 50 ml/Aswad mismatch:
   verify Review and no automatic delivery. Verify an explicit, correctly
   matched Aswad order retains the Aswad SKU.
4. With the contractor, confirm a fresh WhatsApp message reaches intake before
   assessing app creation. Do not replay #411, which already exists manually.

No production data, deployed function or Trello card was changed in this work.
