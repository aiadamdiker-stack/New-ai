#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Автоматическое применение правил фаервола к новым Windows-машинам в подсети 10.148.48.0/24.

.DESCRIPTION
    Скрипт работает как фоновый монитор:
    1. Каждые N секунд сканирует подсеть на наличие новых хостов
    2. Проверяет доступность WinRM
    3. Применяет правила фаервола к ранее не обработанным машинам
    4. Ведёт лог и реестр обработанных хостов

    Может быть зарегистрирован как запланированная задача (Scheduled Task) для постоянной работы.

.PARAMETER Subnet
    Первые 3 октета подсети. По умолчанию: "10.148.48"

.PARAMETER ScanInterval
    Интервал сканирования в секундах. По умолчанию: 300 (5 минут)

.PARAMETER TrustedSubnets
    Массив доверенных подсетей в CIDR. По умолчанию: "10.148.48.0/24"

.PARAMETER StateFile
    Путь к файлу состояния (реестр обработанных хостов). По умолчанию: рядом со скриптом.

.PARAMETER LogFile
    Путь к лог-файлу. По умолчанию: рядом со скриптом.

.PARAMETER RunOnce
    Если указан — выполнить один проход и завершить (для тестирования).

.EXAMPLE
    # Запуск в режиме мониторинга (бесконечный цикл):
    .\Auto-DeployFirewall.ps1

    # Один проход (для теста):
    .\Auto-DeployFirewall.ps1 -RunOnce

    # Регистрация как Scheduled Task:
    .\Auto-DeployFirewall.ps1 -InstallTask
#>

[CmdletBinding()]
param(
    [string]$Subnet = "10.148.48",
    [int]$ScanInterval = 300,
    [string[]]$TrustedSubnets = @("10.148.48.0/24"),
    [string]$StateFile = "$PSScriptRoot\processed_hosts.json",
    [string]$LogFile = "$PSScriptRoot\auto-deploy-firewall.log",
    [switch]$RunOnce,
    [switch]$InstallTask,
    [PSCredential]$Credential
)

# ============================================================
# ФУНКЦИИ
# ============================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $entry = "[$ts] [$Level] $Message"
    switch ($Level) {
        "SUCCESS" { Write-Host $entry -ForegroundColor Green }
        "WARNING" { Write-Host $entry -ForegroundColor Yellow }
        "ERROR"   { Write-Host $entry -ForegroundColor Red }
        default   { Write-Host $entry }
    }
    $entry | Out-File -FilePath $LogFile -Append -Encoding UTF8
}

function Get-ProcessedHosts {
    if (Test-Path $StateFile) {
        return (Get-Content $StateFile -Raw | ConvertFrom-Json)
    }
    return @()
}

function Save-ProcessedHost {
    param([string]$IP, [string]$Hostname, [string]$Status)
    $hosts = @(Get-ProcessedHosts)
    $record = [PSCustomObject]@{
        IP        = $IP
        Hostname  = $Hostname
        Status    = $Status
        Timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    }
    $hosts += $record
    $hosts | ConvertTo-Json -Depth 3 | Set-Content $StateFile -Encoding UTF8
}

function Test-IsProcessed {
    param([string]$IP)
    $hosts = @(Get-ProcessedHosts)
    return ($hosts | Where-Object { $_.IP -eq $IP -and $_.Status -eq "SUCCESS" })
}

# ============================================================
# БЛОК ПРАВИЛ (применяется удалённо)
# ============================================================

$FirewallRulesBlock = {
    param([string[]]$TrustedSubnets)

    $RulePrefix = "Hardening-"
    $result = @{ Hostname = $env:COMPUTERNAME; Success = $true; Errors = @() }

    try {
        # Удалить старые правила этого скрипта
        Get-NetFirewallRule -DisplayName "$($RulePrefix)*" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue

        # Включить фаервол
        Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True

        # SMB 445
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-SMB-445-Inbound" -Direction Inbound -Protocol TCP -LocalPort 445 -Action Block -Profile Any -Enabled True | Out-Null
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-SMB-445-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 445 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # NetBIOS 139
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-139-Inbound" -Direction Inbound -Protocol TCP -LocalPort 139 -Action Block -Profile Any -Enabled True | Out-Null
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-139-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 139 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # NetBIOS NS UDP 137
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-NetBIOS-137-UDP-Inbound" -Direction Inbound -Protocol UDP -LocalPort 137 -Action Block -Profile Any -Enabled True | Out-Null
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-NetBIOS-137-UDP-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol UDP -LocalPort 137 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # RPC 135
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-135-Inbound" -Direction Inbound -Protocol TCP -LocalPort 135 -Action Block -Profile Any -Enabled True | Out-Null
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-135-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 135 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # RPC Ephemeral 49152-65535
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-RPC-Ephemeral-Inbound" -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -Action Block -Profile Any -Enabled True | Out-Null
        foreach ($net in $TrustedSubnets) {
            New-NetFirewallRule -DisplayName "${RulePrefix}Allow-RPC-Ephemeral-From-$($net -replace '[/]','-')" -Direction Inbound -Protocol TCP -LocalPort 49152-65535 -RemoteAddress $net -Action Allow -Profile Any -Enabled True | Out-Null
        }

        # Block HTTPAPI 50131
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-HTTPAPI-50131-Inbound" -Direction Inbound -Protocol TCP -LocalPort 50131 -Action Block -Profile Any -Enabled True | Out-Null

        # Block CDPSvc 5040
        New-NetFirewallRule -DisplayName "${RulePrefix}Block-CDPSvc-5040-Inbound" -Direction Inbound -Protocol TCP -LocalPort 5040 -Action Block -Profile Any -Enabled True | Out-Null

        # Логирование
        $fwLog = "$env:SystemRoot\System32\LogFiles\Firewall\pfirewall.log"
        Set-NetFirewallProfile -Profile Domain,Private,Public -LogBlocked True -LogMaxSizeKilobytes 16384 -LogFileName $fwLog

        # Отключить лишние службы
        foreach ($svc in @("SSDPSRV", "upnphost", "CDPSvc")) {
            try {
                Set-Service -Name $svc -StartupType Disabled -ErrorAction Stop
                Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            } catch {
                $result.Errors += "Service $svc : $($_.Exception.Message)"
            }
        }
    } catch {
        $result.Success = $false
        $result.Errors += $_.Exception.Message
    }

    return $result
}

