#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Windows Firewall Hardening Script based on Nmap Security Assessment
    Target Host: 10.148.48.26 (Windows 11 24H2-25H2)

.DESCRIPTION
    This script implements the security recommendations from the Nmap scan analysis:
    1. Restricts SMB/NetBIOS access to trusted networks only
    2. Restricts RPC access to trusted networks only
    3. Blocks unnecessary services (HTTPAPI/UPnP on port 50131, CDPSvc on port 5040)
    4. Enables logging for dropped packets

.NOTES
    - MUST be run as Administrator
    - Review and adjust $TrustedSubnets before execution
    - Test in a non-production environment first
    - A system restore point is created before changes are applied

.PARAMETER TrustedSubnets
    Array of trusted subnets in CIDR notation that should retain access to restricted services.
#>

# ============================================================
# CONFIGURATION - ADJUST THESE VALUES BEFORE RUNNING
# ============================================================

# Define trusted subnets that should be allowed to access SMB/RPC services.
# Replace these with the actual trusted network ranges.
$TrustedSubnets = @(
    "10.148.48.0/24"       # Local subnet (adjust as needed)
    # "192.168.1.0/24"     # Add additional trusted subnets here
)

# ============================================================
# SAFETY: CREATE SYSTEM RESTORE POINT
# ============================================================

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Windows Firewall Hardening Script" -ForegroundColor Cyan
Write-Host " Based on Nmap Security Assessment" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[*] Creating system restore point..." -ForegroundColor Yellow
try {
    Enable-ComputerRestore -Drive "C:\" -ErrorAction SilentlyContinue
    Checkpoint-Computer -Description "Pre-Firewall-Hardening" -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
    Write-Host "[+] Restore point created successfully." -ForegroundColor Green
} catch {
    Write-Host "[!] Could not create restore point: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "[!] Continuing without restore point..." -ForegroundColor Red
}

# ============================================================
# ENSURE WINDOWS FIREWALL IS ENABLED ON ALL PROFILES
# ============================================================

Write-Host ""
Write-Host "[*] Ensuring Windows Firewall is enabled on all profiles..." -ForegroundColor Yellow

Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True
Write-Host "[+] Firewall enabled on Domain, Private, and Public profiles." -ForegroundColor Green

# ============================================================
# SECTION 1: RESTRICT SMB AND NETBIOS (PORTS 139, 445)
# ============================================================

Write-Host ""
Write-Host "[*] Configuring SMB/NetBIOS restrictions..." -ForegroundColor Yellow

# Remove any existing rules created by this script (idempotent)
$RulePrefix = "Hardening-"
Get-NetFirewallRule -DisplayName "$($RulePrefix)*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue

# Block SMB (445) from all sources
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-SMB-445-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 445 `
    -Action Block `
    -Profile Any `
    -Description "Block all inbound SMB traffic on port 445 (baseline deny)" `
    -Enabled True | Out-Null

# Allow SMB (445) from trusted subnets only
foreach ($subnet in $TrustedSubnets) {
    New-NetFirewallRule `
        -DisplayName "${RulePrefix}Allow-SMB-445-From-$($subnet -replace '[/]','-')" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 445 `
        -RemoteAddress $subnet `
        -Action Allow `
        -Profile Any `
        -Description "Allow inbound SMB from trusted subnet $subnet" `
        -Enabled True | Out-Null
}

# Block NetBIOS (139) from all sources
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-NetBIOS-139-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 139 `
    -Action Block `
    -Profile Any `
    -Description "Block all inbound NetBIOS-SSN traffic on port 139 (baseline deny)" `
    -Enabled True | Out-Null

# Allow NetBIOS (139) from trusted subnets only
foreach ($subnet in $TrustedSubnets) {
    New-NetFirewallRule `
        -DisplayName "${RulePrefix}Allow-NetBIOS-139-From-$($subnet -replace '[/]','-')" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 139 `
        -RemoteAddress $subnet `
        -Action Allow `
        -Profile Any `
        -Description "Allow inbound NetBIOS from trusted subnet $subnet" `
        -Enabled True | Out-Null
}

# Block NetBIOS Name Service UDP 137
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-NetBIOS-137-UDP-Inbound" `
    -Direction Inbound `
    -Protocol UDP `
    -LocalPort 137 `
    -Action Block `
    -Profile Any `
    -Description "Block all inbound NetBIOS Name Service UDP 137" `
    -Enabled True | Out-Null

