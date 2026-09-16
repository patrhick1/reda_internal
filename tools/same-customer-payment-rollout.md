# Same-customer payment rollout — 16 September 2026

## Current rollout checkpoint

The payment backend was installed with active_from NULL. The installation was
one transaction with a three-second lock timeout and checks preserving every
original delivery, status-history and settlement value. A 71 MB private backup
remains on REDA's server at /root/reda-backups/before-same-customer-payment-20260916.dump.

The requested start is 17 September 2026 at 00:00 Africa/Lagos. It is not scheduled
at this checkpoint; client publication and the final read-only check precede it.

## Client protection

Updated clients send x-reda-payment-contract: 1. PostgREST runs
public.check_payment_client_contract before requests. Once payment starts,
older authenticated clients receive HTTP 426 before reads or mutations execute.
GET/HEAD users remains available for profile loading and the existing updater.
Trusted service integrations retain their own role permissions and financial
write guards. The header declares compatibility; it does not grant authorization.
Offline jobs blocked by the gate retain their UUID and occurrence time and are
recovered after updating. Existing cached/offline displays cannot be remotely
removed; live financial actions still pass the server checks.

## Verification

- Refreshed production schema-only migration rehearsal and the full local SQL suite passed.
- PostgREST 14.12 real local HTTP tests passed: old reads and writes rejected before
  execution; profile available; modern completions total 4,500 on two 3,000 fees;
  an unresolved correction returns pending totals and null rider amounts.
- Private future-day activation/suspension audits and denied app activation passed.
- Upgrade queue recovery preserves original payload, owner, request ID and timestamp.
- TypeScript, full ESLint, formatting and production web export passed.
- Prior simultaneous-completion and eleven settlement race tests passed. This
  rollout does not claim every conceivable correction race or physical-device
  interaction was tested; native offline occurrence/retry logic has automated tests.

Automatic approval review requested explicit approval for the final read-only
production check. It returns only a mismatch count, policy dates and enrollment
count to the workspace. Activation waits for this check and successful releases.
