param([string]$PsqlPath = 'C:/Program Files/PostgreSQL/17/bin/psql.exe', [switch]$FinalPay)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$scratchPath = Join-Path $repoPath '.codex-deploy-same-customer-test'
$dbArgs = @('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','reda_same_customer_test','-v','ON_ERROR_STOP=1')
$adminArgs = @('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','postgres','-v','ON_ERROR_STOP=1')
$guard = & $PsqlPath @dbArgs -At -c "select current_database()='reda_same_customer_test' and inet_server_addr()='127.0.0.1'::inet and inet_server_port()=55439 and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users);"
if ($LASTEXITCODE -ne 0 -or $guard.Trim() -ne 't') { throw 'Expected empty isolated database on localhost:55439.' }
$exists = & $PsqlPath @adminArgs -At -c "select exists(select 1 from pg_database where datname='reda_same_customer_before_settlement');"
if ($LASTEXITCODE -ne 0 -or $exists.Trim() -ne 'f') { throw 'Recovery checkpoint already exists; inspect it before retrying.' }
& $PsqlPath @adminArgs -c 'create database reda_same_customer_before_settlement template reda_same_customer_test;'
if ($LASTEXITCODE -ne 0) { throw 'Could not checkpoint the empty test database.' }
$processes = @()
function Read-RunningOutput([string]$Path) {
  $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $reader = [IO.StreamReader]::new($stream)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Reset-EmptyDatabase {
  # Only fixed names on the dedicated localhost cluster are used here.
  & $PsqlPath @adminArgs -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='reda_same_customer_test';"
  & $PsqlPath @adminArgs -c 'drop database reda_same_customer_test;'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot reset fixture database; checkpoint preserved.' }
  & $PsqlPath @adminArgs -c 'create database reda_same_customer_test template reda_same_customer_before_settlement;'
  if ($LASTEXITCODE -ne 0) { throw 'Cannot restore empty test clone; checkpoint preserved.' }
}
$cases = @(
  @{
    Name='normal-fee-before-settlement'; Wait=$true; Setup='';
    First="select public.correct_same_customer_normal_fee(md5('concurrent-normal-fee')::uuid,delivery_id,revision,3500,'TEST verified normal rate') from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;";
    Second="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST settle corrected rate');";
    Check="select (select base_fee=3500 and expected_amount=3500 from public.same_customer_earnings where active) and (select s.expected_amount=10000-d.agent_payment_snapshot from public.settlements s cross join public.deliveries d where d.id=md5('same-customer-order-1')::uuid) and (select count(*)=1 from public.same_customer_normal_fee_reviews);"
  },
  @{
    Name='settlement-before-normal-fee'; Wait=$true; Setup='';
    First="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST freeze normal rate');";
    Second=@'
do $$ declare e record; begin
  select * into e from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
  begin
    perform public.correct_same_customer_normal_fee(md5('concurrent-frozen-rate')::uuid,e.delivery_id,e.revision,3500,'TEST forbidden frozen rate');
    raise exception 'FAIL: normal rate crossed committed settlement';
  exception when invalid_parameter_value then
    if sqlerrm not like 'affected rider period is settled%' then raise; end if;
  end;
end $$;
'@;
    Check="select not exists(select 1 from public.same_customer_normal_fee_reviews) and (select base_fee=3000 from public.same_customer_earnings where active) and (select expected_amount=7000 from public.settlements);"
  },
  @{
    Name='manual-review-before-new-completion'; Wait=$true;
    Setup=@'
select public.change_delivery_status('manual-lock-complete-2',md5('same-customer-order-2')::uuid,'delivered',null,null,1,10000,'transfer',now());
update public.deliveries set customer_phone='08012345678' where id=md5('same-customer-order-4')::uuid;
select public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST manual concurrent review');
'@;
    First="select public.review_same_customer_manual_pay(md5('manual-concurrent-review')::uuid,g.id,g.revision,'TEST reviewed current members') from public.same_customer_pay_groups g join public.same_customer_earnings e on e.group_id=g.id where e.delivery_id=md5('same-customer-order-1')::uuid;";
    Second="select public.change_delivery_status('manual-lock-complete-4',md5('same-customer-order-4')::uuid,'delivered',null,null,1,10000,'transfer',now());";
    Check="select (select count(*)=1 from public.same_customer_manual_reviews) and (select count(*)=3 and bool_and(pay_state='pending' and review_reason='manual_review') from public.same_customer_earnings where active) and (select manual_amount=2500 from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid);"
  },
  @{
    Name='completion-before-settlement'; Wait=$true; Setup='';
    First="select public.change_delivery_status('lock-complete-2',md5('same-customer-order-2')::uuid,'delivered',null,null,1,10000,'transfer',now());";
    Second="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST complete before settling');";
    Check="select (select count(*)=1 and bool_and(expected_amount=14000 and deliveries_count=2) from public.settlements) and (select sum(expected_amount)=4500 from public.same_customer_earnings where active);"
  },
  @{
    Name='settlement-before-day-review'; Wait=$true; Setup='';
    First="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST freeze before review');";
    Second=@'
do $$ declare e record; begin
  select * into e from public.same_customer_earnings where delivery_id=md5('same-customer-order-1')::uuid;
  begin
    perform public.review_same_customer_completion_day(md5('concurrent-day-review')::uuid,e.delivery_id,e.revision,e.business_date-1,'TEST concurrent date review');
    raise exception 'FAIL: review crossed a committed settlement';
  exception when invalid_parameter_value then
    if sqlerrm not like 'affected rider period is settled%' then raise; end if;
  end;
end $$;
'@;
    Check="select not exists(select 1 from public.same_customer_completion_reviews) and (select expected_amount=7000 from public.settlements) and (select business_date=(now() at time zone 'Africa/Lagos')::date from public.same_customer_earnings where active);"
  },
  @{
    Name='settlement-before-charge-correction'; Wait=$true; Setup='';
    First="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST freeze before charge correction');";
    Second=@'
do $$ begin
  begin
    perform public.correct_delivery_charge(md5('same-customer-order-1')::uuid,4000,2500,'TEST concurrent correction');
    raise exception 'FAIL: fee correction crossed a committed settlement';
  exception when unique_violation then
    if sqlerrm not like 'cannot change the agent payout%' then raise; end if;
  end;
end $$;
'@;
    Check="select (select expected_amount=7000 from public.settlements) and (select agent_payment_snapshot=3000 from public.deliveries where id=md5('same-customer-order-1')::uuid);"
  },
  @{
    Name='direct-writer-retries'; Wait=$false; Setup='';
    First="select public._same_customer_lock_financial_keys(array['agent:'||md5('same-customer-user-agent')::uuid::text]);";
    Second=@'
do $$ begin
  begin
    update public.deliveries set paid=paid+1 where id=md5('same-customer-order-1')::uuid;
    raise exception 'FAIL: uncoordinated writer crossed a financial lock';
  exception when serialization_failure then
    if sqlerrm not like 'financial records changed concurrently%' then raise; end if;
  end;
end $$;
'@;
    Check="select paid=10000 from public.deliveries where id=md5('same-customer-order-1')::uuid;"
  },
  @{
    Name='direct-settlement-writer-retries'; Wait=$false; Setup='';
    First="select public._same_customer_lock_financial_keys(array['agent:'||md5('same-customer-user-agent')::uuid::text]);";
    Second=@'
do $$ begin
  begin
    insert into public.settlements(subject_type,subject_id,period_date,settled_by,expected_amount,deliveries_count,snapshot)
    values('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02',auth.uid(),7000,1,'{}');
    raise exception 'FAIL: direct settlement crossed an existing financial lock';
  exception when serialization_failure then
    if sqlerrm not like 'financial records changed concurrently%' then raise; end if;
  end;
end $$;
'@;
    Check="select not exists(select 1 from public.settlements);"
  },
  @{
    Name='void-before-day-review'; Wait=$true;
    Setup="select public.settle_period('agent',md5('same-customer-user-agent')::uuid,date '2030-01-02','TEST settlement to void');";
    First="select public.void_settlement(id,'TEST void before date review') from public.settlements;";
    Second="select public.review_same_customer_completion_day(md5('review-after-void')::uuid,delivery_id,revision,business_date-1,'TEST corrected day after void') from public.same_customer_earnings where active;";
    Check="select (select count(*)=1 from public.same_customer_completion_reviews) and (select voided_at is not null and expected_amount=7000 from public.settlements);"
  },
  @{
    Name='independent-rider-settlement'; Wait=$false;
    Setup=@'
insert into auth.users(id,email) values(md5('lock-second-agent')::uuid,'lock-second@example.invalid');
insert into public.users(id,email,display_name,role) values(md5('lock-second-agent')::uuid,'lock-second@example.invalid','TEST second rider','agent');
update public.deliveries set assigned_agent_id=md5('lock-second-agent')::uuid where id=md5('same-customer-order-4')::uuid;
insert into public.stock_adjustments(agent_id,product_catalog_id,quantity_delta,reason,created_by_user_id,client_uuid)
values(md5('lock-second-agent')::uuid,md5('same-customer-product-4')::uuid,20,'found',md5('same-customer-user-admin')::uuid,'lock-second-agent-stock');
select public.change_delivery_status('lock-complete-4',md5('same-customer-order-4')::uuid,'delivered',null,null,1,10000,'transfer',now());
'@;
    First="select public._same_customer_lock_financial_keys(array['agent:'||md5('same-customer-user-agent')::uuid::text]);";
    Second="select public.settle_period('agent',md5('lock-second-agent')::uuid,date '2030-01-02','TEST independent rider');";
    Check="select count(*)=1 and bool_and(subject_id=md5('lock-second-agent')::uuid and expected_amount=7000) from public.settlements;"
  },
  @{
    Name='opposite-order-bulk-settlement'; Wait=$true;
    Setup=@'
insert into auth.users(id,email) values(md5('lock-second-agent')::uuid,'lock-second@example.invalid');
insert into public.users(id,email,display_name,role) values(md5('lock-second-agent')::uuid,'lock-second@example.invalid','TEST second rider','agent');
update public.deliveries set assigned_agent_id=md5('lock-second-agent')::uuid where id=md5('same-customer-order-4')::uuid;
insert into public.stock_adjustments(agent_id,product_catalog_id,quantity_delta,reason,created_by_user_id,client_uuid)
values(md5('lock-second-agent')::uuid,md5('same-customer-product-4')::uuid,20,'found',md5('same-customer-user-admin')::uuid,'lock-second-agent-stock');
select public.change_delivery_status('lock-complete-4',md5('same-customer-order-4')::uuid,'delivered',null,null,1,10000,'transfer',now());
'@;
    First="select public.bulk_settle_agents(md5('lock-batch-1')::uuid,array[md5('same-customer-user-agent')::uuid,md5('lock-second-agent')::uuid],date '2030-01-02','TEST first batch');";
    Second=@'
do $$ begin
  begin
    perform public.bulk_settle_agents(md5('lock-batch-2')::uuid,array[md5('lock-second-agent')::uuid,md5('same-customer-user-agent')::uuid],date '2030-01-02','TEST second batch');
    raise exception 'FAIL: overlapping bulk handovers both committed';
  exception when unique_violation then
    if sqlerrm not like 'one or more selected agents are already handed over%' then raise; end if;
  end;
end $$;
'@;
    Check="select (select count(*)=2 and sum(expected_amount)=14000 from public.settlements) and (select count(*)=1 from public.settlement_batches);"
  }
)
if ($FinalPay) {
  ($cases | Where-Object { $_.Name -eq 'completion-before-settlement' }).Check = "select (select count(*)=1 and bool_and(expected_amount=15500 and deliveries_count=2) from public.settlements) and (select sum(final_amount)=4500 and bool_and(final_state='ready') from public.same_customer_earnings where active);"
}
try {
  foreach ($case in $cases) {
    Reset-EmptyDatabase
    $fixturePath = (Join-Path $PSScriptRoot 'same-customer-pay-test-fixtures.sql').Replace('\','/')
    $setupPath = Join-Path $scratchPath 'settlement-lock-setup.sql'
    $policySetup = if ($FinalPay) { "update public.same_customer_pay_policy set active_from=(clock_timestamp() at time zone 'Africa/Lagos')::date;" } else { '' }
    [IO.File]::WriteAllText($setupPath,"\ir $fixturePath`nupdate public.feature_flags set enabled=true where key='same_customer_pay_shadow';`n$policySetup`nselect public.change_delivery_status('lock-complete-1',md5('same-customer-order-1')::uuid,'delivered',null,null,1,10000,'transfer',now());`n" + $case.Setup + "`ncommit;`n")
    & $PsqlPath @dbArgs -f $setupPath
    if ($LASTEXITCODE -ne 0) { throw "Setup failed for $($case.Name)." }
    $prefix = "begin;`nset local statement_timeout='10s';`nselect set_config('request.jwt.claim.sub',md5('same-customer-user-admin')::uuid::text,true);`n"
    $firstPath = Join-Path $scratchPath 'settlement-lock-first.sql'
    $secondPath = Join-Path $scratchPath 'settlement-lock-second.sql'
    [IO.File]::WriteAllText($firstPath,$prefix + $case.First + "`n\echo FIRST_HOLDS_FINANCIAL_LOCK`nselect pg_sleep(2);`ncommit;`n")
    [IO.File]::WriteAllText($secondPath,$prefix + $case.Second + "`ncommit;`n")
    $firstOut = Join-Path $scratchPath 'settlement-lock-first.out'
    $firstErr = Join-Path $scratchPath 'settlement-lock-first.err'
    $secondOut = Join-Path $scratchPath 'settlement-lock-second.out'
    $secondErr = Join-Path $scratchPath 'settlement-lock-second.err'
    $first = Start-Process -FilePath $PsqlPath -ArgumentList ($dbArgs + @('-f',$firstPath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput $firstOut -RedirectStandardError $firstErr
    $processes += $first
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      if ($first.HasExited) { throw "First transaction failed: $([IO.File]::ReadAllText($firstErr))" }
      $ready = (Test-Path -LiteralPath $firstOut) -and ((Read-RunningOutput $firstOut).Contains('FIRST_HOLDS_FINANCIAL_LOCK'))
      if (-not $ready) { Start-Sleep -Milliseconds 50 }
    } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw 'First transaction did not reach the lock checkpoint.' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $second = Start-Process -FilePath $PsqlPath -ArgumentList ($dbArgs + @('-f',$secondPath)) -WindowStyle Hidden -PassThru -RedirectStandardOutput $secondOut -RedirectStandardError $secondErr
    $processes += $second
    $second.WaitForExit(); $timer.Stop()
    $firstStillRunning = -not $first.HasExited
    $first.WaitForExit()
    if ($first.ExitCode -ne 0 -or $second.ExitCode -ne 0) { throw "Concurrency failure in $($case.Name): $([IO.File]::ReadAllText($firstErr)) $([IO.File]::ReadAllText($secondErr))" }
    if ($case.Wait -and $timer.ElapsedMilliseconds -lt 500) { throw "No demonstrated waiting in $($case.Name)." }
    if (-not $case.Wait -and -not $firstStillRunning) { throw 'Fallback writer did not reject while the first financial lock was still held.' }
    $result = & $PsqlPath @dbArgs -At -c $case.Check
    if ($LASTEXITCODE -ne 0 -or $result.Trim() -ne 't') { throw "Invariant failed for $($case.Name)." }
    Write-Output "PASS: $($case.Name); second transaction completed in $($timer.ElapsedMilliseconds) ms."
  }
} finally {
  foreach ($process in $processes) { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
  Reset-EmptyDatabase
  $clean = & $PsqlPath @dbArgs -At -c 'select not exists(select 1 from public.deliveries) and not exists(select 1 from public.users) and not exists(select 1 from public.same_customer_earnings) and not exists(select 1 from public.settlements);'
  if ($LASTEXITCODE -ne 0 -or $clean.Trim() -ne 't') { throw 'Cleanup failed; recovery checkpoint preserved.' }
  & $PsqlPath @adminArgs -c 'drop database reda_same_customer_before_settlement;'
  if ($LASTEXITCODE -ne 0) { throw 'Test data restored, but checkpoint cleanup failed.' }
  Write-Output 'PASS: original empty test database restored; all committed concurrency fixtures removed.'
}
