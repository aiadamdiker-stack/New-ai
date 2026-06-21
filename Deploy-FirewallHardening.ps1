#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Deploys firewall hardening rules to all Windows machines in 10.148.48.0/24 via PowerShell Remoting (WinRM).

.DESCRIPTION
    1. Scans the subnet for live hosts (ICMP ping)
    2. Tests WinRM connectivity on each live host
    3. Applies firewall rules remotely via Invoke-Command
    4. Generates a summary report

.NOTES
    Prerequisites:
    - WinRM must be enabled on target machines (Enable-PSRemoting -Force)
    - The executing account must have admin rights on all targets
    - Run from a domain-joined machine or provide credentials via -Credential

.PARAMETER Subnet
    Target subnet in "10.148.48" format (first 3 octets). Default: "10.148.48"

.PARAMETER Credential
    PSCredential object for authentication. If omitted, uses current user context.

.PARAMETER TrustedSubnets
    Array of trusted subnets in CIDR notation. Default: "10.148.48.0/24"

.PARAMETER LogPath
    Path for the deployment log. Default: .\Deploy-FirewallHardening.log
#>

[CmdletBinding()]
param(
    [string]$Subnet = "10.148.48",

    [PSCredential]$Credential,

    [string[]]$TrustedSubnets = @("10.148.48.0/24"),

    [string]$LogPath = ".\Deploy-FirewallHardening.log"
)

# ============================================================
# LOGGING
# ============================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$timestamp] [$Level] $Message"
    Write-Host $entry -ForegroundColor $(switch ($Level) {
        "INFO"    { "White" }
        "SUCCESS" { "Green" }
        "WARNING" { "Yellow" }
        "ERROR"   { "Red" }
        default   { "White" }
    })
    $entry | Out-File -FilePath $LogPath -Append -Encoding UTF8
}

# ============================================================
# FIREWALL RULES SCRIPTBLOCK (applied remotely)
# ============================================================

$HardeningScriptBlock = {
    param([string[]]$TrustedSubnets)

    $RulePrefix = "Hardening-"
    $results = @{
        Hostname = $env:COMPUTERNAME
        Success  = $true
        Errors   = @()
    }

    try {
        # Remove existing hardening rules (idempotent)
        Get-NetFirewallRule -DisplayName "$($RulePrefix)*" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Ensure firewall is enabled
        Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True

        # --- SMB (445) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-SMB-445-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 445 `
            -Action Block -Profile Any -Enabled True | Out-Null

        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-SMB-445-From-$($net -replace '[/]','-')" `
                -Direction Inbound -Protocol TCP -LocalPort 445 `
                -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # --- NetBIOS (139) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-139-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 139 `
            -Action Block -Profile Any -Enabled True | Out-Null

        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-139-From-$($net -replace '[/]','-')" `
                -Direction Inbound -Protocol TCP -LocalPort 139 `
                -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # --- NetBIOS NS UDP (137) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-137-UDP-Inbound" `
            -Direction Inbound -Protocol UDP -LocalPort 137 `
            -Action Block -Profile Any -Enabled True | Out-Null

        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-137-UDP-From-$($net -replace '[/]','-')" `
                -Direction Inbound -Protocol UDP -LocalPort 137 `
                -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # --- RPC Endpoint Mapper (135) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-135-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 135 `
            -Action Block -Profile Any -Enabled True | Out-Null

        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-135-From-$($net -replace '[/]','-')" `
                -Direction Inbound -Protocol TCP -LocalPort 135 `
                -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # --- RPC Ephemeral Ports (49152-65535) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-Ephemeral-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 49152-65535 `
            -Action Block -Profile Any -Enabled True | Out-Null

        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-Ephemeral-From-$($net -replace '[/]','-')" `
                -Direction Inbound -Protocol TCP -LocalPort 49152-65535 `
                -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # --- Block HTTPAPI/UPnP (50131) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-HTTPAPI-50131-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 50131 `
            -Action Block -Profile Any -Enabled True | Out-Null

        # --- Block CDPSvc (5040) ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-CDPSvc-5040-Inbound" `
            -Direction Inbound -Protocol TCP -LocalPort 5040 `
            -Action Block -Profile Any -Enabled True | Out-Null

        # --- Enable logging ---
        $fwLog = "$env:SystemRoot\System32\LogFiles\Firewall\pfirewall.log"
        Set-NetFirewallProfile -Profile Domain,Private,Public `
            -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $fwLog

        # --- Disable unnecessary services ---
        foreach ($svc in @("SSDPSRV", "upnphost", "CDPSvc")) {
            try {
                Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop
                Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            } catch {
                $results.Errors += "Service $svc : $($_.Exception.Message)"
            }
        }

    } catch {
        $results.Success = $false
        $results.Errors += $_.Exception.Message
    }

    return $results
}

