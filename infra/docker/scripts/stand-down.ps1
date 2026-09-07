# PowerShell script to stop and tear down EMS Platform Local Docker Stand
[CmdletBinding()]
param(
    [switch]$KeepVolumes
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DockerDir = Split-Path -Parent $ScriptDir

Write-Host "=== EMS Platform: Stopping Local Docker Stand ===" -ForegroundColor Cyan
Set-Location -LiteralPath $DockerDir

$ArgsList = @("compose", "down")
if (-not $KeepVolumes) {
    Write-Host "Removing volumes for clean state..." -ForegroundColor Yellow
    $ArgsList += "-v"
} else {
    Write-Host "Preserving data volumes (-KeepVolumes specified)..." -ForegroundColor DarkGray
}

& docker @ArgsList
if ($LASTEXITCODE -ne 0) { throw "Docker compose down failed." }

Write-Host "=== Docker Stand Successfully Stopped ===" -ForegroundColor Green
