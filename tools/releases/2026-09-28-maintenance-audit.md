# September 28 maintenance and workflow release audit

This records the maintenance/workflow part of the September 28 unpublished-fix
inventory. It is a pre-release audit, not a deployment receipt. The combined
release record should identify the final commit, database application and EAS
publication separately.

## Source and release boundary

The current `origin/main` baseline is `7dd947b` (September 27). The ordinary
root checkout is older and contains earlier maintenance and Decency changes
that are already on main and already published. Copying that entire checkout
over current main would regress newer business workflows and remove tests.

Today's pending workflow changes were in the existing `.codex-waiver-fix`
checkout, branch `codex/immediate-manual-eod`, based on `7dd947b`. The audit
identified 17 modified tracked files and 18 new source, migration, documentation
and test files. Those 35 files were copied into the isolated combined release
checkout and verified by SHA-256. Scratch databases, bundles, private release
artifacts and nested Git metadata were excluded.

## Pending problems and solutions

| Problem | Solution | Application/backend scope |
| --- | --- | --- |
| Manual end of day waited for the minute scheduler and its 25-second worker stagger; more than 100 groups needed another scheduled batch. Three recorded runs took 116–145 seconds despite about 2–3 seconds of processing. | Save the approved operation, then immediately advance only its saved groups through bounded requests. Continue ready batches immediately; preserve committed progress, retry rules, scheduled recovery, permissions and financial/stock safeguards. | EOD screen/service and new `advance_manual_eod` RPC, migration `20260928160000_immediate_manual_eod.sql`. |
| Uzo had to scroll through the EOD order list to reach the action. | Move the existing Run end of day button beneath the summary and destination, above the order list. Keep confirmation and disabled states. | EOD screen only. |
| The owner wanted the Create replacement shortcut removed from order details. | Remove that shortcut for admin/dispatcher while preserving and verifying the existing Home replacement entries and original-order selection. | Shared delivery details only. |
| Equivalent Nigerian phone formats could miss orders; the instant client filter could discard valid server results, and alternate contacts were not consistently searched. | Use shared search rules for `080…`, `+234…`, `234…`, `00234…`, punctuation and alternate numbers. Search role-scoped views with indexed expressions and the same rules in Failed/Same customer RPCs and replacement lookup. Preserve original values and grouping/payment rules. | Shared helper, delivery/list services and migration `20260928180000_delivery_phone_search.sql`. |
| Client-policy no-rollover closures appeared as ordinary failed deliveries with technical history reasons. | In order detail/history, show Closed and “Closed because this client’s orders do not roll over.” only when the recorded event proves a policy closure. Genuine failures retain Failed and their note; an ancestor event does not relabel the current order. | Display helper, StatusPill, theme and order details. No database/status changes. |
| Saving a corrected Review item waited on create, link and redundant lock-release requests; separately committed stages could leave partial results and retries from a second device could create another order. | One atomic RPC creates the delivery, links/handles the source and releases its edit lock. Source-scoped locking and stable idempotency return the saved delivery on repeated updated-client saves. The form retains values on failure; local heartbeat/cleanup stop after confirmed completion. Guard legacy linking/discarding against replacing a completed link. | Review screen, edit-lock hook, bot service and migration `20260928210000_atomic_review_save.sql`. |
| Stock movement secondary details were clipped to one line on narrow screens. | Allow that text to wrap with a readable line height; prevent the movement icon and quantity columns from shrinking. | Stock Movements layout only. |

## Verification already recorded by the implementation task

These are the original isolated-test results. The combined release must run its
own appropriate verification after integrating overlapping files.

- Immediate EOD: real PostgreSQL 17/PostgREST 14.12 HTTP tests with committed
  batches, no scheduler in the normal latency test, 0/1/99/100/101/153 groups and
  1,530 groups alongside 20,000 historical orders. Recent-sized runs were below
  the 10-second local acceptance target. Phone/desktop browser tests covered
  normal completion, a response lost after commit and reload recovery.
