[CmdletBinding()]
param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
    [Parameter(Mandatory = $true)][string]$UpstreamUrl,
    [Parameter(Mandatory = $true)][string]$KeyFile,
    [ValidateRange(1024, 65535)][int]$Port = 18788,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Utf8File([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function New-LaunchCommand([string]$Node, [string]$Entry, [string]$Config) {
    foreach ($value in @($Node, $Entry, $Config)) {
        if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) {
            throw 'Bridge paths cannot contain quotes or newlines.'
        }
    }
    return '"' + $Node + '" "' + $Entry + '" --config "' + $Config + '"'
}

function New-Launcher([string]$Command) {
    $lines = @(
        'Option Explicit'
        'Dim shell, exitCode'
        'Set shell = CreateObject("WScript.Shell")'
        ('exitCode = shell.Run("' + $Command.Replace('"', '""') + '", 0, True)')
        'WScript.Quit exitCode'
    )
    return ($lines -join "`r`n") + "`r`n"
}

function Get-ListenerIds([int]$ListenerPort = $Port) {
    return @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $ListenerPort } |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-OwnedCommand([string]$ActualCommand, [string]$ExpectedCommand) {
    # WScript.Shell can add whitespace between arguments when launching Node.
    # Only these separators may vary; spaces inside paths must match exactly.
    $parts = [regex]::Match($ExpectedCommand, '\A"([^"]+)" "([^"]+)" --config "([^"]+)"\z')
    if (-not $parts.Success) { return $false }
    $pattern = '\A"' + [regex]::Escape($parts.Groups[1].Value) + '"[\t ]+"' +
        [regex]::Escape($parts.Groups[2].Value) + '"[\t ]+--config[\t ]+"' +
        [regex]::Escape($parts.Groups[3].Value) + '"\z'
    return [regex]::IsMatch($ActualCommand.Trim(), $pattern)
}

function Assert-OwnedProcess([int]$ProcessId, [string]$ExpectedCommand) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $process -or -not $process.CommandLine -or -not (Test-OwnedCommand $process.CommandLine $ExpectedCommand)) {
        throw 'A listening process does not belong to this bridge installation.'
    }
}

function Wait-ForStoppedBridge([string]$ExpectedCommand, [int]$ListenerPort = $Port) {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $listeners = @(Get-ListenerIds $ListenerPort)
        if ($listeners.Count -eq 0) { return }
        foreach ($listener in $listeners) { Assert-OwnedProcess $listener $ExpectedCommand }
        Start-Sleep -Milliseconds 250
    }
    # Task Scheduler normally terminates its child processes. Only the exact
    # previously recorded command may be stopped if its child remains alive.
    foreach ($listener in @(Get-ListenerIds $ListenerPort)) {
        Assert-OwnedProcess $listener $ExpectedCommand
        Stop-Process -Id $listener -ErrorAction Stop
    }
    Start-Sleep -Milliseconds 250
    if (@(Get-ListenerIds $ListenerPort).Count -ne 0) { throw 'The previous bridge did not release its port.' }
}

function Get-BridgeHealth {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/healthz")
    $request.Proxy = $null
    $request.Timeout = 1000
    $request.ReadWriteTimeout = 1000
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

$upstream = $null
if (-not [Uri]::TryCreate($UpstreamUrl, [UriKind]::Absolute, [ref]$upstream) -or
    $upstream.Scheme -notin @('http', 'https') -or $upstream.UserInfo -or
    $upstream.Query -or $upstream.Fragment -or $upstream.AbsolutePath.TrimEnd('/') -ne '/v1') {
    throw 'UpstreamUrl must be an HTTP(S) /v1 URL without credentials, a query, or a fragment.'
}
$UpstreamUrl = $upstream.AbsoluteUri.TrimEnd('/')
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$KeyFile = (Resolve-Path -LiteralPath $KeyFile -ErrorAction Stop).ProviderPath
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw 'KeyFile must be a file.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).ProviderPath
$nodeVersion = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$' -or
    [version]$nodeVersion.Substring(1) -lt [version]'22.13.0') {
    throw 'Node.js 22.13 or later is required.'
}
$repoPath = Split-Path -Parent $PSScriptRoot
$bridgePath = Join-Path $repoPath 'src\native-bridge.mjs'
if (-not (Test-Path -LiteralPath $bridgePath -PathType Leaf)) { throw 'src/native-bridge.mjs was not found.' }
$bridgeHome = Join-Path $CodexHome 'caveman-stack'
$configPath = Join-Path $bridgeHome 'native-bridge.json'
$launcherPath = Join-Path $bridgeHome 'native-bridge.vbs'
$manifestPath = Join-Path $bridgeHome 'native-bridge-install.json'
$wscriptPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskName = 'Caveman Native OpenAI Bridge'
$description = 'Managed by caveman-opencodex-stack; native OpenAI bridge; home=' + $CodexHome
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$launchCommand = New-LaunchCommand $NodePath $bridgePath $configPath
$launcher = New-Launcher $launchCommand
$existingTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
$previousCommand = $null
$previousTaskXml = $null
$previousPort = $Port

