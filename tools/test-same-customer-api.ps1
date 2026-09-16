param([string]$PsqlPath='C:/Program Files/PostgreSQL/17/bin/psql.exe')
$ErrorActionPreference='Stop'
$repoPath=Split-Path -Parent $PSScriptRoot
$scratchPath=Join-Path $repoPath '.codex-deploy-same-customer-test'
$dbArgs=@('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','reda_same_customer_test','-v','ON_ERROR_STOP=1')
$adminArgs=@('-X','-h','127.0.0.1','-p','55439','-U','reda_test','-d','postgres','-v','ON_ERROR_STOP=1')
$guard=& $PsqlPath @dbArgs -At -c "select current_database()='reda_same_customer_test' and inet_server_port()=55439 and not exists(select 1 from public.deliveries) and not exists(select 1 from public.users);"
if($LASTEXITCODE -ne 0 -or $guard.Trim() -ne 't'){throw 'Expected empty isolated test database.'}
& $PsqlPath @adminArgs -c 'create database reda_same_customer_before_api template reda_same_customer_test;'
if($LASTEXITCODE -ne 0){throw 'Checkpoint unavailable; inspect before retrying.'}
$apiProcess=$null
try {
  $fixturePath=(Join-Path $PSScriptRoot 'same-customer-pay-test-fixtures.sql').Replace('\','/')
  "\ir '$fixturePath'`ngrant select on public.users,public.deliveries,public.deliveries_safe to authenticated;`ncommit;" | Set-Content (Join-Path $scratchPath 'api-fixtures.sql')
  & $PsqlPath @dbArgs -f (Join-Path $scratchPath 'api-fixtures.sql')
  if($LASTEXITCODE -ne 0){throw 'Local fixtures failed'}
  @('db-uri = "postgresql://reda_test@127.0.0.1:55439/reda_same_customer_test"','db-schemas = "public"','db-anon-role = "anon"','db-pre-request = "public.check_payment_client_contract"','server-host = "127.0.0.1"','server-port = 55441','jwt-secret = "isolated-reda-api-test-secret-at-least-32-characters"') | Set-Content (Join-Path $scratchPath 'postgrest-test.conf')
  $apiProcess=Start-Process -FilePath (Join-Path $scratchPath 'postgrest/postgrest.exe') -ArgumentList ('"'+(Join-Path $scratchPath 'postgrest-test.conf')+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $scratchPath 'postgrest-api.out') -RedirectStandardError (Join-Path $scratchPath 'postgrest-api.err')
  node (Join-Path $PSScriptRoot 'test-same-customer-api.mjs')
  if($LASTEXITCODE -ne 0){throw 'Real local API verification failed'}
} finally {
  if($apiProcess -and -not $apiProcess.HasExited){Stop-Process -Id $apiProcess.Id}
  & $PsqlPath @adminArgs -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='reda_same_customer_test';"
  & $PsqlPath @adminArgs -c 'drop database reda_same_customer_test;'
  if($LASTEXITCODE -ne 0){throw 'Could not reset fixture database; checkpoint retained'}
  & $PsqlPath @adminArgs -c 'create database reda_same_customer_test template reda_same_customer_before_api;'
  if($LASTEXITCODE -ne 0){throw 'Could not restore empty database; checkpoint retained'}
  & $PsqlPath @adminArgs -c 'drop database reda_same_customer_before_api;'
}
Write-Output 'PASS: API test checkpoint restored and local API stopped.'