- EOD safety/regression: permissions, approval scope, duplicate requests,
  simultaneous users, scheduled/manual overlap, pause, retry delays, stale
  edits, bounded work, failure/reapproval, app-absent scheduled recovery,
  midnight/weekend destinations and existing fee/handover suites.
- Phone search: helper tests, actual authenticated API/view/RPC tests, role
  visibility, soft deletion, edited phones, index use and 100-result cap, plus
  390px/1280px browser searches and replacement lookup.
- Closure wording: phone/desktop browser checks for manual and historical
  policy closures, genuine failures and a policy-closure ancestor.
- Review save: real HTTP and phone/desktop browser tests for full form values,
  multiple products, original message, concurrent saves, permission/lock errors,
  validation rollback, blacklist enforcement, lost responses and corrected
  retry. With 300ms added per mutation, the recorded new click-to-return was
  380ms at both widths versus 979–986ms for the old request chain. These are
  controlled local measurements, not production latency promises.
- TypeScript, lint, formatting, web export and the existing maintenance and
  financial regressions were recorded as passing. The new CI jobs were not yet
  run remotely at the time of these original implementation notes.
- The stock movement wrap check was found in the earlier local scratch test
  directory and promoted into portable `test-stock-wrap.mjs`. The combined
  release export passes at 320px, 390px and 1280px with full descriptions,
  no quantity overlap and no runtime errors.

Detailed source notes: [Immediate EOD](../eod-reliability-20260921/immediate-manual-eod.md),
[phone search](../eod-reliability-20260921/phone-search.md),
[closure wording](../eod-reliability-20260921/closure-wording.md), and
[atomic Review save](../eod-reliability-20260921/review-save.md).

## Backend and publication requirements

1. Apply the three new versioned migrations before publishing the updated
   bundle. The new app requires the RPCs and phone-search view columns.
2. Phone-search migration checks the installed Failed and Same customer RPC
   search clauses and aborts if they drifted. Inspect those definitions first.
   Its transactional index creation briefly blocks writes; retain a bounded
   deployment window and verify installed indexes/views afterwards.
3. Check the EOD RPC through actual HTTP: it requires function-level
   SERIALIZABLE isolation and authorized ownership of the submitted preview.
   Live PostgREST was read-only verified as v14.12 during implementation.
4. Rebuild with normal production configuration. The workflow test export uses
   an isolated test key and must never be published.
5. Review duplicate prevention requires the updated atomic path. An old bundle
   that already committed an independent create before linking can still leave
   a separate order when another device saves the same source. Legacy guards
   preserve the winning source link but cannot safely delete/adopt that old
   independent order. Finish in-flight Review edits and load the updated bundle
   on working devices; do not automatically delete suspected duplicates.
6. The earlier EOD note proposed web-first acceptance before EAS. The owner has
   now explicitly requested the combined release be pushed to main and EAS
   preview; record what was actually published and what real-device checks
   remain, rather than treating older suggested sequencing as a new approval
   requirement.

## Already published: exclude from today's new-fix count

- September 21–23 maintenance queue, postponement/reschedule handling, restored
  manual EOD, later removal of maintenance holds, simpler workflows, fee waivers
  and missing-charge/unchanged-fee confirmations were already merged/deployed.
  Publication evidence records main `76878b8`, live web verification and EAS
  preview group `fe1010a7-c9c3-4e67-8d3e-a28392fb1e02`, runtime 1.1.1.
- Decency delivered-report format (Name, Product, Qty, Customer paid, Delivery
  fee, To remit, Note) and the required rep data exposure were published
  September 27 at commit `758c9ec`; preview group
  `e452a75f-f7e9-411c-95ca-ba2cb00579fe`, runtime 1.1.1. The live database and web/
  native assets were verified in that release record.
- Sunday/workday maintenance fixture correction is already main `7dd947b`
  (PR #7), with the task recording all main checks passing. Do not replace it
  with the older root fixture/CI files.
- Age Store/PelviBeat missing-intake investigation was read-only. Matching
  manually entered orders already existed; no fix or data repair was pending
  for publication from that investigation.

The historical verification files used for this distinction reside under the
existing local `.codex-eod-test` directory; they were read as evidence, not
copied wholesale into the release.
