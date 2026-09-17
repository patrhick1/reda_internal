param([string]$PsqlPath = 'C:/Program Files/PostgreSQL/17/bin/psql.exe')
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$connectionArgs = @('-X', '-h', '127.0.0.1', '-p', '55439', '-U', 'reda_test', '-d', 'reda_same_customer_test', '-v', 'ON_ERROR_STOP=1')
# Deliberately fixed localhost/database/port: this runner cannot target production.
$guardSql = "select current_database()='reda_same_customer_test' and inet_server_port()=55439 and inet_server_addr()='127.0.0.1'::inet and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users);"
$guardResult = & $PsqlPath @connectionArgs -At -c $guardSql
if ($LASTEXITCODE -ne 0 -or $guardResult.Trim() -ne 't') {
  throw 'Expected an empty schema-only isolated database. No migration or fixtures applied.'
}
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260915223000_same_customer_discovery.sql')
if ($LASTEXITCODE -ne 0) { throw 'Discovery migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260915233000_same_customer_pay_shadow.sql')
if ($LASTEXITCODE -ne 0) { throw 'Shadow earnings migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916003000_same_customer_completion_review.sql')
if ($LASTEXITCODE -ne 0) { throw 'Completion review migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916013000_same_customer_normal_fee.sql')
if ($LASTEXITCODE -ne 0) { throw 'Normal fee migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916023000_same_customer_financial_locks.sql')
if ($LASTEXITCODE -ne 0) { throw 'Financial locking migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916033000_same_customer_manual_fees.sql')
if ($LASTEXITCODE -ne 0) { throw 'Manual fee migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916043000_same_customer_final_pay.sql')
if ($LASTEXITCODE -ne 0) { throw 'Final pay migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916053000_same_customer_financial_readers.sql')
if ($LASTEXITCODE -ne 0) { throw 'Financial reader migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916063000_same_customer_delivery_pay.sql')
if ($LASTEXITCODE -ne 0) { throw 'Delivery pay metadata migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916073000_same_customer_settlement_write_guard.sql')
if ($LASTEXITCODE -ne 0) { throw 'Settlement write guard migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916083000_same_customer_normal_fee_review.sql')
if ($LASTEXITCODE -ne 0) { throw 'Normal fee review migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916133000_same_customer_client_contract.sql')
if ($LASTEXITCODE -ne 0) { throw 'Payment client contract migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260916140000_same_customer_policy_audit.sql')
if ($LASTEXITCODE -ne 0) { throw 'Policy audit migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $repoPath 'supabase/migrations/20260917100000_same_customer_manager_visibility.sql')
if ($LASTEXITCODE -ne 0) { throw 'Manager visibility migration failed.' }
& $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-discovery.sql')
$testExit = $LASTEXITCODE
if ($testExit -eq 0) {
  & $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-pay-shadow.sql')
  $testExit = $LASTEXITCODE
}
if ($testExit -eq 0) {
  & $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-final-pay.sql')
  $testExit = $LASTEXITCODE
}
if ($testExit -eq 0) {
  & $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-financial-readers.sql')
  $testExit = $LASTEXITCODE
}
if ($testExit -eq 0) {
  & $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-manager-visibility.sql')
  $testExit = $LASTEXITCODE
}
# A failed psql exits and PostgreSQL rolls its open test transaction back too.
if ($testExit -eq 0) {
  & $PsqlPath @connectionArgs -f (Join-Path $PSScriptRoot 'test-same-customer-client-contract.sql')
  $testExit = $LASTEXITCODE
}
$cleanResult = & $PsqlPath @connectionArgs -At -c $guardSql
if ($LASTEXITCODE -ne 0 -or $cleanResult.Trim() -ne 't') { throw 'Post-test isolation/cleanup check failed.' }
if ($testExit -ne 0) { throw 'Integration tests failed; test transaction was rolled back.' }
Write-Output 'PASS: isolated integration suite completed; fixture cleanup verified.'
