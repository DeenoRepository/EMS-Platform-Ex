# PowerShell script to generate Test Root CA, LDAP and Web TLS certificates for EMS Platform
[CmdletBinding()]
param(
    [string]$OpenSslPath = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $ScriptDir

Write-Host "=== EMS Platform: Generation of Test CA and Certificates ===" -ForegroundColor Cyan

# Resolve OpenSSL executable
$OpenSslCmd = $null
if ($OpenSslPath -and (Test-Path -LiteralPath $OpenSslPath)) {
    $OpenSslCmd = $OpenSslPath
} else {
    $cmd = Get-Command "openssl" -ErrorAction SilentlyContinue
    if ($cmd) {
        $OpenSslCmd = $cmd.Source
    } else {
        $candidates = @(
            "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe",
            "$env:ProgramFiles\Git\usr\bin\openssl.exe",
            "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
            "C:\Program Files\Git\usr\bin\openssl.exe",
            "C:\OpenSSL-Win64\bin\openssl.exe"
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate) {
                $OpenSslCmd = $candidate
                break
            }
        }
    }
}

if (-not $OpenSslCmd) {
    Write-Error "OpenSSL binary not found. Please specify -OpenSslPath or install OpenSSL/Git for Windows."
    exit 1
}

Write-Host "Using OpenSSL: $OpenSslCmd" -ForegroundColor DarkGray

$ConfigFile = Join-Path $ScriptDir "openssl.cnf"
if (-not (Test-Path -LiteralPath $ConfigFile)) {
    Write-Error "Configuration file '$ConfigFile' not found."
    exit 1
}

$DaysCA = 3650
$DaysCert = 1095

# 1. Root CA
Write-Host "1. Generating Test Root CA (valid for $DaysCA days)..." -ForegroundColor Yellow
& $OpenSslCmd req -x509 -new -nodes -sha256 `
    -newkey rsa:4096 `
    -keyout "TestRootCA.key" `
    -out "TestRootCA.crt" `
    -days $DaysCA `
    -config $ConfigFile `
    -extensions v3_ca `
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Security/CN=EMS Test Root CA"
if ($LASTEXITCODE -ne 0) { throw "Failed to generate Root CA" }

# 2. LDAP Certificate
Write-Host "2. Generating LDAP Server certificate (valid for $DaysCert days)..." -ForegroundColor Yellow
& $OpenSslCmd req -new -nodes -sha256 `
    -newkey rsa:2048 `
    -keyout "ldap.key" `
    -out "ldap.csr" `
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Directory/CN=ldap.corp.local"
if ($LASTEXITCODE -ne 0) { throw "Failed to generate LDAP CSR" }

& $OpenSslCmd x509 -req -sha256 `
    -in "ldap.csr" `
    -CA "TestRootCA.crt" `
    -CAkey "TestRootCA.key" `
    -CAcreateserial `
    -out "ldap.crt" `
    -days $DaysCert `
    -extfile $ConfigFile `
    -extensions ldap_ext
if ($LASTEXITCODE -ne 0) { throw "Failed to sign LDAP certificate" }

# 3. Web / Ingress Certificate
Write-Host "3. Generating Web Server certificate (valid for $DaysCert days)..." -ForegroundColor Yellow
& $OpenSslCmd req -new -nodes -sha256 `
    -newkey rsa:2048 `
    -keyout "web.key" `
    -out "web.csr" `
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Web/CN=ems.local"
if ($LASTEXITCODE -ne 0) { throw "Failed to generate Web CSR" }

& $OpenSslCmd x509 -req -sha256 `
    -in "web.csr" `
    -CA "TestRootCA.crt" `
    -CAkey "TestRootCA.key" `
    -CAcreateserial `
    -out "web.crt" `
    -days $DaysCert `
    -extfile $ConfigFile `
    -extensions web_ext
if ($LASTEXITCODE -ne 0) { throw "Failed to sign Web certificate" }

# Clean up temporary files
Remove-Item -LiteralPath "ldap.csr" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "web.csr" -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "TestRootCA.srl" -Force -ErrorAction SilentlyContinue

Write-Host "=== Certificate Generation Complete ===" -ForegroundColor Green
Write-Host "Artifacts generated in: $ScriptDir"
Write-Host "  - TestRootCA.crt, TestRootCA.key (Root CA)"
Write-Host "  - ldap.crt, ldap.key             (Samba 4 / AD LDAPS)"
Write-Host "  - web.crt, web.key               (Nginx HTTPS Ingress)"
Write-Host ""
Write-Host "To use in Node.js applications with LDAPS (PowerShell):"
Write-Host "  `$env:NODE_EXTRA_CA_CERTS = `"$ScriptDir\TestRootCA.crt`"" -ForegroundColor Cyan
