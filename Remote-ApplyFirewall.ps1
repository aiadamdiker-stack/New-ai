#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Удалённое применение правил фаервола к машине 10.148.48.26 через WinRM.

.DESCRIPTION
    Запускается с любой Windows-машины в сети.
    Подключается к 10.148.48.26 и применяет все правила харденинга.

.NOTES
    Требования:
    - На 10.148.48.26 должен быть включён WinRM (Enable-PSRemoting -Force)
    - Учётная запись с правами администратора на целевой машине
    - Если машины не в домене, выполнить на ЭТОЙ машине:
      Set-Item WSMan:\localhost\Client\TrustedHosts -Value "10.148.48.26" -Force
#>

$TargetIP = "10.148.48.26"
$TrustedSubnets = @("10.148.48.0/24")

# ============================================================
# ПОДГОТОВКА
# ============================================================

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Remote Firewall Hardening: $TargetIP" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Добавить в TrustedHosts (для не-доменных машин)
Write-Host "[*] Добавление $TargetIP в TrustedHosts..." -ForegroundColor Yellow
Set-Item WSMan:\localhost\Client\TrustedHosts -Value $TargetIP -Force -ErrorAction SilentlyContinue

# Запрос учётных данных
Write-Host "[*] Введите учётные данные администратора на $TargetIP" -ForegroundColor Yellow
$Cred = Get-Credential -Message "Логин и пароль администратора на $TargetIP"

# ============================================================
# ПРОВЕРКА СВЯЗИ
# ============================================================

Write-Host ""
Write-Host "[*] Проверка доступности $TargetIP..." -ForegroundColor Yellow

if (-not (Test-Connection -ComputerName $TargetIP -Count 2 -Quiet)) {
    Write-Host "[!] Хост $TargetIP недоступен. Проверьте сеть." -ForegroundColor Red
    exit 1
}
Write-Host "[+] Хост доступен." -ForegroundColor Green

# Проверка WinRM
Write-Host "[*] Проверка WinRM..." -ForegroundColor Yellow
try {
    Test-WSMan -ComputerName $TargetIP -Credential $Cred -ErrorAction Stop | Out-Null
    Write-Host "[+] WinRM доступен." -ForegroundColor Green
} catch {
    Write-Host "[!] WinRM недоступен: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "    Для включения WinRM на целевой машине выполните локально:" -ForegroundColor White
    Write-Host '    Enable-PSRemoting -Force' -ForegroundColor White
    Write-Host '    Set-NetFirewallRule -Name "WINRM-HTTP-In-TCP" -RemoteAddress Any' -ForegroundColor White
    exit 1
}

# ============================================================
# ПРИМЕНЕНИЕ ПРАВИЛ
# ============================================================

Write-Host ""
Write-Host "[*] Подключение и применение правил..." -ForegroundColor Yellow

$Result = Invoke-Command -ComputerName $TargetIP -Credential $Cred -ScriptBlock {
    param([string[]]$TrustedSubnets)

    $RulePrefix = "Hardening-"
    $output = @{ Hostname = $env:COMPUTERNAME; Success = $true; Errors = @(); Rules = 0 }

    try {
        # Точка восстановления
        try {
            Enable-ComputerRestore -Drive "C:\" -ErrorAction SilentlyContinue
            Checkpoint-Computer -Description "Pre-Remote-Hardening" -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
        } catch { }

        # Удалить старые правила
        Get-NetFirewallRule -DisplayName "$($RulePrefix)*" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Включить фаервол
        Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True

        # --- SMB 445 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-SMB-445-Inbound" -Direction Inbound -Protocol TCP -LocalPort 445 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-SMB-445-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
            $output.Rules++
        }

        # --- NetBIOS 139 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-139-Inbound" -Direction Inbound -Protocol TCP -LocalPort 139 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-139-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 139 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
            $output.Rules++
        }

        # --- NetBIOS NS UDP 137 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-137-UDP-Inbound" -Direction Inbound -Protocol UDP -LocalPort 137 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-137-UDP-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol UDP -LocalPort 137 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
            $output.Rules++
        }

        # --- RPC 135 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-135-Inbound" -Direction Inbound -Protocol TCP -LocalPort 135 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-135-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 135 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
            $output.Rules++
        }

        # --- RPC Ephemeral 49152-65535 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-Ephemeral-Inbound" -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-Ephemeral-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
            $output.Rules++
        }

        # --- Block HTTPAPI 50131 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-HTTPAPI-50131-Inbound" -Direction Inbound -Protocol TCP -LocalPort 50131 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++

        # --- Block CDPSvc 5040 ---
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-CDPSvc-5040-Inbound" -Direction Inbound -Protocol TCP -LocalPort 5040 -Action Block -Profile Any -Enabled True | Out-Null
        $output.Rules++

        # --- Логирование ---
        $fwLog = "$env:SystemRoot\System32\LogFiles\Firewall\pfirewall.log"
        Set-NetFirewallProfile -Profile Domain,Private,Public -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $fwLog

        # --- Отключение служб ---
        foreach ($svc in @("SSDPSRV", "upnphost", "CDPSvc")) {
            try {
                Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop
                Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            } catch {
                $output.Errors += "$svc : $($_.Exception.Message)"
            }
        }

    } catch {
        $output.Success = $false
        $output.Errors += $_.Exception.Message
    }

    return $output

} -ArgumentList @(,$TrustedSubnets)

# ============================================================
# РЕЗУЛЬТАТ
# ============================================================

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Результат" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

if ($Result.Success) {
    Write-Host "[+] УСПЕШНО применено на $($Result.Hostname) ($TargetIP)" -ForegroundColor Green
    Write-Host "    Создано правил: $($Result.Rules)" -ForegroundColor White
} else {
    Write-Host "[!] ОШИБКА на $TargetIP" -ForegroundColor Red
}

if ($Result.Errors.Count -gt 0) {
    Write-Host "    Предупреждения:" -ForegroundColor Yellow
    $Result.Errors | ForEach-Object { Write-Host "      - $_" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "[*] Для проверки правил на целевой машине:" -ForegroundColor White
Write-Host '    Invoke-Command -ComputerName 10.148.48.26 -Credential $Cred -ScriptBlock { Get-NetFirewallRule -DisplayName "Hardening-*" | Format-Table DisplayName, Action, Enabled }' -ForegroundColor Gray
Write-Host ""