if ($existingTask) {
    $principalId = $existingTask.Principal.UserId
    if ($principalId -match '^S-1-') { $principalSid = $principalId }
    else { $principalSid = (New-Object Security.Principal.NTAccount($principalId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($existingTask.Description -cne $description -or @($existingTask.Actions).Count -ne 1 -or
        $existingTask.Actions[0].Execute -ine $wscriptPath -or
        $existingTask.Actions[0].Arguments -cne ('"' + $launcherPath + '"') -or
        $principalSid -ne $identity.User.Value) {
        throw 'A scheduled task with this name already exists and is not owned by this installer.'
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The existing bridge ownership manifest is missing.' }
    $previous = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($previous.managedBy -cne 'caveman-opencodex-stack' -or $previous.codexHome -ine $CodexHome -or
        $previous.configPath -ine $configPath -or $previous.launcherPath -ine $launcherPath) {
        throw 'The existing bridge ownership manifest does not match this installation.'
    }
    $previousCommand = New-LaunchCommand $previous.nodePath $previous.bridgePath $previous.configPath
    if ((Get-Content -LiteralPath $launcherPath -Raw) -cne (New-Launcher $previousCommand)) {
        throw 'The existing bridge launcher was modified; inspect it before replacing the task.'
    }
    $previousConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $previousPort = [int]$previousConfig.port
    if ($previousPort -lt 1024 -or $previousPort -gt 65535) { throw 'The previous bridge configuration has an invalid port.' }
    $previousTaskXml = Export-ScheduledTask -TaskName $taskName -TaskPath '\'
}

$listeners = @(Get-ListenerIds)
if ($listeners.Count -gt 0) {
    if (-not $existingTask -or $existingTask.State -ne 'Running') {
        throw "Port $Port is already occupied; no process has been stopped."
    }
    foreach ($listener in $listeners) { Assert-OwnedProcess $listener $previousCommand }
}
if ($existingTask -and $previousPort -ne $Port) {
    foreach ($listener in @(Get-ListenerIds $previousPort)) { Assert-OwnedProcess $listener $previousCommand }
}

New-Item -ItemType Directory -Path $bridgeHome -Force | Out-Null
$backupPath = Join-Path $bridgeHome ('native-bridge-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$managedFiles = @($configPath, $launcherPath, $manifestPath)
$originalFiles = @{}
foreach ($path in $managedFiles) {
    if (Test-Path -LiteralPath $path) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'An installation file path is occupied by a directory.' }
        New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
        $savedPath = Join-Path $backupPath (Split-Path -Leaf $path)
        Copy-Item -LiteralPath $path -Destination $savedPath -ErrorAction Stop
        $originalFiles[$path] = $savedPath
    }
}
if ($previousTaskXml) {
    New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
    Write-Utf8File (Join-Path $backupPath 'task.xml') $previousTaskXml
}

$taskRegistered = $false
try {
    if ($existingTask -and $existingTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
        Wait-ForStoppedBridge $previousCommand $previousPort
    }
    if (@(Get-ListenerIds).Count -ne 0) { throw 'The requested bridge port is not available.' }
    $nextConfig = [ordered]@{ upstreamUrl = $UpstreamUrl; keyFile = $KeyFile; port = $Port }
    if (Test-Path -LiteralPath $configPath) {
        $stored = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        foreach ($field in @('compression', 'management', 'controlPort')) {
            if ($stored.PSObject.Properties.Name -contains $field) { $nextConfig[$field] = $stored.$field }
        }
    }
    Write-Utf8File $configPath (($nextConfig | ConvertTo-Json -Depth 5) + "`n")
    Write-Utf8File $launcherPath $launcher
    Write-Utf8File $manifestPath (([ordered]@{
        version = 1; managedBy = 'caveman-opencodex-stack'; codexHome = $CodexHome
        nodePath = $NodePath; bridgePath = $bridgePath; configPath = $configPath; launcherPath = $launcherPath
    } | ConvertTo-Json) + "`n")
    $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('"' + $launcherPath + '"') -WorkingDirectory $repoPath
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description $description -Force | Out-Null
    $taskRegistered = $true
    $startedAt = Get-Date
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    $healthy = $false
    $healthTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($healthTimer.Elapsed.TotalSeconds -lt 30) {
        try {
            $health = Get-BridgeHealth
            if ($health.service -ceq 'caveman-native-bridge' -and $health.upstreamUrl -ceq $UpstreamUrl -and $health.ok -eq $true) {
                Assert-OwnedProcess ([int]$health.pid) $launchCommand
                $healthy = $true
                break
            }
        } catch { }
        $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
        $state = (Get-ScheduledTask -TaskName $taskName -TaskPath '\').State
        if ($state -ne 'Running' -and $info.LastRunTime -ge $startedAt.AddSeconds(-1) -and
            $info.LastTaskResult -notin @(0, 267009, 267011)) {
            throw ('The bridge task exited before becoming healthy (result 0x{0:X8}).' -f $info.LastTaskResult)
        }
        Start-Sleep -Milliseconds 500
    }
    $healthTimer.Stop()
    if (-not $healthy) { throw 'The bridge did not become healthy within 30 seconds.' }
} catch {
    $installationError = $_
    try {
        if ($taskRegistered) {
            Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
            Wait-ForStoppedBridge $launchCommand
        }
        foreach ($path in $managedFiles) {
            if ($originalFiles.ContainsKey($path)) {
                Copy-Item -LiteralPath $originalFiles[$path] -Destination $path -Force
            } elseif (Test-Path -LiteralPath $path -PathType Leaf) {
                Remove-Item -LiteralPath $path -Force
            }
        }
        if ($previousTaskXml) {
            Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Xml $previousTaskXml -Force | Out-Null
            if ($existingTask.State -eq 'Running') { Start-ScheduledTask -TaskName $taskName -TaskPath '\' }
        } elseif ($taskRegistered) {
            Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        }
    } catch { Write-Warning 'Automatic restoration was incomplete. Inspect the bridge task and saved installation backup.' }
    throw $installationError
}

[ordered]@{
    ok = $true; task = $taskName; bridgeUrl = "http://127.0.0.1:$Port/v1"; upstreamUrl = $UpstreamUrl
    configPath = $configPath; backupPath = $(if (Test-Path -LiteralPath $backupPath) { $backupPath } else { $null })
} | ConvertTo-Json
