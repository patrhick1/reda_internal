# Review save latency investigation — September 28, 2026

The owner subsequently approved implementation. See [Atomic Review save](review-save.md)
for the local implementation and tests. It has not been published. The findings
below record the read-only investigation before approval; no production data
or settings were changed during that investigation.

## Findings

The Fix review screen waits for three separate requests before navigating back:

1. `create_delivery` commits the new order.
2. `resolve_inbound_to_delivery` links the inbound item to that order, marks it
   handled and deletes its edit lock.
3. `release_edit_lock` deletes the already-deleted lock again. The screen awaits
   this request even though its error is swallowed.

Unmount then attempts another lock release in the background. Delivery-cache
invalidation also starts background refetches after creation, before review
resolution completes. Those refetches are not awaited but can compete for the
device's connection. There is no intentional timer or EOD scheduling step in
the save path.

This sequence is present in the initial May 26 commit `4486e99`. The most
recent change to the Review detail screen is September 9, `5662991`, preserving
the original WhatsApp message. The screenshot's September 15 receipt date does
not establish when the delay began. The recent EOD queue is not on this path.

## Production evidence

Retained PostgreSQL statement statistics, read September 28:

| Endpoint | Calls | Mean execution | Maximum execution |
| --- | ---: | ---: | ---: |
| create_delivery, largest query shape | 398 | 29.74 ms | 166.59 ms |
| create_delivery, second query shape | 264 | 30.02 ms | 64.80 ms |
| create_delivery, another query shape | 49 | 42.76 ms | 170.51 ms |
| resolve_inbound_to_delivery | 685 | 8.33 ms | 49.84 ms |
| release_edit_lock | 4,476 | 1.31 ms | 17.43 ms |
| acquire_edit_lock | 2,426 | 4.69 ms | 28.78 ms |

These are retained aggregate database execution measurements, not timings on
Uzo's device. They do not include all network/proxy/connection/commit costs,
and cannot establish the duration of an individual reported incident. The
statistics reset timestamp is June 5; individual statement retention varies.
Creation statistics include manual creation outside Review too.

For linked review items whose resulting order has `created_via='manual'`, the
gap from the creation transaction's timestamp to the resolve transaction's
timestamp is observable without writing or replaying any customer operation:

| Lagos date | Linked items | Median gap | 95th percentile | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Sep 15 | 20 | 412.7 ms | 805.4 ms | 908.6 ms |
| Sep 21 | 35 | 457.3 ms | 728.7 ms | 914.4 ms |
| Sep 24 | 21 | 503.4 ms | 1,440.0 ms | 41,441.4 ms |
| Sep 25 | 16 | 610.4 ms | 2,864.6 ms | 5,124.8 ms |
| Sep 26 | 25 | 727.4 ms | 1,131.9 ms | 1,446.3 ms |
| Sep 28 | 24 | 470.1 ms | 687.8 ms | 858.5 ms |

This measures only the gap between two stages, not the complete button wait.
Long outliers could include retries or application interruption; they must not
be presented as proven continuous database or network processing. The sampled
proxy container logs did not contain usable request-duration records for these
endpoints. Exact device-side attribution remains unmeasured.

The evidence supports eliminating serialized round trips rather than removing
financial safeguards or changing the interface. No multi-second database
processing bottleneck was demonstrated by the retained statement statistics.

## Reliability gaps

- Creation and resolution are separate commits. If the second request fails,
  the order can exist while the source still appears in Needs Review.
- The creation request's deduplication key is generated per screen instance.
  A retry in that mounted screen reuses it, but reopening or using another
  device produces another key. Existing same-agent duplicate checks protect
  some combinations, not every case (for example, unassigned orders).
- Edit locks belong to a user, not a device. Two devices logged into Uzo's
  account can both be accepted as the holder. The current resolver checks lock
  ownership but does not require the source to still be `needs_review` before
  assigning its delivery ID. Separate create/link calls are therefore not an
  exactly-once guarantee for one review item.
- These are code-confirmed failure possibilities, not a claim that production
  duplicate orders have been found in this investigation.

## Recommended implementation

1. Add one restricted RPC that validates the source and edit lock, creates the
   delivery using the existing creation function, links it and releases its
   lock in one transaction. Preserve message text, products, quantities, price,
   instructions, date, assignment, blacklist checks and financial safeguards.
2. Serialize only saves of the same inbound item. Use an inbound-derived
   idempotency key and return the saved delivery ID on a completed retry, after
   checking the caller's permission. Two devices should get one saved result;
   different inbound items should not acquire a new global queue lock.
3. Update the screen to make that single request and return after confirmed
   success. Remove the redundant awaited release and stop local heartbeats /
   cleanup releases once the server has completed resolution. Refresh affected
   caches after the complete save, not between its stages.
4. Keep the current form and button. Do not hide latency by showing success
   before commit or bypassing validation. Retain entered values on a genuine
   failure. Bound lock/statement waits with an actionable retry error.
5. Account for older app bundles during release: preserve their endpoints and
   audit interactions with the new atomic path, particularly an old client
   that already created an order but has not linked it yet. Do not claim a
   cross-version duplicate guarantee without testing this case.

Three awaited network round trips become one. For illustration, a 500 ms
round trip contributes about 1.5 seconds across three requests, versus about
0.5 seconds for one, plus processing. This is an illustration, not a promised
production latency. Reusing existing business functions reduces behavioural
change; item-scoped serialization and retry-safe completion improve scaling
and prevent partial saves.

## Acceptance checks before publishing

- Measure actual click-to-return time through the web UI and HTTP, with normal
  and delayed responses; compare against the current three-request baseline.
- Verify all form values, original message retention, multiple products,
  alternate phones, assignment, rate snapshots and Lagos date behaviour.
- Verify permission, blacklist, expired/stolen lock, discarded/already-handled
  source, bad product/client, and validation rollback cases.
- Test duplicate taps, concurrent devices on the same account, different
  accounts, different review items, reconnect/reopen, lost committed responses,
  and mixed old/new application requests. Count actual resulting deliveries.
- Confirm no extra background refresh or cleanup request delays completion;
  retain the existing form and verify phone and desktop layouts.
- Deployment requires the server RPC before the new app, followed by the
  user's approved publication target. Nothing was published during this audit.
