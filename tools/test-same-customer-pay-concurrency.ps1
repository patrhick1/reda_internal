param([string]$PsqlPath = 'C:/Program Files/PostgreSQL/17/bin/psql.exe', [switch]$FinalPay)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$scratchPath = Join-Path $repoPath '.codex-deploy-same-customer-test'
$dbArgs = @('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','reda_same_customer_test','-v','ON_ERROR_STOP=1')
$adminArgs = @('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','postgres','-v','ON_ERROR_STOP=1')
$guard = & $PsqlPath @dbArgs -At -c "select inet_server_addr()='127.0.0.1'::inet and inet_server_port()=55439 and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users);"
if ($LASTEXITCODE -ne 0 -or $guard.Trim() -ne 't') { throw 'Expected empty isolated schema-only database.' }
$backupExists = & $PsqlPath @adminArgs -At -c "select exists(select 1 from pg_database where datname='reda_same_customer_before_concurrency');"
if ($LASTEXITCODE -ne 0 -or $backupExists.Trim() -ne 'f') { throw 'Recovery database already exists. Inspect the previous test before retrying.' }

& $PsqlPath @adminArgs -c 'create database reda_same_customer_before_concurrency template reda_same_customer_test;'
if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated pre-test database checkpoint.' }
$processes = @()
function Read-RunningOutput([string]$Path) {
  $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $reader = [IO.StreamReader]::new($stream)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
try {
  $fixturePath = (Join-Path $PSScriptRoot 'same-customer-pay-test-fixtures.sql').Replace('\','/')
  $setupPath = Join-Path $scratchPath 'concurrency-setup.sql'
  $policySetup = if ($FinalPay) { "update public.same_customer_pay_policy set active_from=(clock_timestamp() at time zone 'Africa/Lagos')::date;" } else { '' }
  [IO.File]::WriteAllText($setupPath,"\ir $fixturePath`nupdate public.feature_flags set enabled=true where key='same_customer_pay_shadow';`n$policySetup`ncommit;`n")
  & $PsqlPath @dbArgs -f $setupPath
  if ($LASTEXITCODE -ne 0) { throw 'Concurrency fixture setup failed.' }

  $firstPath = Join-Path $scratchPath 'concurrency-first.sql'
  $secondPath = Join-Path $scratchPath 'concurrency-second.sql'
  [IO.File]::WriteAllText($firstPath,@'
begin;
set local statement_timeout='10s';
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
select public.change_delivery_status('concurrent-first',md5('same-customer-order-1')::uuid,'delivered',null,null,1,10000,'transfer',now());
\echo FIRST_HOLDS_GROUP_LOCK
select pg_sleep(2);
commit;
'@)
  [IO.File]::WriteAllText($secondPath,@'
begin;
set local statement_timeout='10s';
select set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);
select public.change_delivery_status('concurrent-second',md5('same-customer-order-2')::uuid,'delivered',null,null,1,10000,'transfer',now());
commit;
'@)
  $firstOut = Join-Path $scratchPath 'concurrency-first.out'
  $firstErr = Join-Path $scratchPath 'concurrency-first.err'
  $secondOut = Join-Path $scratchPath 'concurrency-second.out'
  $secondErr = Join-Path $scratchPath 'concurrency-second.err'
  $first = Start-Process -FilePath $PsqlPath -ArgumentList ($dbArgs + @('-f',$firstPath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput $firstOut -RedirectStandardError $firstErr
  $processes += $first
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    if ($first.HasExited) { throw "First transaction exited before holding the group lock: $([IO.File]::ReadAllText($firstErr))" }
    $ready = (Test-Path -LiteralPath $firstOut) -and ((Read-RunningOutput $firstOut).Contains('FIRST_HOLDS_GROUP_LOCK'))
    if (-not $ready) { Start-Sleep -Milliseconds 50 }
  } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if (-not $ready) { throw 'First transaction did not reach the lock checkpoint.' }
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $second = Start-Process -FilePath $PsqlPath -ArgumentList ($dbArgs + @('-f',$secondPath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput $secondOut -RedirectStandardError $secondErr
  $processes += $second
  $second.WaitForExit(); $timer.Stop(); $first.WaitForExit()
  if ($first.ExitCode -ne 0 -or $second.ExitCode -ne 0) { throw "Concurrent completion failed: $([IO.File]::ReadAllText($firstErr)) $([IO.File]::ReadAllText($secondErr))" }
  if ($timer.ElapsedMilliseconds -lt 500) { throw 'Second transaction did not demonstrably wait on the held group lock.' }
  $result = & $PsqlPath @dbArgs -At -c "select count(*)=2 and sum(expected_amount)=4500 and count(*) filter(where multiplier=1)=1 and count(*) filter(where multiplier=0.5)=1 from public.same_customer_earnings where active;"
  if ($LASTEXITCODE -ne 0 -or $result.Trim() -ne 't') { throw 'Concurrent first successes did not yield one full and one half fee.' }
  $expectedPayout = if ($FinalPay) { "case when id=md5('same-customer-order-2')::uuid then 1500 else 3000 end" } else { '3000' }
  $invariants = & $PsqlPath @dbArgs -At -c "select (select count(*) from public.stock_adjustments where reason='delivered')=2 and (select bool_and(agent_payment_snapshot=$expectedPayout and charged_snapshot=4000) from public.deliveries);"
  if ($LASTEXITCODE -ne 0 -or $invariants.Trim() -ne 't') { throw 'Stock or payable snapshot invariant failed.' }
  if ($FinalPay) {
    $finalResult = & $PsqlPath @dbArgs -At -c "select count(*)=2 and sum(final_amount)=4500 and bool_and(final_state='ready' and policy_applied) from public.same_customer_earnings where active;"
    if ($LASTEXITCODE -ne 0 -or $finalResult.Trim() -ne 't') { throw 'Concurrent final earnings disagree with projected payouts.' }
  }
  Write-Output "PASS: concurrent completions serialize correctly (final pay: $FinalPay); second writer waited $($timer.ElapsedMilliseconds) ms."
} finally {
  foreach ($process in $processes) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
  # These names are fixed, created by this test, on the dedicated localhost port.
  # Restore the exact empty checkpoint, including functions, sequences and flags.
  & $PsqlPath @adminArgs -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='reda_same_customer_test';"
  & $PsqlPath @adminArgs -c 'drop database reda_same_customer_test;'
  if ($LASTEXITCODE -ne 0) { throw 'Could not remove isolated fixture database; checkpoint preserved.' }
  & $PsqlPath @adminArgs -c 'alter database reda_same_customer_before_concurrency rename to reda_same_customer_test;'
  if ($LASTEXITCODE -ne 0) { throw 'Could not restore checkpoint name; recovery database is preserved.' }
  $clean = & $PsqlPath @dbArgs -At -c 'select not exists(select 1 from public.deliveries) and not exists(select 1 from public.users) and not exists(select 1 from public.same_customer_earnings);'
  if ($LASTEXITCODE -ne 0 -or $clean.Trim() -ne 't') { throw 'Concurrency cleanup verification failed.' }
  Write-Output 'PASS: original empty isolated database restored after concurrent tests.'
}
