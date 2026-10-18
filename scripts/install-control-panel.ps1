[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$configPath = Join-Path $CodexHome 'caveman-stack\native-bridge.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Install the native bridge first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = 18786
if ($config.PSObject.Properties.Name -contains 'controlPort') { $port = [int]$config.controlPort }
if ($port -lt 1024 -or $port -gt 65535 -or $port -eq $config.port) { throw 'Invalid control port.' }
if (-not $NodePath) { $NodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source }
$NodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
$entry = Join-Path $PSScriptRoot 'control-panel.mjs'
$launcher = Join-Path $CodexHome 'caveman-stack\control-panel.vbs'
$taskName = 'Caveman Local Control Panel'
$description = 'Managed by caveman-opencodex-stack; control panel; home=' + $CodexHome
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$command = '"' + $NodePath + '" "' + $entry + '" --config "' + $configPath + '"'
foreach ($value in @($NodePath, $entry, $configPath)) {
  if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Invalid path.' }
}
$vbs = "Option Explicit`r`nDim shell, code`r`nSet shell = CreateObject(""WScript.Shell"")`r`ncode = shell.Run(""" + $command.Replace('"','""') + """, 0, True)`r`nWScript.Quit code`r`n"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$previousXml = $null
$previousLauncher = $null
if ($existing) {
  if ($existing.Description -cne $description -or @($existing.Actions).Count -ne 1 -or $existing.Actions[0].Execute -ine $wscript -or $existing.Actions[0].Arguments -cne ('"' + $launcher + '"')) { throw 'Unowned task exists.' }
  $principalId = $existing.Principal.UserId
  if ($principalId -match '^S-1-') { $principalSid=$principalId }
  else { $principalSid=(New-Object Security.Principal.NTAccount($principalId)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($principalSid -ne $identity.User.Value) { throw 'Task belongs to another user.' }
  if ([IO.File]::ReadAllText($launcher) -cne $vbs) { throw 'Existing launcher differs; inspect it before replacing.' }
  $previousXml = Export-ScheduledTask -TaskName $taskName
  $previousLauncher = [IO.File]::ReadAllBytes($launcher)
}
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $port)
foreach ($listener in $listeners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  $pattern='\A"'+[regex]::Escape($NodePath)+'"[\t ]+"'+[regex]::Escape($entry)+'"[\t ]+--config[\t ]+"'+[regex]::Escape($configPath)+'"\z'
  if (-not $existing -or $existing.State -ne 'Running' -or -not [regex]::IsMatch($process.CommandLine.Trim(),$pattern)) { throw 'Control port is occupied by an unowned process.' }
}
$registered = $false
try {
  if ($existing) { Stop-ScheduledTask -TaskName $taskName; Start-Sleep -Milliseconds 700 }
  foreach ($listener in $listeners) { if (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue) { Stop-Process -Id $listener.OwningProcess } }
  [IO.File]::WriteAllText($launcher,$vbs,(New-Object Text.UTF8Encoding($false)))
  $action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $launcher + '"') -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description -Force | Out-Null
  $registered = $true
  Start-ScheduledTask -TaskName $taskName
  $ready = $false
  for ($i=0; $i -lt 20; $i++) {
    try { $response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2; if ($response.StatusCode -eq 200 -and $response.Content.Contains('control-token')) { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'Control panel did not become ready.' }
  $shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Caveman Control.url'
  [IO.File]::WriteAllText($shortcut,"[InternetShortcut]`r`nURL=http://127.0.0.1:$port/`r`n",(New-Object Text.UTF8Encoding($false)))
  [ordered]@{ok=$true;url="http://127.0.0.1:$port/";shortcut=$shortcut} | ConvertTo-Json
} catch {
  if ($registered) { Stop-ScheduledTask -TaskName $taskName }
  if ($previousLauncher) { [IO.File]::WriteAllBytes($launcher,$previousLauncher) }
  if ($previousXml) { Register-ScheduledTask -TaskName $taskName -Xml $previousXml -Force | Out-Null; if ($existing.State -eq 'Running') { Start-ScheduledTask -TaskName $taskName } }
  elseif ($registered) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Remove-Item -LiteralPath $launcher -Force }
  throw
}
