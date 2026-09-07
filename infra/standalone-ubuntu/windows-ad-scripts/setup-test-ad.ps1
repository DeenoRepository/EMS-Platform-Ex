# ==============================================================================
# EMS Platform: Windows Server Active Directory Test Stand Setup Script
# Run this on the Windows Server AD Domain Controller (PowerShell Administrator)
# ==============================================================================
[CmdletBinding()]
param(
    [string]$DomainDN = "DC=corp,DC=local",
    [string]$ContainerDN = "CN=Users,DC=corp,DC=local",
    [string]$ExportCertPath = "C:\EMS\TestRootCA.crt"
)

$ErrorActionPreference = "Stop"

Write-Host "=== EMS Platform: Windows Server Active Directory Provisioning ===" -ForegroundColor Cyan

# 1. Check Active Directory module
if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) {
    Write-Error "ActiveDirectory PowerShell module is required. Please install RSAT-AD-PowerShell."
    exit 1
}
Import-Module ActiveDirectory

# 2. Verify or create container
$TargetContainer = $ContainerDN
if ($TargetContainer -like "OU=*") {
    if (-not (Get-ADOrganizationalUnit -Filter "DistinguishedName -eq '$TargetContainer'" -ErrorAction SilentlyContinue)) {
        $ouName = ($TargetContainer -split ",")[0] -replace "^OU=", ""
        $parentDN = ($TargetContainer -split ",", 2)[1]
        Write-Host "Creating Organizational Unit: $TargetContainer..." -ForegroundColor Yellow
        New-ADOrganizationalUnit -Name $ouName -Path $parentDN -ProtectedFromAccidentalDeletion $false
    }
}

# 3. Helper to create or reset synthetic users
function New-OrUpdate-SyntheticUser {
    param(
        [string]$SamAccountName,
        [string]$UserPrincipalName,
        [string]$DisplayName,
        [string]$GivenName,
        [string]$Surname,
        [string]$Password,
        [bool]$Enabled = $true
    )

    $secPass = ConvertTo-SecureString $Password -AsPlainText -Force
    $existing = Get-ADUser -Filter "SamAccountName -eq '$SamAccountName'" -ErrorAction SilentlyContinue

    if (-not $existing) {
        Write-Host "Creating user: $SamAccountName ($UserPrincipalName)..." -ForegroundColor Yellow
        New-ADUser -SamAccountName $SamAccountName `
                   -UserPrincipalName $UserPrincipalName `
                   -Name $DisplayName `
                   -DisplayName $DisplayName `
                   -GivenName $GivenName `
                   -Surname $Surname `
                   -AccountPassword $secPass `
                   -Enabled $Enabled `
                   -PasswordNeverExpires $true `
                   -Path $TargetContainer
    } else {
        Write-Host "Updating user: $SamAccountName..." -ForegroundColor DarkGray
        Set-ADUser -Identity $existing -DisplayName $DisplayName -GivenName $GivenName -Surname $Surname -Enabled $Enabled -PasswordNeverExpires $true
        Set-ADAccountPassword -Identity $existing -NewPassword $secPass -Reset $true
    }
}

# 4. Provision Synthetic Users
New-OrUpdate-SyntheticUser -SamAccountName "svc_ems_ldap" `
                           -UserPrincipalName "svc_ems_ldap@corp.local" `
                           -DisplayName "EMS LDAP Read-Only Service Account" `
                           -GivenName "Service" -Surname "LDAP" `
                           -Password "Ldap_Service_Secret123!" -Enabled $true

New-OrUpdate-SyntheticUser -SamAccountName "bootstrap-admin" `
                           -UserPrincipalName "bootstrap-admin@corp.local" `
                           -DisplayName "Администратор Платформы" `
                           -GivenName "Администратор" -Surname "Платформы" `
                           -Password "Admin_Pass_Secret123!" -Enabled $true

New-OrUpdate-SyntheticUser -SamAccountName "regular-user" `
                           -UserPrincipalName "regular-user@corp.local" `
                           -DisplayName "Иванов Иван Иванович" `
                           -GivenName "Иван" -Surname "Иванов" `
                           -Password "User_Pass_Secret123!" -Enabled $true

New-OrUpdate-SyntheticUser -SamAccountName "pending-user" `
                           -UserPrincipalName "pending-user@corp.local" `
                           -DisplayName "Петров Петр Сергеевич" `
                           -GivenName "Петр" -Surname "Петров" `
                           -Password "Pending_Pass_Secret123!" -Enabled $true

New-OrUpdate-SyntheticUser -SamAccountName "blocked-user" `
                           -UserPrincipalName "blocked-user@corp.local" `
                           -DisplayName "Сидоров Сидор Сидорович" `
                           -GivenName "Сидор" -Surname "Сидоров" `
                           -Password "Blocked_Pass_Secret123!" -Enabled $false

# 5. Provision Groups
$AdminsGroup = "CN=EMS_Admins,$TargetContainer"
if (-not (Get-ADGroup -Filter "DistinguishedName -eq '$AdminsGroup'" -ErrorAction SilentlyContinue)) {
    New-ADGroup -Name "EMS_Admins" -GroupScope Global -Path $TargetContainer -Description "Группа администраторов EMS"
}
Add-ADGroupMember -Identity "EMS_Admins" -Members "bootstrap-admin" -ErrorAction SilentlyContinue

$UsersGroup = "CN=EMS_Users,$TargetContainer"
if (-not (Get-ADGroup -Filter "DistinguishedName -eq '$UsersGroup'" -ErrorAction SilentlyContinue)) {
    New-ADGroup -Name "EMS_Users" -GroupScope Global -Path $TargetContainer -Description "Группа пользователей EMS"
}
Add-ADGroupMember -Identity "EMS_Users" -Members @("regular-user", "pending-user") -ErrorAction SilentlyContinue

# 6. Export Active Directory Root CA certificate if Enterprise CA is installed
Write-Host "Checking for Enterprise Root CA certificate..." -ForegroundColor Yellow
$caStore = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*corp.local*" -or $_.Subject -like "*EMS*" } | Select-Object -First 1

if ($caStore) {
    $certDir = Split-Path -Parent $ExportCertPath
    if (-not (Test-Path -LiteralPath $certDir)) { New-Item -ItemType Directory -Path $certDir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($ExportCertPath, $caStore.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    Write-Host "[OK] Root CA exported to $ExportCertPath" -ForegroundColor Green
} else {
    Write-Host "[INFO] Enterprise CA not found in LocalMachine\Root. Please export your AD CS CA certificate manually to $ExportCertPath." -ForegroundColor DarkGray
}

Write-Host "=== Active Directory Provisioning Complete ===" -ForegroundColor Green
