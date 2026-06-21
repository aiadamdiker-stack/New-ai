param(
    [string]$TargetIP = "10.148.48.26",
    [string[]]$TrustedSubnets = @("10.148.48.0/24")
)

Write-Host "=== Remote Firewall Hardening ===" -ForegroundColor Cyan
Write-Host "Target: $TargetIP" -ForegroundColor Cyan

Set-Item WSMan:\localhost\Client\TrustedHosts -Value $TargetIP -Force -ErrorAction SilentlyContinue

$Cred = Get-Credential -Message "Admin credentials for $TargetIP"

if (-not (Test-Connection -ComputerName $TargetIP -Count 2 -Quiet)) {
    Write-Host "Host unreachable" -ForegroundColor Red
    exit 1
}
Write-Host "Host is up" -ForegroundColor Green

try {
    Test-WSMan -ComputerName $TargetIP -Credential $Cred -ErrorAction Stop | Out-Null
    Write-Host "WinRM OK" -ForegroundColor Green
} catch {
    Write-Host "WinRM failed. Run on target: Enable-PSRemoting -Force" -ForegroundColor Red
    exit 1
}

Write-Host "Applying rules..." -ForegroundColor Yellow

$Result = Invoke-Command -ComputerName $TargetIP -Credential $Cred -ArgumentList @(,$TrustedSubnets) -ScriptBlock {
    param([string[]]$Trusted)

    $P = "Hardening-"
    $out = @{ Host = $env:COMPUTERNAME; OK = $true; Err = @(); N = 0 }

    try {
        Get-NetFirewallRule -DisplayName ($P + "*") -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True

        # SMB 445
        New-NetFirewallRule -DisplayName ($P + "Block-SMB-445") -Direction Inbound -Protocol TCP -LocalPort 445 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++
        foreach ($n in $Trusted) {
            $rn = $n -replace "/","-"
            New-NetFirewallRule -DisplayName ($P + "Allow-SMB-445-" + $rn) -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress $n -Action Allow -Profile Any -Enabled True | Out-Null
            $out.N++
        }

        # NetBIOS 139
        New-NetFirewallRule -DisplayName ($P + "Block-NetBIOS-139") -Direction Inbound -Protocol TCP -LocalPort 139 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++
        foreach ($n in $Trusted) {
            $rn = $n -replace "/","-"
            New-NetFirewallRule -DisplayName ($P + "Allow-NetBIOS-139-" + $rn) -Direction Inbound -Protocol TCP -LocalPort 139 -RemoteAddress $n -Action Allow -Profile Any -Enabled True | Out-Null
            $out.N++
        }

        # NetBIOS UDP 137
        New-NetFirewallRule -DisplayName ($P + "Block-NetBIOS-137-UDP") -Direction Inbound -Protocol UDP -LocalPort 137 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++
        foreach ($n in $Trusted) {
            $rn = $n -replace "/","-"
            New-NetFirewallRule -DisplayName ($P + "Allow-NetBIOS-137-UDP-" + $rn) -Direction Inbound -Protocol UDP -LocalPort 137 -RemoteAddress $n -Action Allow -Profile Any -Enabled True | Out-Null
            $out.N++
        }

        # RPC 135
        New-NetFirewallRule -DisplayName ($P + "Block-RPC-135") -Direction Inbound -Protocol TCP -LocalPort 135 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++
        foreach ($n in $Trusted) {
            $rn = $n -replace "/","-"
            New-NetFirewallRule -DisplayName ($P + "Allow-RPC-135-" + $rn) -Direction Inbound -Protocol TCP -LocalPort 135 -RemoteAddress $n -Action Allow -Profile Any -Enabled True | Out-Null
            $out.N++
        }

        # RPC Ephemeral
        New-NetFirewallRule -DisplayName ($P + "Block-RPC-Ephemeral") -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++
        foreach ($n in $Trusted) {
            $rn = $n -replace "/","-"
            New-NetFirewallRule -DisplayName ($P + "Allow-RPC-Ephemeral-" + $rn) -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -RemoteAddress $n -Action Allow -Profile Any -Enabled True | Out-Null
            $out.N++
        }

        # HTTPAPI 50131
        New-NetFirewallRule -DisplayName ($P + "Block-HTTPAPI-50131") -Direction Inbound -Protocol TCP -LocalPort 50131 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++

        # CDPSvc 5040
        New-NetFirewallRule -DisplayName ($P + "Block-CDPSvc-5040") -Direction Inbound -Protocol TCP -LocalPort 5040 -Action Block -Profile Any -Enabled True | Out-Null
        $out.N++

        # Logging
        $fwLog = $env:SystemRoot + "\System32\LogFiles\Firewall\pfirewall.log"
        Set-NetFirewallProfile -Profile Domain,Private,Public -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $fwLog

        # Disable services
        foreach ($svc in @("SSDPSRV", "upnphost", "CDPSvc")) {
            try {
                Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop
                Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            } catch {
                $out.Err += ($svc + ": " + $_.Exception.Message)
            }
        }
    } catch {
        $out.OK = $false
        $out.Err += $_.Exception.Message
    }

    return $out
}

Write-Host ""
if ($Result.OK) {
    Write-Host "SUCCESS on $($Result.Host) - $($Result.N) rules created" -ForegroundColor Green
} else {
    Write-Host "FAILED on $TargetIP" -ForegroundColor Red
}
if ($Result.Err.Count -gt 0) {
    Write-Host "Warnings:" -ForegroundColor Yellow
    $Result.Err | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}