# ============================================================
# MAIN EXECUTION
# ============================================================

Write-Log "=========================================="
Write-Log " Firewall Hardening Deployment"
Write-Log " Subnet: $Subnet.0/24"
Write-Log "=========================================="
Write-Log ""

# Step 1: Discover live hosts
Write-Log "Scanning subnet for live Windows hosts..."

$LiveHosts = @()
1..254 | ForEach-Object {
    $ip = "$Subnet.$_"
    if (Test-Connection -ComputerName $ip -Count 1 -Quiet -TimeoutSeconds 1) {
        $LiveHosts += $ip
    }
}

Write-Log "Found $($LiveHosts.Count) live host(s): $($LiveHosts -join ', ')" -Level "INFO"

if ($LiveHosts.Count -eq 0) {
    Write-Log "No live hosts found. Exiting." -Level "WARNING"
    exit 0
}

# Step 2: Test WinRM and deploy
$Report = @()

foreach ($host_ip in $LiveHosts) {
    Write-Log ""
    Write-Log "--- Processing: $host_ip ---"

    # Test WinRM connectivity
    $winrmParams = @{ ComputerName = $host_ip; Quiet = $true }
    if ($Credential) { $winrmParams.Credential = $Credential }

    $winrmOk = Test-WSMan @winrmParams -ErrorAction SilentlyContinue
    if (-not $winrmOk) {
        Write-Log "WinRM not available on $host_ip — skipping (not Windows or WinRM disabled)" -Level "WARNING"
        $Report += [PSCustomObject]@{
            IP       = $host_ip
            Hostname = "N/A"
            Status   = "SKIPPED"
            Reason   = "WinRM unavailable"
        }
        continue
    }

    # Deploy rules
    Write-Log "WinRM OK. Deploying firewall rules..."

    $invokeParams = @{
        ComputerName = $host_ip
        ScriptBlock  = $HardeningScriptBlock
        ArgumentList = @(,$TrustedSubnets)
        ErrorAction  = "Stop"
    }
    if ($Credential) { $invokeParams.Credential = $Credential }

    try {
        $result = Invoke-Command @invokeParams

        if ($result.Success) {
            Write-Log "SUCCESS on $($result.Hostname) ($host_ip)" -Level "SUCCESS"
            $status = "SUCCESS"
        } else {
            Write-Log "PARTIAL on $($result.Hostname) ($host_ip): $($result.Errors -join '; ')" -Level "WARNING"
            $status = "PARTIAL"
        }

        $Report += [PSCustomObject]@{
            IP       = $host_ip
            Hostname = $result.Hostname
            Status   = $status
            Reason   = ($result.Errors -join "; ")
        }
    } catch {
        Write-Log "FAILED on $host_ip : $($_.Exception.Message)" -Level "ERROR"
        $Report += [PSCustomObject]@{
            IP       = $host_ip
            Hostname = "N/A"
            Status   = "FAILED"
            Reason   = $_.Exception.Message
        }
    }
}

# Step 3: Summary
Write-Log ""
Write-Log "=========================================="
Write-Log " Deployment Summary"
Write-Log "=========================================="

$Report | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Log $_ }

$successCount = ($Report | Where-Object { $_.Status -eq "SUCCESS" }).Count
$failCount    = ($Report | Where-Object { $_.Status -eq "FAILED" }).Count
$skipCount    = ($Report | Where-Object { $_.Status -eq "SKIPPED" }).Count

Write-Log "Total: $($Report.Count) | Success: $successCount | Failed: $failCount | Skipped: $skipCount"
Write-Log "Log saved to: $LogPath"
Write-Log ""

# Export report to CSV
$csvPath = ".\Deploy-FirewallHardening-Report.csv"
$Report | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
Write-Log "Report exported to: $csvPath"
