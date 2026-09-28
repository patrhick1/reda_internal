# Atomic Review save — September 28, 2026

Implemented locally following approval. Not pushed, deployed to the database,
or published to web/EAS. Prior pending changes in this worktree are preserved.

## Behaviour

The existing **Create delivery** button now calls one server operation. It
creates the order, links the review item, marks it handled and releases its edit
lock in one transaction. The screen returns only after a confirmed response.
The form and its fields are unchanged. A failed request retains entered values.

The new `create_delivery_from_review` RPC validates manager permission, locks
the individual source row and its edit-lock row, checks the source state and
lock ownership, then reuses `create_delivery` and `resolve_inbound_to_delivery`.
The original WhatsApp message comes from the server's source record. Existing
business validation, payment, product, assignment and date rules remain in
those functions. No background queue or new global lock is introduced.

A stable source-derived creation key, combined with source-row locking and the
saved source link, makes retries and concurrent updated-device saves return
the same delivery. Repeated requests cannot overwrite the first saved values.
Permission is checked before returning an already-saved result. A failure
after creation but before linking rolls back all creation effects.

Legacy link and discard endpoints now use the same source/edit-lock ordering
and reject stale attempts to replace a completed link or discard a saved item.
The legacy link endpoint accepts an exact already-completed retry and retains
its original-message backstop. Calls retain their previous grants.

The new RPC has a 20-second request statement deadline and a 2-second lock
deadline. Contention returns a retry message. A missing/expired edit lock asks
the user to reopen the review item. Existing finance locks remain in force.

On confirmed completion, Review calls `markReleased()` locally to stop its
heartbeat and skip redundant lock-release requests. Existing delivery-edit
callers retain their previous explicit `release()` behaviour. Cache refresh
occurs after the full save, rather than between creation and linking. A local
in-flight guard also prevents duplicate button dispatch before React rerenders.

## Verification

`test-review-save.mjs` uses the isolated PostgreSQL/PostgREST environment:

- Real authenticated HTTP creation and row/item assertions: multiple products,
  quantities, price, alternate phone, address, instructions, assignment,
  scheduling and the original message.
- Two simultaneous saves with a deliberately slowed link to ensure overlap:
  one creation key and one resulting delivery.
- Completed retry (including a different stale payload), unauthorized agent
  and anonymous requests, a dispatcher save, expired/stolen edit locks,
  missing/discarded source and stale link/discard attempts.
- Invalid price/client/product and a forced failure after creation: no partial
  order/history commit, lock retained, and a successful corrected retry.
- Customer blacklist enforcement; optional assignment; date and fee parity
  against the existing creation function, including Saturday/Sunday inputs.
- An independent source can save while another source row is held; the busy
  source times out on its lock and can be retried after release.
- Legacy completed-link reuse, original-message preservation, and explicit
  coverage of the legacy partially-created-order limitation below.

`test-review-save-browser.mjs` runs the exported app against the real isolated
API at widths 390 and 1280. Authentication/navigation shell data is stubbed;
catalog reads, review reads, locks and saves are real API requests. It exercises
normal saves, a failed request before saving and a lost response after commit.
Retry preserves form fields and creates exactly one order. The normal path
makes one save request and no extra link or cleanup-release request.

In the first measured run, with **300 ms deliberately added to each mutation
request**, click-to-return took **380 ms** at both widths. The old three-call
chain, executed in the same browser against the same database with the same
delay, took **986 ms** and **979 ms**. The comparison baseline measures the old
request chain, not an older exported screen. These are controlled local
measurements, not a promise of a particular latency on Uzo's connection.

Also checked: mobile typecheck, lint, formatting, web export and diff checks;
the existing maintenance/EOD regression suite and rider-fee waiver integration
suite. The new API/browser suite is included in CI but has not run on GitHub
because this batch has not been pushed.

## Deployment and compatibility

Apply `20260928210000_atomic_review_save.sql` before publishing the updated
app. This migration contains no production data repair or backfill. Build web
again with normal release configuration: the current local test export uses
an isolated key and must not be published.

**Two-device duplicate protection requires the updated save path.** An older
app can still commit a separate `create_delivery` request without an inbound
ID. If it creates an order and stalls before linking while an updated client
saves the same source, the server cannot safely infer that the old independent
order should be deleted or adopted. The guarded legacy resolver rejects its
late conflicting link and preserves the winning source link, but the old
independent order remains. This exact case is tested, not hidden as a passing
exactly-once guarantee. It is a pre-existing limitation of the old API contract.

Before rollout, finish in-flight Review edits and ensure Uzo's working devices
load the updated app. Do not use old and new bundles concurrently for Review.
Do not automatically delete suspected pre-existing duplicates or overwrite
intentional order changes as part of this performance fix. Production
publication and any data repair require their own explicit scope.
