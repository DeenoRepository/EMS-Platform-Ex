# PowerShell script to launch and verify EMS Platform Local Docker Stand
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DockerDir = Split-Path -Parent $ScriptDir
$InfraDir = Split-Path -Parent $DockerDir
$RootDir = Split-Path -Parent $InfraDir

Write-Host "=== EMS Platform: Starting Local Docker Stand ===" -ForegroundColor Cyan

# 1. Verify Docker is available
try {
    docker info > $null 2>&1
} catch {
    Write-Error "Docker daemon is not running or not accessible. Please start Docker Desktop."
    exit 1
}

# 2. Check and generate certificates if missing
$CertsDir = Join-Path $InfraDir "certs"
$RequiredCerts = @("TestRootCA.crt", "ldap.crt", "ldap.key", "web.crt", "web.key")
$MissingCerts = $RequiredCerts | Where-Object { -not (Test-Path -LiteralPath (Join-Path $CertsDir $_)) }

if ($MissingCerts.Count -gt 0) {
    Write-Host "Missing certificates detected: $($MissingCerts -join ', '). Generating..." -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $CertsDir "generate-certs.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Certificate generation failed." }
}

# 3. Check .env file
$EnvFile = Join-Path $DockerDir ".env"
$EnvExample = Join-Path $DockerDir ".env.example"
if (-not (Test-Path -LiteralPath $EnvFile)) {
    Write-Host "Creating .env from .env.example..." -ForegroundColor DarkGray
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
}

# 4. Start Docker Compose
Write-Host "Starting Docker containers..." -ForegroundColor Yellow
Set-Location -LiteralPath $DockerDir

$ComposeArgs = @("compose", "up", "-d")
if (-not $NoBuild) {
    $ComposeArgs += "--build"
}
& docker @ComposeArgs
if ($LASTEXITCODE -ne 0) { throw "Docker compose up failed." }

# 5. Wait for healthy status
Write-Host "Waiting for services to report healthy status (timeout: ${TimeoutSeconds}s)..." -ForegroundColor Yellow
$StartTime = Get-Date
$Services = @("ems-postgres", "ems-samba-ad", "ems-nginx")

while ($true) {
    $Elapsed = ((Get-Date) - $StartTime).TotalSeconds
    if ($Elapsed -gt $TimeoutSeconds) {
        Write-Error "Timeout waiting for services to become healthy after $TimeoutSeconds seconds."
        & docker compose ps
        exit 1
    }

    $AllHealthy = $true
    foreach ($svc in $Services) {
        $status = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $svc 2>$null)
        if ($status -ne "healthy" -and $status -ne "running") {
            $AllHealthy = $false
            break
        }
    }

    if ($AllHealthy) {
        break
    }
    Start-Sleep -Seconds 3
}

Write-Host "=== All Services Are Up and Healthy! ===" -ForegroundColor Green
& docker compose ps

Write-Host ""
Write-Host "Connection details:" -ForegroundColor Cyan
Write-Host "  - PostgreSQL: localhost:5432 (dbs: ems_dev, ems_test)"
Write-Host "  - Samba AD LDAPS: ldaps://localhost:636 (domain: CORP.LOCAL)"
Write-Host "  - Nginx HTTPS Ingress: https://localhost (proxies to :3000)"
Write-Host ""
Write-Host "To run PostgreSQL acceptance tests:"
Write-Host "  & `"$ScriptDir\run-acceptance.ps1`"" -ForegroundColor Yellow
