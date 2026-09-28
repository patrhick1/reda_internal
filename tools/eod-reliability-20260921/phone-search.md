# Phone search — September 28, 2026

The existing order search now treats Nigerian phone formatting consistently.
For example, `08033165485`, `+234 803 316 5485`, `2348033165485`,
`8033165485`, `(0803) 316 5485` and `0803-316-5485` find the same orders.
The `00234` dialling prefix and `+234 (0)` notation are covered too.
Both primary and alternate contacts can match. Partial phone searches require
at least three digits. Name searches continue to work in the existing box.

## Implementation and boundaries

- One search-only TypeScript helper supplies server filters and the instant
  client filter used in Deliveries, Unassigned and Postponed. Previously the
  server compared stripped input against raw storage, while the client could
  discard valid results using another raw-text comparison.
- The shared delivery service also supplies the previous-delivery search on
  the Home replacement flow. Separate Failed and Same customer RPCs now use
  equivalent phone rules while preserving their existing scopes and grouping.
- The database exposes search expressions through the existing role-scoped
  views. Partial GIN trigram indexes cover primary and alternate phone values
  of non-deleted orders. Index values are maintained automatically on edits;
  orders are not rewritten or downloaded to search all history.
- The main search still spans dates, limits results to 100 and retains the
  existing debounce and request cancellation. The date-scoped Failed and
  Same customer RPCs retain their existing bounds.
- Original contact strings, identity/grouping normalizers, assignments,
  payment rules and financial values are unchanged. Normalizing a search
  does not merge customers or excuse a mistyped digit. Prefix interpretation
  is explicitly Nigerian; this is not a general international-number parser.
- No new UI modes, controls or screens.

## Validation

`mobile/src/lib/delivery-search.test.mjs` covers the input/storage format
matrix, alternate numbers, fragments (including internal `031` and `234`),
names, mismatches, nulls and PostgREST grammar characters.

`test-phone-search.mjs` runs only against the isolated synthetic database and
local PostgREST. It checks real role-scoped view projections and relationship
embedding, admin/dispatcher/agent visibility, soft deletion, unchanged rows
after searches, Failed and Same customer RPCs, edited phones, the 100-result
cap and index use through the view with 20,011 synthetic orders.
The local EXPLAIN ANALYZE runs used both normalized indexes and measured
31.302 ms for a full number and 15.102 ms for a five-digit fragment. These
are local database measurements, not a production end-to-end latency claim.

With `--browser`, the exported app calls that actual API. At widths 390 and
1280 the test exercises equivalent formats, an alternate contact, partial
digits, names, no results, and previous-delivery replacement search.

Commands from the worktree root (PostgreSQL/PostgREST test servers required):

```text
node --experimental-strip-types --test mobile/src/lib/delivery-search.test.mjs
node --experimental-strip-types tools/eod-reliability-20260921/test-phone-search.mjs --browser
node tools/eod-reliability-20260921/test-runner.mjs
node tools/manual-fee-waivers/test-runner.mjs
```

The phone tests are included in CI's existing isolated database/browser job.
Mobile typecheck, lint, formatting and web export are also checked.

## Release order

This change is local and has not been published. Apply
`20260928180000_delivery_phone_search.sql` before publishing the updated app:
the new client filters require the added view columns. Existing clients can
continue using the original columns. The migration preserves installed view
projections, grants and predicates, and aborts transactionally if either RPC's
expected search clause has drifted. Check the target definitions before a
future deployment. Index creation runs transactionally and briefly blocks
writes; use an appropriate deployment window based on the target table size.

The test web export uses an isolated test key and must not be published;
deployment needs a fresh export with the normal configuration.
