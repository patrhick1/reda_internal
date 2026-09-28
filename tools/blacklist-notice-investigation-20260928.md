# Blacklisted order notice investigation — 28 September 2026

> Historical implementation record. See the [28 September release record](releases/2026-09-28-preview-release.md) for current validation and publication status.

The initial investigation was read-only. The authorized fix is now implemented
locally; see `blacklist-notice-tests/README.md`. Production remains unchanged.

Uzo reports that a blocked order can look like an order that failed to reach
the app. He can see blacklist records but wants an unsolicited notice.

## Findings

- The bot checks primary/alternative customer phone numbers against active
  blacklist entries, normalizing local and +234 formats. Delivery creation
  also enforces refusal in the database.
- `bot-parse-message` records a refusal through `mark_inbound_processed`, with
  status `blocked`, blacklist reason/entry, and no delivery ID.
- The app exposes these records in Review → Blocked and derives the per-number
  blocked count and latest blocked timestamp in Catalog → Blacklist.
- A read-only production query confirmed two blocked inbound records, both
  without linked deliveries.
- Live `mark_inbound_processed` only updates the inbound row. Its notification
  triggers handle transitions to `error` and `needs_review`, not `blocked`.
  Thus the blocked-order processing path currently generates no push alert.
- Manual creation has a courtesy warning next to the phone fields, with
  database rejection on save. That does not notify staff about bot submissions.
- Existing push registration/routing is native-only. Review notification taps
  land on the default Needs Review tab, ignoring the inbound ID for selection.

## Proposed change (subsequently implemented locally)

Keep refusal intact. Add a clear notice identifying the customer/vendor and
blacklist reason, explicitly saying no delivery was created. Offer a link to
the specific blocked record. Use an Android push plus a persistent in-app notice
on Android and web, with read/acknowledgment tracking. Deduplicate processing
retries for a given blocked inbound record. Admins, dispatchers, and reps use
the existing operational notification audience. The user also requested inline
notices on manual creation failure and a restrained experience.

No WhatsApp messages sent, no test orders submitted, no production writes made.