foreach ($subnet in $TrustedSubnets) {
    New-NetFirewallRule `
        -DisplayName "${RulePrefix}Allow-NetBIOS-137-UDP-From-$($subnet -replace '[/]','-')" `
        -Direction Inbound `
        -Protocol UDP `
        -LocalPort 137 `
        -RemoteAddress $subnet `
        -Action Allow `
        -Profile Any `
        -Description "Allow inbound NetBIOS NS from trusted subnet $subnet" `
        -Enabled True | Out-Null
}

Write-Host "[+] SMB/NetBIOS rules configured (restricted to trusted subnets)." -ForegroundColor Green

# ============================================================
# SECTION 2: RESTRICT RPC (PORT 135 AND EPHEMERAL RANGE)
# ============================================================

Write-Host ""
Write-Host "[*] Configuring RPC restrictions..." -ForegroundColor Yellow

# Block RPC Endpoint Mapper (135) from all sources
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-RPC-135-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 135 `
    -Action Block `
    -Profile Any `
    -Description "Block all inbound RPC Endpoint Mapper traffic on port 135" `
    -Enabled True | Out-Null

# Allow RPC (135) from trusted subnets only
foreach ($subnet in $TrustedSubnets) {
    New-NetFirewallRule `
        -DisplayName "${RulePrefix}Allow-RPC-135-From-$($subnet -replace '[/]','-')" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 135 `
        -RemoteAddress $subnet `
        -Action Allow `
        -Profile Any `
        -Description "Allow inbound RPC from trusted subnet $subnet" `
        -Enabled True | Out-Null
}

# Block RPC Dynamic/Ephemeral ports (49152-65535) from untrusted sources
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-RPC-Ephemeral-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 49152-65535 `
    -Action Block `
    -Profile Any `
    -Description "Block all inbound RPC ephemeral port traffic (49152-65535)" `
    -Enabled True | Out-Null

# Allow RPC ephemeral ports from trusted subnets only
foreach ($subnet in $TrustedSubnets) {
    New-NetFirewallRule `
        -DisplayName "${RulePrefix}Allow-RPC-Ephemeral-From-$($subnet -replace '[/]','-')" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 49152-65535 `
        -RemoteAddress $subnet `
        -Action Allow `
        -Profile Any `
        -Description "Allow inbound RPC ephemeral from trusted subnet $subnet" `
        -Enabled True | Out-Null
}

Write-Host "[+] RPC rules configured (restricted to trusted subnets)." -ForegroundColor Green

# ============================================================
# SECTION 3: BLOCK UNNECESSARY SERVICES
# ============================================================

Write-Host ""
Write-Host "[*] Blocking unnecessary exposed services..." -ForegroundColor Yellow

# Block HTTPAPI / UPnP on port 50131
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-HTTPAPI-50131-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 50131 `
    -Action Block `
    -Profile Any `
    -Description "Block inbound HTTPAPI/UPnP traffic on port 50131" `
    -Enabled True | Out-Null

Write-Host "[+] Port 50131 (HTTPAPI/UPnP) blocked." -ForegroundColor Green

# Block CDPSvc on port 5040
New-NetFirewallRule `
    -DisplayName "${RulePrefix}Block-CDPSvc-5040-Inbound" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 5040 `
    -Action Block `
    -Profile Any `
    -Description "Block inbound traffic on port 5040 (Connected Devices Platform)" `
    -Enabled True | Out-Null

Write-Host "[+] Port 5040 (CDPSvc) blocked." -ForegroundColor Green

# ============================================================
# SECTION 4: ENABLE FIREWALL LOGGING
# ============================================================

Write-Host ""
Write-Host "[*] Enabling firewall logging for dropped packets..." -ForegroundColor Yellow

$LogPath = "$env:SystemRoot\System32\LogFiles\Firewall\pfirewall.log"

Set-NetFirewallProfile -Profile Domain -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $LogPath
Set-NetFirewallProfile -Profile Private -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $LogPath
Set-NetFirewallProfile -Profile Public -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $LogPath

Write-Host "[+] Firewall logging enabled (log: $LogPath)." -ForegroundColor Green

# ============================================================
# SECTION 5: DISABLE UNNECESSARY SERVICES (OPTIONAL)
# ============================================================

Write-Host ""
Write-Host "[*] Disabling unnecessary services (optional)..." -ForegroundColor Yellow

# Disable SSDP Discovery Service (UPnP)
try {
    Set-Service -Name "SSDPSRV" -StartupType Disabled -ErrorAction Stop
    Stop-Service -Name "SSDPSRV" -Force -ErrorAction SilentlyContinue
    Write-Host "[+] SSDP Discovery Service disabled." -ForegroundColor Green
} catch {
    Write-Host "[!] Could not disable SSDP Discovery: $($_.Exception.Message)" -ForegroundColor Red
}

# Disable UPnP Device Host
try {
    Set-Service -Name "upnphost" -StartupType Disabled -ErrorAction Stop
    Stop-Service -Name "upnphost" -Force -ErrorAction SilentlyContinue
    Write-Host "[+] UPnP Device Host service disabled." -ForegroundColor Green
} catch {
    Write-Host "[!] Could not disable UPnP Device Host: $($_.Exception.Message)" -ForegroundColor Red
}

# Disable Connected Devices Platform Service
try {
    Set-Service -Name "CDPSvc" -StartupType Disabled -ErrorAction Stop
    Stop-Service -Name "CDPSvc" -Force -ErrorAction SilentlyContinue
    Write-Host "[+] Connected Devices Platform Service disabled." -ForegroundColor Green
} catch {
    Write-Host "[!] Could not disable CDPSvc: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Hardening Complete" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "[*] Summary of changes:" -ForegroundColor Yellow
Write-Host "    - SMB (139/445) restricted to trusted subnets" -ForegroundColor White
Write-Host "    - RPC (135, 49152-65535) restricted to trusted subnets" -ForegroundColor White
Write-Host "    - HTTPAPI/UPnP (50131) blocked" -ForegroundColor White
Write-Host "    - CDPSvc (5040) blocked" -ForegroundColor White
Write-Host "    - Firewall logging enabled for blocked traffic" -ForegroundColor White
Write-Host "    - SSDP, UPnP Host, and CDPSvc services disabled" -ForegroundColor White
Write-Host ""
Write-Host "[!] IMPORTANT: Review the TrustedSubnets variable at the top of this script" -ForegroundColor Red
Write-Host "    and adjust it to match the actual trusted network ranges." -ForegroundColor Red
Write-Host ""
Write-Host "[*] To verify rules, run:" -ForegroundColor Yellow
Write-Host '    Get-NetFirewallRule -DisplayName "Hardening-*" | Format-Table DisplayName, Direction, Action, Enabled' -ForegroundColor White
Write-Host ""
