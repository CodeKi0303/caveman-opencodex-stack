param()
$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'Manage.cmd'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Caveman Manager.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $launcher)) {
    throw 'A different shortcut already uses this name. Check it before continuing.'
}
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = 'Pod connection, catalog, updates and service management'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll')+',15'
$shortcut.Save()
Write-Output $shortcutPath
