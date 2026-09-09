# PowerShell script to execute real PostgreSQL acceptance tests against the isolated stand
[CmdletBinding()]
param(
    [string]$MigrationUrl = $env:EMS_TEST_PG_MIGRATION_URL,
    [string]$RuntimeUrl = $env:EMS_TEST_PG_RUNTIME_URL
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DockerDir = Split-Path -Parent $ScriptDir
$InfraDir = Split-Path -Parent $DockerDir
$RootDir = Split-Path -Parent $InfraDir

if ([string]::IsNullOrWhiteSpace($MigrationUrl) -or [string]::IsNullOrWhiteSpace($RuntimeUrl)) {
    Write-Error "Set EMS_TEST_PG_MIGRATION_URL and EMS_TEST_PG_RUNTIME_URL before running acceptance tests."
    exit 1
}

Write-Host "=== EMS Platform: Running PostgreSQL Real Acceptance Tests ===" -ForegroundColor Cyan

# 1. Verify TCP connectivity to PostgreSQL
Write-Host "Verifying connection to PostgreSQL on localhost:5432..." -ForegroundColor DarkGray
$tcpClient = New-Object System.Net.Sockets.TcpClient
try {
    $asyncResult = $tcpClient.BeginConnect("127.0.0.1", 5432, $null, $null)
    $success = $asyncResult.AsyncWaitHandle.WaitOne(3000, $false)
    if (-not $success) {
        throw "Connection timed out."
    }
    $tcpClient.EndConnect($asyncResult)
} catch {
    Write-Error "PostgreSQL is not reachable on localhost:5432. Please start the stand first: & '$ScriptDir\stand-up.ps1'"
    exit 1
} finally {
    $tcpClient.Close()
}

# 2. Export required environment variables
$env:EMS_TEST_PG_INTEGRATION = "true"
$env:EMS_TEST_PG_MIGRATION_URL = $MigrationUrl
$env:EMS_TEST_PG_RUNTIME_URL = $RuntimeUrl

$CaCertPath = Join-Path $InfraDir "certs\TestRootCA.crt"
if (Test-Path -LiteralPath $CaCertPath) {
    $env:NODE_EXTRA_CA_CERTS = $CaCertPath
    Write-Host "Loaded root CA for TLS: $CaCertPath" -ForegroundColor DarkGray
}

Write-Host "Executing pnpm --filter @ems/core run test:pg..." -ForegroundColor Yellow
Set-Location -LiteralPath $RootDir

& pnpm --filter @ems/core run test:pg
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host "=== PostgreSQL Acceptance Tests PASSED Successfully! ===" -ForegroundColor Green
} else {
    Write-Host "=== PostgreSQL Acceptance Tests FAILED (exit code $exitCode) ===" -ForegroundColor Red
}

exit $exitCode