# ============================================================
# УСТАНОВКА КАК SCHEDULED TASK
# ============================================================

if ($InstallTask) {
    Write-Log "Регистрация запланированной задачи..."

    $taskName = "AutoDeployFirewallHardening"
    $scriptPath = $MyInvocation.MyCommand.Path

    # Удалить старую задачу если есть
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""

    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 5) -RestartCount 3

    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description "Auto-deploy firewall hardening to new hosts in subnet"

    Write-Log "Задача '$taskName' зарегистрирована. Запуск при старте системы." -Level "SUCCESS"
    Write-Log "Для ручного запуска: Start-ScheduledTask -TaskName '$taskName'"
    exit 0
}

# ============================================================
# ОСНОВНОЙ ЦИКЛ
# ============================================================

Write-Log "=========================================="
Write-Log " Auto-Deploy Firewall Monitor"
Write-Log " Подсеть: $Subnet.0/24"
Write-Log " Интервал: $ScanInterval сек"
Write-Log "=========================================="

do {
    Write-Log ""
    Write-Log "Сканирование подсети..."

    $localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "$Subnet.*" }).IPAddress

    $jobs = 1..254 | ForEach-Object {
        $ip = "$Subnet.$_"
        [PSCustomObject]@{
            IP    = $ip
            Alive = (Test-Connection -ComputerName $ip -Count 1 -Quiet -TimeoutSeconds 1)
        }
    }

    $aliveHosts = $jobs | Where-Object { $_.Alive -and $_.IP -ne $localIP }

    Write-Log "Найдено живых хостов (кроме локального): $($aliveHosts.Count)"

    foreach ($host_entry in $aliveHosts) {
        $ip = $host_entry.IP

        # Пропустить уже обработанные
        if (Test-IsProcessed -IP $ip) {
            Write-Log "  $ip — уже обработан, пропуск."
            continue
        }

        Write-Log "  $ip — новый хост, проверка WinRM..."

        # Проверка WinRM
        $wsmanOk = $false
        try {
            $wsmanParams = @{ ComputerName = $ip; ErrorAction = "Stop" }
            if ($Credential) { $wsmanParams.Credential = $Credential }
            Test-WSMan @wsmanParams | Out-Null
            $wsmanOk = $true
        } catch {
            $wsmanOk = $false
        }

        if (-not $wsmanOk) {
            Write-Log "  $ip — WinRM недоступен (не Windows или WinRM выключен), пропуск." -Level "WARNING"
            continue
        }

        # Применение правил
        Write-Log "  $ip — применение правил фаервола..."

        try {
            $invokeParams = @{
                ComputerName = $ip
                ScriptBlock  = $FirewallRulesBlock
                ArgumentList = @(,$TrustedSubnets)
                ErrorAction  = "Stop"
            }
            if ($Credential) { $invokeParams.Credential = $Credential }

            $result = Invoke-Command @invokeParams

            if ($result.Success) {
                Write-Log "  $ip ($($result.Hostname)) — УСПЕШНО" -Level "SUCCESS"
                Save-ProcessedHost -IP $ip -Hostname $result.Hostname -Status "SUCCESS"
            } else {
                Write-Log "  $ip ($($result.Hostname)) — ЧАСТИЧНО: $($result.Errors -join '; ')" -Level "WARNING"
                Save-ProcessedHost -IP $ip -Hostname $result.Hostname -Status "PARTIAL"
            }
        } catch {
            Write-Log "  $ip — ОШИБКА: $($_.Exception.Message)" -Level "ERROR"
            Save-ProcessedHost -IP $ip -Hostname "N/A" -Status "FAILED"
        }
    }

    if (-not $RunOnce) {
        Write-Log "Следующее сканирование через $ScanInterval сек..."
        Start-Sleep -Seconds $ScanInterval
    }

} while (-not $RunOnce)

Write-Log ""
Write-Log "Завершено."
