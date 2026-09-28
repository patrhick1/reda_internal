# Policy closure wording — September 28, 2026

The order-details screen labels recorded no-rollover client-policy closures
as **Closed**, including history events and the current-order badge. Their
history explanation (and Copy note text) is now:

> Closed because this client’s orders do not roll over.

The display recognises manual maintenance, scheduled maintenance and historical
client-policy reason codes. Genuine delivery failures keep **Failed** and retain
the operator's note. It does not infer a closure from the client's current
settings, and an ancestor's closure cannot relabel the current order.

This is a display-only change using history already fetched by the detail
screen. No new requests, schema/data changes, status transitions, financial
rules or processing changes. Other screens lacking event reasons retain their
existing labels; this change addresses the order-detail/history view reported
in the screenshot, not a global rename of `failed_delivery`.

Validation: mobile typecheck, lint, formatting and web export; exported-browser
checks at 390px and 1280px with manual policy closure, legacy policy closure,
genuine failure and an older policy-closure ancestor. The regression check is
`test-closure-display.mjs`, included in the existing browser CI job.

Implemented locally. Not published.
